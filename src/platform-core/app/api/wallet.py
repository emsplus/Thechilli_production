"""PAYG wallet API (docs/PAYG_BILLING.md).

* `/billing/tenants/{t}/...`: service principals (pos-service, scopes billing.read / billing.usage.write / billing.topup), which
  serve the restaurant owner's own-tenant view; staff with wallet.read may read them too.
* `/billing/outbox/...`: the mail module (scope billing.outbox) claims and acknowledges `billing.notice` events.
* `/billing/webhooks/razorpay`: PUBLIC; HMAC-verified; credits a Chilli recharge once per payment (docs/CHILLI_WALLET.md).
* `/admin/...`: platform staff (wallet.read, wallet.adjust, billing_settings.manage, tenants.suspend), all audited.
"""
import hashlib
import hmac
import json
from types import SimpleNamespace
from datetime import date, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import Page, paged, parse_uuid, to_dict
from app.api.tenants import resolve_tenant
from app.core import errors
from app.core.config import settings
from app.core.db import get_db
from app.core.deps import Principal, authenticate, require
from app.models import BillingOutbox, Plan, Tenant, TopupOrder, Wallet, WalletLedger, WalletReceipt, utcnow
from app.services import wallet as svc
from app.services.audit import audit, security_event
from app.services.csvsafe import to_csv

router = APIRouter(tags=["wallet"])


def service_only(scope: str):
    """Dependency: a service principal holding `scope` (staff tokens are refused)."""
    def dep(request: Request, db: Session = Depends(get_db)) -> Principal:
        p = authenticate(request, db)
        if p is None:
            raise errors.unauthorized()
        if p.kind != "service" or scope not in p.scopes:
            security_event(db, "permission_denied", "warn", email=p.label, ip=p.ip, details={"needed": scope, "path": request.url.path})
            db.commit()
            raise errors.forbidden()
        return p
    return dep


# ------------------------------------------------------------------ shared views
def _ledger_page(db: Session, tenant: Tenant, page: Page, d_from: date | None, d_to: date | None, kind: str | None) -> dict:
    tz = ZoneInfo(settings.billing_timezone)
    stmt = select(WalletLedger).where(WalletLedger.tenant_id == tenant.id)
    if d_from:
        stmt = stmt.where(WalletLedger.at >= datetime.combine(d_from, time.min, tz))
    if d_to:
        stmt = stmt.where(WalletLedger.at < datetime.combine(d_to + timedelta(days=1), time.min, tz))
    if kind:
        stmt = stmt.where(WalletLedger.kind == kind)
    return paged(db, stmt, page, WalletLedger, [WalletLedger.id.desc()], {"idem_key"})


def _usage(db: Session, tenant: Tenant, month: str, fmt: str):
    st = svc.statement(db, tenant, month)
    if fmt != "csv":
        return st
    start, end = svc.month_bounds(month)
    rows = db.scalars(select(WalletLedger).where(WalletLedger.tenant_id == tenant.id, WalletLedger.at >= start,
                                                 WalletLedger.at < end).order_by(WalletLedger.id)).all()
    tz = ZoneInfo(settings.billing_timezone)
    body = [["", "opening_balance", "", "", "", st["opening_balance_paise"]]]
    body += [[r.at.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S"), r.kind, r.ref_id or "", (r.meta or {}).get("invoice_number") or r.reason or "",
              r.amount_paise, r.balance_after_paise] for r in rows]
    body.append(["", "closing_balance", "", "", "", st["closing_balance_paise"]])
    csv = to_csv(["at", "kind", "reference", "detail", "amount_paise", "balance_after_paise"], body)
    return Response(csv, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="chilli-usage-{tenant.slug}-{month}.csv"'})


def _receipt_view(r: WalletReceipt) -> dict:
    return {**to_dict(r), "title": "Receipt for prepaid platform credit",
            "tax_notice": "GST fields are placeholders computed from configuration and must be verified by a Chartered Accountant."}


def _receipt(db: Session, tenant: Tenant, rid: str) -> dict:
    r = db.get(WalletReceipt, parse_uuid(rid, "receipt"))
    if r is None or r.tenant_id != tenant.id:  # another tenant's receipt is simply not found
        raise errors.not_found("Receipt not found")
    return _receipt_view(r)


def _receipts(db: Session, tenant: Tenant, page: Page) -> dict:
    return paged(db, select(WalletReceipt).where(WalletReceipt.tenant_id == tenant.id), page, WalletReceipt,
                 WalletReceipt.created_at.desc())


MONTH = Query(None, pattern=r"^\d{4}-\d{2}$", description="YYYY-MM (default: current month, billing timezone)")


def _month(m: str | None) -> str:
    return m or utcnow().astimezone(ZoneInfo(settings.billing_timezone)).strftime("%Y-%m")


# ------------------------------------------------------------------ service routes (pos-service)
class UsageEventIn(BaseModel):
    bill_id: str = Field(min_length=1, max_length=64)
    event: Literal["finalized", "voided"]
    bill_total_paise: int = Field(0, ge=-10**12, le=10**12)
    occurred_at: datetime
    offline: bool = False
    outlet_id: str | None = Field(None, max_length=64)
    invoice_number: str | None = Field(None, max_length=40)


class UsageBatchIn(BaseModel):
    events: list[UsageEventIn] = Field(min_length=1, max_length=200)


@router.post("/billing/tenants/{ref}/usage")
def report_usage(ref: str, body: UsageBatchIn, p: Principal = Depends(service_only("billing.usage.write")),
                 db: Session = Depends(get_db)):
    """Metering from pos-service: idempotent per (bill_id, event). Always accepted (a bill is never refused here)."""
    t = resolve_tenant(db, ref)
    return svc.ingest(db, t, [e.model_dump() for e in body.events], p.label)


READ = require("wallet.read", service_scope="billing.read")


@router.get("/billing/tenants/{ref}/wallet")
def tenant_wallet(ref: str, _: Principal = Depends(READ), db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    return {"tenant_id": str(t.id), "billing": svc.view(db, t)}


@router.get("/billing/tenants/{ref}/ledger")
def tenant_ledger(ref: str, page: Page = Depends(), from_: date | None = Query(None, alias="from"), to: date | None = None,
                  kind: str | None = None, _: Principal = Depends(READ), db: Session = Depends(get_db)):
    return _ledger_page(db, resolve_tenant(db, ref), page, from_, to, kind)


@router.get("/billing/tenants/{ref}/usage")
def tenant_usage(ref: str, month: str | None = MONTH, format: Literal["json", "csv"] = "json", _: Principal = Depends(READ),
                 db: Session = Depends(get_db)):
    return _usage(db, resolve_tenant(db, ref), _month(month), format)


@router.get("/billing/tenants/{ref}/receipts")
def tenant_receipts(ref: str, page: Page = Depends(), _: Principal = Depends(READ), db: Session = Depends(get_db)):
    return _receipts(db, resolve_tenant(db, ref), page)


@router.get("/billing/tenants/{ref}/receipts/{rid}")
def tenant_receipt(ref: str, rid: str, _: Principal = Depends(READ), db: Session = Depends(get_db)):
    return _receipt(db, resolve_tenant(db, ref), rid)


class IntentIn(BaseModel):
    amount_paise: int = Field(gt=0, le=10**10)  # whole rupees: 200000 = Rs 2,000 = 2,000 Chilli
    requested_by: str | None = Field(None, max_length=100)  # pos-service user id / email of the owner, for the audit


@router.post("/billing/tenants/{ref}/topups/intent", status_code=201)
def topup_intent(ref: str, body: IntentIn, p: Principal = Depends(service_only("billing.topup")), db: Session = Depends(get_db)):
    """Recharge: creates a Razorpay payment link on Chilli's own account. `checkout.url` is where the owner pays; nothing is
    credited until the signed webhook says the payment was captured (docs/CHILLI_WALLET.md). 503 topup_unavailable while
    TOPUP_ONLINE_ENABLED is off or the Razorpay keys are not set."""
    t = resolve_tenant(db, ref)
    o = svc.topup_intent(db, t, body.amount_paise, f"{p.label}:{body.requested_by or '-'}")
    audit(db, p, "wallet.topup_intent", "topup_order", o.id, t.id, after=to_dict(o, {"raw"}))
    v = svc.intent_view(o)
    return {"order": to_dict(o, {"raw"}), "intent": v, "provider": "razorpay",
            "checkout": {"kind": "payment_link", "url": o.short_url, "link_id": o.provider_link_id, "expires_at": v["expires_at"]}}


@router.get("/billing/tenants/{ref}/topups/{oid}")
def topup_status(ref: str, oid: str, _: Principal = Depends(READ), db: Session = Depends(get_db)):
    """Poll a recharge after the owner returns from Razorpay: status created | paid | expired, plus the wallet block."""
    t = resolve_tenant(db, ref)
    o = db.get(TopupOrder, parse_uuid(oid, "recharge"))
    if o is None or o.tenant_id != t.id:
        raise errors.not_found("Recharge not found")
    return {"intent": svc.intent_view(o), "billing": svc.view(db, t)}


@router.get("/billing/tenants/{ref}/topups")
def topup_list(ref: str, page: Page = Depends(), _: Principal = Depends(READ), db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    return paged(db, select(TopupOrder).where(TopupOrder.tenant_id == t.id), page, TopupOrder, [TopupOrder.created_at.desc()],
                 {"raw", "provider_order_id", "provider_payment_id"})


# ------------------------------------------------------------------ outbox (mail module)
class ClaimIn(BaseModel):
    limit: int = Field(20, ge=1, le=100)


@router.post("/billing/outbox/claim")
def outbox_claim(body: ClaimIn, _: Principal = Depends(service_only("billing.outbox")), db: Session = Depends(get_db)):
    rows = svc.claim_outbox(db, body.limit)
    return {"items": [{"id": r.id, "event_type": r.event_type, "kind": r.kind, "tenant_id": str(r.tenant_id),
                       "dedupe_key": r.dedupe_key, "attempts": r.attempts, "payload": r.payload} for r in rows]}


class AckIn(BaseModel):
    status: Literal["sent", "failed"] = "sent"


@router.post("/billing/outbox/{oid}/ack")
def outbox_ack(oid: int, body: AckIn, _: Principal = Depends(service_only("billing.outbox")), db: Session = Depends(get_db)):
    r = db.scalar(select(BillingOutbox).where(BillingOutbox.id == oid).with_for_update())
    if r is None:
        raise errors.not_found("Outbox event not found")
    if body.status == "sent":
        r.status, r.sent_at, r.lease_until = "sent", utcnow(), None
    elif r.status == "pending":
        r.lease_until = None  # released: claimable again at once
    return {"id": r.id, "status": r.status}


# ------------------------------------------------------------------ Razorpay webhook (PUBLIC, signature-authenticated)
@router.post("/billing/webhooks/razorpay")
async def razorpay_webhook(request: Request, x_razorpay_signature: str | None = Header(None),
                           x_razorpay_event_id: str | None = Header(None), db: Session = Depends(get_db)):
    """Public URL for Chilli's Razorpay account. 404 while the recharge flow is off or no webhook secret is set; otherwise
    X-Razorpay-Signature = hex HMAC-SHA256(webhook secret, raw body) or 401. `payment_link.paid` / `payment.captured` /
    `order.paid` credit the matching recharge once (docs/CHILLI_WALLET.md); every other event, an unknown intent and a wrong
    amount answer 200 with no credit (so Razorpay does not retry for days) and are recorded in razorpay_events."""
    secret = settings.razorpay_webhook_secret.get_secret_value()
    if not (settings.razorpay_webhook_enabled or settings.topup_online_enabled) or not secret:
        raise errors.not_found()
    raw = await request.body()
    good = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    if not x_razorpay_signature or not hmac.compare_digest(good.encode(), x_razorpay_signature.encode("utf-8", "replace")):
        security_event(db, "razorpay_signature_invalid", "warn", ip=request.client.host if request.client else None)
        db.commit()
        raise errors.unauthorized("Invalid signature")
    try:
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError
    except ValueError:
        raise errors.bad("Malformed webhook")
    event_id = x_razorpay_event_id or "body:" + hashlib.sha256(raw).hexdigest()
    res = svc.handle_razorpay_event(db, event_id, body)
    actor = SimpleNamespace(kind="system", id=None, label="razorpay:webhook", ip=None)
    tid = parse_uuid(res["tenant_id"], "tenant") if res.get("tenant_id") else None
    if res["outcome"] == "credited":
        audit(db, actor, "wallet.topup_paid", "topup_order", res["order_id"], tid,
              meta={"receipt": res["receipt"], "payment_id": res["payment_id"], "amount_paise": res["amount_paise"]})
    elif res["outcome"] in ("amount_mismatch", "duplicate_payment", "unknown_intent"):
        security_event(db, f"razorpay_{res['outcome']}", "warn", ip=request.client.host if request.client else None,
                       details={"event": body.get("event")})
    return {"ok": True, **{k: v for k, v in res.items() if k in ("outcome", "receipt")}}


# ------------------------------------------------------------------ admin (platform staff)
def _admin_wallet(db: Session, t: Tenant) -> dict:
    w = svc.ensure_wallet(db, t)
    eff = svc.effective(db, t.id)
    recent = db.scalars(select(WalletLedger).where(WalletLedger.tenant_id == t.id).order_by(WalletLedger.id.desc()).limit(20)).all()
    return {"tenant_id": str(t.id), "tenant": t.display_name, "slug": t.slug, "billing": svc.view(db, t, w=w, eff=eff),
            "wallet": {**to_dict(w)}, "settings": eff.as_dict(),
            "recent_ledger": [to_dict(r, {"idem_key"}) for r in recent]}


@router.get("/admin/tenants/{ref}/wallet")
def admin_wallet(ref: str, _: Principal = Depends(require("wallet.read", staff_only=True)), db: Session = Depends(get_db)):
    return _admin_wallet(db, resolve_tenant(db, ref))


class AdjustIn(BaseModel):
    kind: Literal["topup", "promo", "adjustment"]
    amount_paise: int = Field(ge=-10**10, le=10**10)
    reason: str = Field(min_length=3, max_length=500)
    payment_ref: str | None = Field(None, max_length=100)  # bank UTR / cheque / cash slip for a topup
    allow_negative: bool = False


@router.post("/admin/tenants/{ref}/wallet/adjust", status_code=201)
def admin_adjust(ref: str, body: AdjustIn, response: Response,
                 idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=8, max_length=100),
                 p: Principal = Depends(require("wallet.adjust", staff_only=True, step_up=True)), db: Session = Depends(get_db)):
    """Credit (topup = money received, with receipt and tier bonus; promo = free credit) or correct (adjustment, +/-) a wallet.
    Idempotency-Key is required: a retry returns the same result (200, replayed) instead of crediting twice."""
    t = resolve_tenant(db, ref)
    before = svc.ensure_wallet(db, t).balance_paise
    res = svc.adjust(db, t, kind=body.kind, amount=body.amount_paise, reason=body.reason, actor=p.label, idem=idempotency_key,
                     payment_ref=body.payment_ref, allow_negative=body.allow_negative)
    rec = res["receipt"]
    if not res["replayed"]:
        audit(db, p, f"wallet.{body.kind}", "wallet", t.id, t.id, before={"balance_paise": before},
              after={"balance_paise": res["wallet"].balance_paise},
              meta={"amount_paise": body.amount_paise, "reason": body.reason, "payment_ref": body.payment_ref,
                    "receipt": rec.number if rec else None, "ledger_id": res["ledger"].id})
    else:
        response.status_code = 200
    return {"replayed": res["replayed"], "ledger": to_dict(res["ledger"], {"idem_key"}),
            "receipt": _receipt_view(rec) if rec else None, "billing": svc.view(db, t, w=res["wallet"], eff=res["eff"])}


class ReasonIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


@router.post("/admin/tenants/{ref}/wallet/suspend")
def admin_suspend(ref: str, body: ReasonIn, p: Principal = Depends(require("tenants.suspend", staff_only=True, step_up=True)),
                  db: Session = Depends(get_db)):
    """Billing state `suspended`: new bills are refused (402 billing_suspended) until resumed; everything else keeps working."""
    t = resolve_tenant(db, ref)
    w = svc.set_suspended(db, t, True, body.reason)
    audit(db, p, "wallet.suspended", "wallet", t.id, t.id, meta={"reason": body.reason})
    return {"billing": svc.view(db, t, w=w)}


@router.post("/admin/tenants/{ref}/wallet/resume")
def admin_resume(ref: str, body: ReasonIn, p: Principal = Depends(require("tenants.suspend", staff_only=True, step_up=True)),
                 db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    w = svc.set_suspended(db, t, False, body.reason)
    audit(db, p, "wallet.resumed", "wallet", t.id, t.id, meta={"reason": body.reason})
    return {"billing": svc.view(db, t, w=w)}


@router.get("/admin/tenants/{ref}/wallet/ledger")
def admin_ledger(ref: str, page: Page = Depends(), from_: date | None = Query(None, alias="from"), to: date | None = None,
                 kind: str | None = None, _: Principal = Depends(require("wallet.read", staff_only=True)),
                 db: Session = Depends(get_db)):
    return _ledger_page(db, resolve_tenant(db, ref), page, from_, to, kind)


@router.get("/admin/tenants/{ref}/usage")
def admin_tenant_usage(ref: str, month: str | None = MONTH, format: Literal["json", "csv"] = "json",
                       _: Principal = Depends(require("wallet.read", staff_only=True)), db: Session = Depends(get_db)):
    return _usage(db, resolve_tenant(db, ref), _month(month), format)


@router.get("/admin/tenants/{ref}/receipts")
def admin_receipts(ref: str, page: Page = Depends(), _: Principal = Depends(require("wallet.read", staff_only=True)),
                   db: Session = Depends(get_db)):
    return _receipts(db, resolve_tenant(db, ref), page)


@router.get("/admin/tenants/{ref}/receipts/{rid}")
def admin_receipt(ref: str, rid: str, _: Principal = Depends(require("wallet.read", staff_only=True)), db: Session = Depends(get_db)):
    return _receipt(db, resolve_tenant(db, ref), rid)


class SettingsIn(BaseModel):
    """Every field optional; send a field as null to clear the override (inherit from plan / defaults)."""
    billing_model: Literal["payg", "subscription"] | None = None
    trial_days: int | None = Field(None, ge=0, le=365)
    per_bill_paise: int | None = Field(None, ge=0, le=100000)
    fee_gst_mode: Literal["inclusive", "exclusive"] | None = None
    charge_zero_bills: bool | None = None
    low_balance_paise: int | None = Field(None, ge=0, le=10**9)
    grace_paise: int | None = Field(None, ge=0, le=10**8)
    min_topup_paise: int | None = Field(None, ge=0, le=10**9)
    bonus_tiers: list[dict] | None = None
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("bonus_tiers")
    @classmethod
    def _tiers(cls, v):
        if v is None:
            return v
        try:
            return svc.parse_tiers(v)
        except (ValueError, KeyError, TypeError) as e:
            raise ValueError(f"invalid bonus_tiers: {e}")


def _settings_out(db: Session, row, *, tenant: Tenant | None = None, plan: Plan | None = None) -> dict:
    eff = svc.effective(db, tenant.id if tenant else None, plan.id if plan else None)
    return {"override": svc.settings_row_view(row), "effective": eff.as_dict(), "defaults": svc.defaults()}


@router.get("/admin/tenants/{ref}/billing-settings")
def get_tenant_settings(ref: str, _: Principal = Depends(require("wallet.read", staff_only=True)), db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    out = _settings_out(db, svc._row(db, tenant_id=t.id), tenant=t)
    w = svc.ensure_wallet(db, t)
    return {**out, "trial_started_at": w.trial_started_at.isoformat(), "trial_ends_at": w.trial_ends_at.isoformat()}


@router.put("/admin/tenants/{ref}/billing-settings")
def put_tenant_settings(ref: str, body: SettingsIn, p: Principal = Depends(require("billing_settings.manage", staff_only=True, step_up=True)),
                        db: Session = Depends(get_db)):
    """Per-tenant overrides. Changing trial_days moves this tenant's trial end to trial start + trial_days."""
    t = resolve_tenant(db, ref)
    values = body.model_dump(exclude_unset=True, exclude={"reason"})
    before = svc.settings_row_view(svc._row(db, tenant_id=t.id))
    row = svc.save_settings(db, actor=p.label, values=values, tenant_id=t.id)
    if "trial_days" in values:
        svc.set_trial_days(db, t, svc.effective(db, t.id).trial_days)
    w = svc.lock(db, t)
    svc._after_change(db, t, w, svc.effective(db, t.id), None)
    audit(db, p, "billing_settings.tenant_updated", "tenant", t.id, t.id, before=before, after=svc.settings_row_view(row),
          meta={"reason": body.reason})
    return {**_settings_out(db, row, tenant=t), "trial_ends_at": w.trial_ends_at.isoformat()}


def _plan(db: Session, code: str) -> Plan:
    plan = db.scalar(select(Plan).where(Plan.code == code))
    if plan is None:
        raise errors.not_found(f"Plan {code} not found")
    return plan


@router.get("/admin/plans/{code}/billing-settings")
def get_plan_settings(code: str, _: Principal = Depends(require("wallet.read", staff_only=True)), db: Session = Depends(get_db)):
    plan = _plan(db, code)
    return _settings_out(db, svc._row(db, plan_id=plan.id), plan=plan)


@router.put("/admin/plans/{code}/billing-settings")
def put_plan_settings(code: str, body: SettingsIn, p: Principal = Depends(require("billing_settings.manage", staff_only=True, step_up=True)),
                      db: Session = Depends(get_db)):
    """Per-plan overrides; apply to every tenant on the plan without its own override. trial_days applies to tenants created
    afterwards (existing trials keep their end date)."""
    plan = _plan(db, code)
    values = body.model_dump(exclude_unset=True, exclude={"reason"})
    before = svc.settings_row_view(svc._row(db, plan_id=plan.id))
    row = svc.save_settings(db, actor=p.label, values=values, plan_id=plan.id)
    audit(db, p, "billing_settings.plan_updated", "plan", plan.id, before=before, after=svc.settings_row_view(row),
          meta={"reason": body.reason})
    return _settings_out(db, row, plan=plan)


@router.get("/admin/billing/defaults")
def billing_defaults(_: Principal = Depends(require("wallet.read", staff_only=True))):
    return {"defaults": svc.defaults(), "topup_online_enabled": settings.topup_online_enabled,
            "razorpay_webhook_enabled": settings.razorpay_webhook_enabled or settings.topup_online_enabled,
            "max_topup_paise": settings.chilli_max_topup_paise, "timezone": settings.billing_timezone}


@router.get("/admin/billing/usage")
def all_usage(month: str | None = MONTH, format: Literal["json", "csv"] = "json",
              _: Principal = Depends(require("wallet.read", staff_only=True)), db: Session = Depends(get_db)):
    """Every tenant with a wallet: one statement summary each (JSON) or one CSV row each."""
    m = _month(month)
    tenants = db.scalars(select(Tenant).join(Wallet, Wallet.tenant_id == Tenant.id).order_by(Tenant.slug)).all()
    items = [svc.statement(db, t, m) for t in tenants]
    if format != "csv":
        return {"month": m, "items": items}
    head = ["tenant_slug", "tenant", "month", "opening_balance_paise", "bills_reported", "bills_charged", "bills_free_trial",
            "fees_paise", "fee_credit_backs_paise", "net_fees_paise", "gst_in_net_fees_paise", "topups_paise", "promo_paise",
            "adjustments_paise", "closing_balance_paise"]
    rows = [[t.slug, s["tenant"], m, s["opening_balance_paise"], s["bills"]["reported"], s["bills"]["charged"],
             s["bills"]["free_trial"], s["fees_paise"], s["fee_credit_backs_paise"], s["net_fees_paise"], s["gst_in_net_fees_paise"],
             s["topups_paise"], s["promo_paise"], s["adjustments_paise"], s["closing_balance_paise"]] for t, s in zip(tenants, items)]
    return Response(to_csv(head, rows), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="chilli-usage-{m}.csv"'})


@router.post("/admin/billing/run-due")
def run_due(p: Principal = Depends(require("billing_settings.manage", staff_only=True)), db: Session = Depends(get_db)):
    out = svc.run_due(db)
    audit(db, p, "billing.run_due", meta=out)
    return out


@router.get("/admin/billing/outbox")
def admin_outbox(page: Page = Depends(), status: str | None = None, tenant: str | None = None,
                 _: Principal = Depends(require("wallet.read", staff_only=True)), db: Session = Depends(get_db)):
    stmt = select(BillingOutbox)
    if status:
        stmt = stmt.where(BillingOutbox.status == status)
    if tenant:
        stmt = stmt.where(BillingOutbox.tenant_id == resolve_tenant(db, tenant).id)
    return paged(db, stmt, page, BillingOutbox, BillingOutbox.id.desc())
