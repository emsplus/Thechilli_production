from datetime import timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.common import Page, get_or_404, paged, parse_uuid, to_dict
from app.api.tenants import resolve_tenant
from app.core import errors
from app.core.config import settings
from app.core.db import get_db
from app.core.deps import Principal, require
from app.models import (BusinessProfile, Invoice, InvoiceLine, PaymentTransaction, Plan, Subscription, invoice_seq, utcnow)
from app.services import entitlements as ent
from app.services.audit import audit
from app.services.gst import compute_gst

router = APIRouter(tags=["billing"])


class LineIn(BaseModel):
    description: str = Field(min_length=1, max_length=300)
    quantity: int = Field(1, ge=1, le=100000)
    unit_price_paise: int = Field(ge=0)


class InvoiceIn(BaseModel):
    tenant: str
    lines: list[LineIn] | None = None  # omitted: one line from the tenant's live subscription plan
    discount_paise: int = Field(0, ge=0)


class VoidIn(BaseModel):
    reason: str = Field(min_length=3)


def invoice_view(db: Session, inv: Invoice) -> dict:
    lines = db.scalars(select(InvoiceLine).where(InvoiceLine.invoice_id == inv.id).order_by(InvoiceLine.id)).all()
    return {**to_dict(inv), "lines": [to_dict(l) for l in lines],
            "tax_notice": "GST rate/SAC/numbering come from configuration and must be verified by a Chartered Accountant."
            if inv.tax_needs_ca_verification else None}


@router.post("/invoices", status_code=201)
def create_invoice(body: InvoiceIn, p: Principal = Depends(require("invoices.manage", staff_only=True)), db: Session = Depends(get_db)):
    t = resolve_tenant(db, body.tenant)
    prof = db.get(BusinessProfile, t.id)
    if prof is None or not prof.state_code:
        raise errors.conflict("Tenant business profile needs a state_code (place of supply) before invoicing", "buyer_state_missing")
    sub = ent.live_subscription(db, t.id)
    lines = body.lines
    if lines is None:
        if sub is None:
            raise errors.conflict("No live subscription to invoice; pass explicit lines", "no_subscription")
        plan = db.get(Plan, sub.plan_id)
        lines = [LineIn(description=f"{plan.name} plan ({sub.current_period_start:%d %b %Y} - {sub.current_period_end:%d %b %Y})",
                        quantity=1, unit_price_paise=plan.price_paise)]
    if not lines:
        raise errors.bad("Invoice needs at least one line")
    subtotal = sum(l.quantity * l.unit_price_paise for l in lines)
    if body.discount_paise > subtotal:
        raise errors.bad("Discount exceeds subtotal")
    g = compute_gst(subtotal - body.discount_paise, settings.gst_rate_bps, settings.seller_state_code, prof.state_code)
    inv = Invoice(tenant_id=t.id, subscription_id=sub.id if sub and body.lines is None else None, status="draft",
                  period_start=sub.current_period_start if sub and body.lines is None else None,
                  period_end=sub.current_period_end if sub and body.lines is None else None,
                  subtotal_paise=subtotal, discount_paise=body.discount_paise, taxable_paise=g.taxable_paise,
                  gst_rate_bps=settings.gst_rate_bps, cgst_paise=g.cgst_paise, sgst_paise=g.sgst_paise, igst_paise=g.igst_paise,
                  total_paise=g.total_paise, supplier_gstin=settings.seller_gstin or None,
                  supplier_state_code=settings.seller_state_code, buyer_gstin=prof.gstin, buyer_state_code=prof.state_code,
                  sac_code=settings.gst_sac_code, tax_needs_ca_verification=True)
    db.add(inv)
    db.flush()
    for l in lines:
        db.add(InvoiceLine(invoice_id=inv.id, description=l.description, quantity=l.quantity,
                           unit_price_paise=l.unit_price_paise, amount_paise=l.quantity * l.unit_price_paise))
    db.flush()
    audit(db, p, "invoice.created", "invoice", inv.id, t.id, after=to_dict(inv))
    return invoice_view(db, inv)


@router.get("/invoices")
def list_invoices(page: Page = Depends(), tenant: str | None = None, status: str | None = None,
                  _: Principal = Depends(require("invoices.read", staff_only=True)), db: Session = Depends(get_db)):
    stmt = select(Invoice)
    if tenant:
        stmt = stmt.where(Invoice.tenant_id == resolve_tenant(db, tenant).id)
    if status:
        stmt = stmt.where(Invoice.status == status)
    return paged(db, stmt, page, Invoice, Invoice.created_at.desc())


@router.get("/invoices/{inv_id}")
def get_invoice(inv_id: str, _: Principal = Depends(require("invoices.read", staff_only=True)), db: Session = Depends(get_db)):
    return invoice_view(db, get_or_404(db, Invoice, parse_uuid(inv_id), "Invoice"))


@router.post("/invoices/{inv_id}/issue")
def issue_invoice(inv_id: str, p: Principal = Depends(require("invoices.manage", staff_only=True)), db: Session = Depends(get_db)):
    inv = db.scalar(select(Invoice).where(Invoice.id == parse_uuid(inv_id)).with_for_update())
    if inv is None:
        raise errors.not_found("Invoice not found")
    if inv.status != "draft":
        raise errors.conflict(f"Invoice is {inv.status}", "bad_transition")
    now = utcnow()
    inv.number = f"CH-{now.year}-{db.scalar(invoice_seq.next_value()):06d}"  # numbering scheme: CA to confirm
    inv.status, inv.issued_at, inv.due_at = "issued", now, now + timedelta(days=settings.invoice_due_days)
    audit(db, p, "invoice.issued", "invoice", inv.id, inv.tenant_id, after={"number": inv.number, "total_paise": inv.total_paise})
    return invoice_view(db, inv)


@router.post("/invoices/{inv_id}/void")
def void_invoice(inv_id: str, body: VoidIn, p: Principal = Depends(require("invoices.manage", staff_only=True, step_up=True)),
                 db: Session = Depends(get_db)):
    inv = db.scalar(select(Invoice).where(Invoice.id == parse_uuid(inv_id)).with_for_update())
    if inv is None:
        raise errors.not_found("Invoice not found")
    if inv.status not in ("draft", "issued"):
        raise errors.conflict(f"Cannot void a {inv.status} invoice", "bad_transition")
    if _paid_sum(db, inv.id) > 0:
        raise errors.conflict("Invoice has successful payments; refund them first", "has_payments")
    inv.status, inv.void_reason = "void", body.reason
    audit(db, p, "invoice.voided", "invoice", inv.id, inv.tenant_id, meta={"reason": body.reason, "number": inv.number})
    return invoice_view(db, inv)


# ---------- payments ----------
class PaymentIn(BaseModel):
    tenant: str
    invoice_id: str | None = None
    provider: str = Field(min_length=2, max_length=32)
    provider_ref: str = Field(min_length=1, max_length=100)
    amount_paise: int = Field(gt=0)
    method: str | None = None
    status: str = Field("initiated", pattern="^(initiated|succeeded|failed)$")
    raw: dict | None = None


class PaymentStatusIn(BaseModel):
    status: str = Field(pattern="^(succeeded|failed|refunded)$")


ALLOWED = {"initiated": {"succeeded", "failed"}, "succeeded": {"refunded"}, "failed": set(), "refunded": set()}


def _paid_sum(db, invoice_id) -> int:
    return db.scalar(select(func.coalesce(func.sum(PaymentTransaction.amount_paise), 0)).where(
        PaymentTransaction.invoice_id == invoice_id, PaymentTransaction.status == "succeeded"))


def _settle(db: Session, inv: Invoice | None):
    if inv is None:
        return
    paid = _paid_sum(db, inv.id)
    if inv.status == "issued" and paid >= inv.total_paise:
        inv.status, inv.paid_at = "paid", utcnow()
        sub = db.get(Subscription, inv.subscription_id) if inv.subscription_id else None
        if sub and sub.status == "past_due":
            from app.models import Tenant
            ent.tracked_change(db, db.get(Tenant, inv.tenant_id), "payment_received", "system", f"invoice {inv.number}",
                               lambda: setattr(sub, "status", "active"))
    elif inv.status == "paid" and paid < inv.total_paise:
        inv.status, inv.paid_at = "issued", None


def _check_capacity(db, inv: Invoice, new_amount: int):
    if inv.status not in ("issued", "paid"):
        raise errors.conflict(f"Invoice is {inv.status}; payments need an issued invoice", "invoice_not_payable")
    if _paid_sum(db, inv.id) + new_amount > inv.total_paise:
        raise errors.conflict("Payment would exceed invoice total", "overpayment")


@router.post("/payments", status_code=201)
def record_payment(body: PaymentIn, p: Principal = Depends(require("payments.manage", staff_only=True, step_up=True)), db: Session = Depends(get_db)):
    t = resolve_tenant(db, body.tenant)
    inv = None
    if body.invoice_id:
        inv = db.scalar(select(Invoice).where(Invoice.id == parse_uuid(body.invoice_id, "invoice")).with_for_update())
        if inv is None or inv.tenant_id != t.id:
            raise errors.not_found("Invoice not found for this tenant")
        if body.status != "failed":
            _check_capacity(db, inv, body.amount_paise if body.status == "succeeded" else 0)
    if db.scalar(select(PaymentTransaction.id).where(PaymentTransaction.provider == body.provider,
                                                     PaymentTransaction.provider_ref == body.provider_ref)):
        raise errors.conflict("Payment with this provider reference already recorded", "duplicate_payment")
    pay = PaymentTransaction(tenant_id=t.id, invoice_id=inv.id if inv else None, provider=body.provider,
                             provider_ref=body.provider_ref, amount_paise=body.amount_paise, method=body.method,
                             status=body.status, raw=body.raw)
    db.add(pay)
    db.flush()
    _settle(db, inv)
    audit(db, p, "payment.recorded", "payment", pay.id, t.id, after=to_dict(pay, {"raw"}))
    return to_dict(pay)


@router.post("/payments/{pay_id}/status")
def set_payment_status(pay_id: str, body: PaymentStatusIn, p: Principal = Depends(require("payments.manage", staff_only=True, step_up=True)),
                       db: Session = Depends(get_db)):
    pay = db.scalar(select(PaymentTransaction).where(PaymentTransaction.id == parse_uuid(pay_id)).with_for_update())
    if pay is None:
        raise errors.not_found("Payment not found")
    if body.status not in ALLOWED[pay.status]:
        raise errors.conflict(f"Cannot move payment from {pay.status} to {body.status}", "bad_transition")
    inv = db.scalar(select(Invoice).where(Invoice.id == pay.invoice_id).with_for_update()) if pay.invoice_id else None
    if inv and body.status == "succeeded":
        _check_capacity(db, inv, pay.amount_paise)
    before = pay.status
    pay.status = body.status
    db.flush()
    _settle(db, inv)
    audit(db, p, "payment.status_changed", "payment", pay.id, pay.tenant_id, before={"status": before}, after={"status": pay.status})
    return to_dict(pay)


@router.get("/payments")
def list_payments(page: Page = Depends(), tenant: str | None = None, invoice_id: str | None = None,
                  _: Principal = Depends(require("payments.read", staff_only=True)), db: Session = Depends(get_db)):
    stmt = select(PaymentTransaction)
    if tenant:
        stmt = stmt.where(PaymentTransaction.tenant_id == resolve_tenant(db, tenant).id)
    if invoice_id:
        stmt = stmt.where(PaymentTransaction.invoice_id == parse_uuid(invoice_id))
    return paged(db, stmt, page, PaymentTransaction, PaymentTransaction.created_at.desc(), {"raw"})


IntegrityError  # noqa
