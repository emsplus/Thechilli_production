import time
import uuid
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.orm import Session

from app.api.deps import current_principal, P, Principal, require_perm
from app.core.db import get_db
from app.models.core import Bill, Restaurant
from fastapi import Query
from app.schemas.amend import AmendIn, AmendOptionsOut, AmendOut, AmendPreviewIn, AmendRefundOut, CreditNoteOut
from app.schemas.void import RefundDueOut, VoidCreditNoteOut, VoidIn, VoidOut
from app.schemas.common import BillDiscountIn, BillOut, BillPreviewOut, BillRequestIn, PaymentIn, PaymentOut, RefundIn, RefundOut
from app.core.config import settings
from app.services import amend as amend_svc, audit, billing as svc, outlets, receipt_links, reports, staff_pin, void as void_svc
from app.services.receipt import render_receipt

router = APIRouter(tags=["billing"])
tax_codes = {"standard": 0, "zero": 1}


def _out(db: Session, b: Bill) -> BillOut:
    return amend_svc.decorate(db, [b])[0]


def _load(db: Session, p: Principal, bill_id: uuid.UUID) -> Bill:
    b = db.get(Bill, bill_id)
    if not b or b.restaurant_id != p.restaurant_id or not outlets.visible(p, b):
        raise HTTPException(404, "Bill not found")
    return b


@router.post("/orders/{order_id}/bill", response_model=BillOut, status_code=201)
def finalize(order_id: uuid.UUID, response: Response, data: BillRequestIn | None = Body(default=None),
             p: Principal = Depends(require_perm(P.BILLS_FINALIZE)), db: Session = Depends(get_db)):
    """Finalizes the bill. Optional body `{discount?: {type, value, reason}, service_charge?: bool}` (no body = no
    discount, service charge applied when configured and the order is eat-in, automatic offers applied when one matches;
    `apply_offers: false` bills without them). Idempotent: one bill per order. Order rules (docs/ORDER_RULES.md): 409
    kitchen_ticket_required (dine-in items not sent to the kitchen; `skip_kitchen_reason` for bills.skip_kitchen), 409
    bill_already_exists (a different discount than the existing bill; `replace_existing` corrects an unpaid one).
    Chilli wallet (docs/CHILLI_WALLET.md): an order that is already open can ALWAYS be billed, whatever the balance (the
    5 Chilli are debited afterwards through the usage outbox); only creating a NEW order is refused (402 chilli_empty)."""
    data = data or BillRequestIn()
    return _out(db, svc.finalize_bill(db, p, order_id, data.discount, data.service_charge, data.apply_offers,
                                      data.skip_kitchen_reason, data.replace_existing, data.replace_reason, step_up=True))


@router.post("/orders/{order_id}/bill-preview", response_model=BillPreviewOut)
def bill_preview(order_id: uuid.UUID, data: BillRequestIn | None = Body(default=None),
                 p: Principal = Depends(require_perm(P.BILLS_FINALIZE)), db: Session = Depends(get_db)):
    """The exact numbers `POST /orders/{id}/bill` would produce right now, without persisting anything."""
    data = data or BillRequestIn()
    return svc.preview_bill(db, p, order_id, data.discount, data.service_charge, data.apply_offers, step_up=True)


@router.post("/bills/{bill_id}/discount-preview", response_model=BillPreviewOut)
def bill_discount_preview(bill_id: uuid.UUID, data: BillDiscountIn, p: Principal = Depends(require_perm(P.BILLS_DISCOUNT)),
                          db: Session = Depends(get_db)):
    """The exact bill an OPEN bill (made, nothing paid) would become with this discount (`discount: null` = none): GST
    recomputed per rate on the discounted value, CGST/SGST, round-off, total. Nothing is persisted."""
    return svc.preview_open_bill_discount(db, p, bill_id, data.discount, data.service_charge)


@router.post("/bills/{bill_id}/discount", response_model=BillOut)
def bill_discount(bill_id: uuid.UUID, data: BillDiscountIn, p: Principal = Depends(require_perm(P.BILLS_DISCOUNT)),
                  db: Session = Depends(get_db)):
    """Add, change or remove the discount of a bill that is still OPEN (made, nothing paid yet). The issued invoice is never
    edited: it gets a credit note and a replacement invoice (new number), both audited. Needs bills.discount; the cashier
    cap (and a step-up above it when required) applies. Idempotent. 409 bill_has_payment once any payment is booked: then
    only the manager's correction (POST /bills/{id}/amend) or a refund can change the money. The response is the bill that
    stands now (`id` differs from the one asked for after a change)."""
    return _out(db, svc.apply_open_bill_discount(db, p, bill_id, data.discount, data.service_charge, data.reason, step_up=True))


@router.get("/bills", response_model=list[BillOut])
def list_bills(include_superseded: bool = Query(False), outlet_id: uuid.UUID | None = None,
               p: Principal = Depends(require_perm(P.BILLS_RECEIPT, P.REPORTS_VIEW)), db: Session = Depends(get_db)):
    """Newest sale first, of the request's outlet (or `outlet_id`). Corrected (superseded) originals are listed only with
    ?include_superseded=true."""
    q = select(Bill).where(Bill.restaurant_id == p.restaurant_id,
                           Bill.outlet_id.in_(outlets.scope(p, outlet_id, all_by_default=False)))
    if not include_superseded:
        q = q.where(Bill.status.in_(("active", "voided")))
    # lines / payments / refunds in three queries for the page, not three per bill (BREAK_BACKEND_REPORT.md P1: 606 statements)
    q = q.options(selectinload(Bill.lines), selectinload(Bill.payments), selectinload(Bill.refunds))
    return amend_svc.decorate(db, list(db.scalars(q.order_by(Bill.sale_at.desc(), Bill.finalized_at.desc()).limit(200))))


@router.get("/bills/{bill_id}", response_model=BillOut)
def get_bill(bill_id: uuid.UUID, p: Principal = Depends(require_perm(P.BILLS_RECEIPT, P.REPORTS_VIEW)), db: Session = Depends(get_db)):
    return _out(db, _load(db, p, bill_id))


@router.get("/bills/{bill_id}/amend-options", response_model=AmendOptionsOut)
def amend_options(bill_id: uuid.UUID, p: Principal = Depends(require_perm(P.BILLS_AMEND)), db: Session = Depends(get_db)):
    """Owner / manager. Can this bill be corrected (credit note + replacement invoice) right now, and if not why."""
    return amend_svc.options(db, p, bill_id)


@router.post("/bills/{bill_id}/amend-preview")
def amend_preview(bill_id: uuid.UUID, data: AmendPreviewIn, p: Principal = Depends(require_perm(P.BILLS_AMEND)),
                  db: Session = Depends(get_db)):
    """The exact replacement invoice a correction would create (server prices, tax as at the sale date) plus the
    money difference and stock impact. Nothing is persisted. 409 when the bill cannot be corrected."""
    return reports.to_json(amend_svc.preview(db, p, bill_id, data))


@router.post("/bills/{bill_id}/amend", response_model=AmendOut, status_code=201)
def amend(bill_id: uuid.UUID, data: AmendIn, response: Response, p: Principal = Depends(require_perm(P.BILLS_AMEND)),
          db: Session = Depends(get_db)):
    """Correct a finalized bill: credit note for the original + replacement invoice with the original sale date.
    201 on creation; 200 with the same result when the idempotency_key was already used."""
    repl, cn, created = amend_svc.amend(db, p, bill_id, data)
    if not created:
        response.status_code = 200
    orig = db.get(Bill, cn.bill_id)
    return AmendOut(
        replacement=_out(db, repl),
        credit_note=CreditNoteOut(id=cn.id, credit_note_number=cn.credit_note_number, bill_id=orig.id,
                                  invoice_number=orig.invoice_number, amount=cn.amount, tax_amount=cn.tax_amount,
                                  reason=cn.reason, replacement_bill_id=repl.id,
                                  replacement_invoice_number=repl.invoice_number),
        refund=AmendRefundOut(amount=cn.payout_amount, method=cn.payout_method, credit_note_number=cn.credit_note_number)
        if cn.payout_amount > 0 else None)


@router.post("/bills/{bill_id}/void", response_model=VoidOut, status_code=201)
def void_bill(bill_id: uuid.UUID, data: VoidIn, response: Response, idempotency_key: uuid.UUID | None = Header(default=None),
              p: Principal = Depends(require_perm(P.BILLS_VOID)), db: Session = Depends(get_db)):
    """Owner / manager: reverse a whole finalized bill with a full credit note (no replacement invoice). The Idempotency-Key
    header (or `idempotency_key` in the body) is required. 201 on creation; 200 with the same result on a replay. Money
    already paid is NOT sent back by any gateway: `refund_due` says what must be handed back by hand."""
    key = idempotency_key or data.idempotency_key
    if key is None:
        raise HTTPException(422, "This request is missing its repeat-safety key. Update the app and try again.")
    staff_pin.require_step_up(p, "void a bill")  # STEP_UP_REQUIRED on: X-Step-Up-Token (docs/STAFF_PIN_DEVICES_API.md)
    bill, cn, created = void_svc.void_bill(db, p, bill_id, data.reason, key)
    if not created:
        response.status_code = 200
    return VoidOut(
        bill=_out(db, bill),
        credit_note=VoidCreditNoteOut(id=cn.id, credit_note_number=cn.credit_note_number, amount=cn.amount,
                                      tax_amount=cn.tax_amount, reason=cn.reason),
        refund_due=RefundDueOut(
            amount=cn.payout_amount, by_method=void_svc.refund_due_by_method(db, cn),
            note="Hand this back to the customer manually; no gateway refund was made." if cn.payout_amount > 0
            else "Nothing was paid on this bill: nothing to return."))


@router.post("/bills/{bill_id}/payments", response_model=PaymentOut, status_code=201)
def pay(bill_id: uuid.UUID, data: PaymentIn, p: Principal = Depends(require_perm(P.PAYMENTS_RECORD)),
        db: Session = Depends(get_db)):
    return svc.add_payment(db, p, bill_id, data.idempotency_key, data.method, data.amount)


@router.post("/bills/{bill_id}/refunds", response_model=RefundOut, status_code=201)
def refund(bill_id: uuid.UUID, data: RefundIn, p: Principal = Depends(require_perm(P.REFUNDS_CREATE)),
           db: Session = Depends(get_db)):
    return svc.add_refund(db, p, bill_id, data.idempotency_key, data.amount, data.reason)


@router.get("/bills/{bill_id}/receipt.pdf")
def receipt(bill_id: uuid.UUID, size: Literal["thermal", "a5"] = "thermal",
            p: Principal = Depends(require_perm(P.BILLS_RECEIPT)), db: Session = Depends(get_db)):
    b = _load(db, p, bill_id)
    pdf = render_receipt(b, db.get(Restaurant, b.restaurant_id).timezone, size, db)
    audit.record(db, p, "receipt.download", "bill", b.id, {"size": size})  # reprint: no new sale
    db.commit()
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{b.invoice_number}.pdf"'})


_HOST_RE = r"[A-Za-z0-9.\-]+(:\d{1,5})?|\[[0-9A-Fa-f:]+\](:\d{1,5})?"


def _public_base(request: Request) -> str:
    """PUBLIC_BASE_URL if configured; otherwise this request's own scheme+Host (never X-Forwarded-*)."""
    import re
    if settings.public_base_url:
        return settings.public_base_url.rstrip("/")
    host = request.headers.get("host", "")
    if not re.fullmatch(_HOST_RE, host):
        host = urlsplit(str(request.base_url)).netloc
    return f"{request.url.scheme}://{host}"


@router.post("/bills/{bill_id}/share-link")
def share_link(bill_id: uuid.UUID, request: Request, p: Principal = Depends(require_perm(P.BILLS_RECEIPT)),
               db: Session = Depends(get_db)):
    b = _load(db, p, bill_id)
    exp = int(time.time()) + settings.receipt_link_days * 86400
    token = receipt_links.make_token(b.id, b.restaurant_id, exp, b.receipt_link_gen or 0)
    audit.record(db, p, "bill.share_link", "bill", b.id, {"expires": exp})
    db.commit()
    return {"url": f"{_public_base(request)}/api/v1/public/receipts/{token}.pdf",
            "expires_at": datetime.fromtimestamp(exp, timezone.utc).isoformat(),
            "filename": f"{b.invoice_number}.pdf"}


@router.post("/bills/{bill_id}/share-link/revoke", status_code=204)
def revoke_share_links(bill_id: uuid.UUID, p: Principal = Depends(require_perm(P.BILLS_RECEIPT)),
                       db: Session = Depends(get_db)):
    """Every public link to this bill's receipt (shared, WhatsApped) stops working at once; a new share-link still works.
    Security review finding 9 (receipts carry customer name / phone)."""
    b = _load(db, p, bill_id)
    b.receipt_link_gen = (b.receipt_link_gen or 0) + 1
    audit.record(db, p, "bill.share_link_revoke", "bill", b.id)
    db.commit()
    return Response(status_code=204)


@router.get("/billing/tax-rate")
def current_tax_rate(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Kept for old clients: the STANDARD rate. Prefer /billing/tax-config."""
    from datetime import datetime, timezone
    r = db.get(Restaurant, p.restaurant_id)
    rule = svc.applicable_tax(db, r, datetime.now(timezone.utc))
    return {"name": rule.name, "rate_percent": rule.rate_percent, "currency": r.currency}


@router.get("/billing/tax-config")
def tax_config(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Everything a client needs to ESTIMATE a bill offline. The server recomputes at finalization."""
    from datetime import datetime, timezone
    from app.services.localisation import EAT_IN_ORDER_TYPES
    r = db.get(Restaurant, p.restaurant_id)
    rates = svc.applicable_rates(db, r, datetime.now(timezone.utc))
    ordered = sorted(rates.values(), key=lambda x: (tax_codes.get(x.code, 9), x.code))
    return reports.to_json({
        "country": r.country, "currency": r.currency, "currency_symbol": r.currency_symbol,
        "timezone": r.timezone, "prices_include_tax": r.prices_include_tax, "vat_registered": r.vat_registered,
        "tax_number_label": r.tax_number_label,
        "service_charge_percent": r.service_charge_percent,
        "max_cashier_discount_percent": r.max_cashier_discount_percent,
        "rates": [{"code": x.code, "name": x.name, "rate_percent": x.rate_percent} for x in ordered],
        # Every line of a GST-registered seller is 'standard' whatever the order type or the item's tax_kind label. The
        # key `not_vat_registered` keeps its name for API compatibility (it means: not GST registered).
        "rules": {"eat_in": "all standard",
                  "takeaway": {"hot_food": "standard", "cold_food": "standard", "standard": "standard"},
                  "eat_in_order_types": list(EAT_IN_ORDER_TYPES),
                  "service_charge": "eat-in orders only; on the post-discount item total; standard rated",
                  "not_vat_registered": "no tax charged; tax code 'none'; document titled BILL (also when no GSTIN is set)"},
    })
