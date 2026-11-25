"""Pay-as-you-go wallet (docs/PAYG_BILLING.md): a 7-day free trial from tenant creation, then a per-bill fee debited from a
prepaid credit balance in integer paise.

Invariants (tests/test_wallet.py):
* every money movement is a row of the append-only ``wallet_ledger``; ``wallets.balance_paise`` equals the balance_after of
  the tenant's latest row and the sum of all its amounts;
* every movement happens at most once: ``(tenant_id, idem_key)`` is unique and every writer first locks the wallet row
  (``SELECT ... FOR UPDATE``), so concurrent writers serialise and a replay finds the earlier row;
* a bill is charged at most once (``bill_fee:<root bill id>``) and a void credits that fee back at most once
  (``void:<root bill id>``), whatever order or how often pos-service reports them;
* the balance only goes negative through bill fees (bills already served; bounded online by the grace overdraft, offline
  sync may go further) or an explicit admin adjustment with ``allow_negative``; never through a top-up / promo / credit-back.
"""
from __future__ import annotations

import json
import logging
import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, update as pg_update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core import errors
from app.core.config import settings
from app.models import (BillingOutbox, BillingSettings, BusinessProfile, Plan, RazorpayEvent, Subscription, Tenant, TopupOrder, UsageEvent,
                        Wallet, WalletLedger, WalletReceipt, receipt_seq, utcnow)

log = logging.getLogger("app.wallet")

FIELDS = ("billing_model", "trial_days", "per_bill_paise", "fee_gst_mode", "charge_zero_bills", "low_balance_paise",
          "grace_paise", "min_topup_paise", "bonus_tiers")
STATES = ("trial", "active", "low", "grace", "blocked", "suspended")
MAX_FUTURE_SKEW = timedelta(minutes=10)


# ------------------------------------------------------------------ settings
def parse_tiers(raw) -> list[dict]:
    """[{min_paise, bonus_paise}] sorted by min_paise; raises ValueError on anything else."""
    if raw in (None, "", []):
        return []
    data = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(data, list) or len(data) > 10:
        raise ValueError("bonus_tiers must be a list of at most 10 tiers")
    out = []
    for t in data:
        mn, bn = int(t["min_paise"]), int(t["bonus_paise"])
        if mn <= 0 or bn < 0:
            raise ValueError("bonus tier needs min_paise > 0 and bonus_paise >= 0")
        out.append({"min_paise": mn, "bonus_paise": bn})
    if len({t["min_paise"] for t in out}) != len(out):
        raise ValueError("bonus tiers need distinct min_paise")
    return sorted(out, key=lambda t: t["min_paise"])


def defaults() -> dict:
    try:
        tiers = parse_tiers(settings.payg_bonus_tiers)
    except (ValueError, KeyError, TypeError):
        log.error("PAYG_BONUS_TIERS is invalid; no bonus tiers apply")
        tiers = []
    return {"billing_model": settings.payg_billing_model, "trial_days": settings.payg_trial_days,
            "per_bill_paise": settings.payg_per_bill_paise, "fee_gst_mode": settings.payg_fee_gst_mode,
            "charge_zero_bills": settings.payg_charge_zero_bills, "low_balance_paise": settings.payg_low_balance_paise,
            "grace_paise": (settings.payg_grace_paise if settings.payg_grace_paise is not None
                            else max(0, settings.chilli_grace_orders) * max(settings.payg_per_bill_paise, 0)), "min_topup_paise": settings.payg_min_topup_paise, "bonus_tiers": tiers}


@dataclass(frozen=True)
class Effective:
    billing_model: str
    trial_days: int
    per_bill_paise: int
    fee_gst_mode: str
    charge_zero_bills: bool
    low_balance_paise: int
    grace_paise: int
    min_topup_paise: int
    bonus_tiers: list = field(default_factory=list)
    sources: dict = field(default_factory=dict)  # field -> default | plan | tenant

    @property
    def metered(self) -> bool:
        return self.billing_model == "payg"

    def fee(self) -> tuple[int, int, int]:
        """(debit, base excl. GST, GST) of one bill. inclusive: the configured fee contains GST; exclusive: GST is added."""
        p, rate = self.per_bill_paise, settings.gst_rate_bps
        if p <= 0:
            return 0, 0, 0
        if self.fee_gst_mode == "exclusive":
            gst = (p * rate + 5000) // 10000
            return p + gst, p, gst
        base = (2 * p * 10000 + (10000 + rate)) // (2 * (10000 + rate))  # round half up of p / (1 + rate)
        return p, base, p - base

    def bonus_for(self, amount_paise: int) -> int:
        best = 0
        for t in self.bonus_tiers:
            if amount_paise >= t["min_paise"]:
                best = t["bonus_paise"]
        return best

    def as_dict(self) -> dict:
        return {f: getattr(self, f) for f in FIELDS} | {"sources": self.sources, "debit_per_bill_paise": self.fee()[0]}


def _row(db: Session, *, plan_id=None, tenant_id=None) -> BillingSettings | None:
    if plan_id is not None:
        return db.scalar(select(BillingSettings).where(BillingSettings.plan_id == plan_id))
    if tenant_id is not None:
        return db.scalar(select(BillingSettings).where(BillingSettings.tenant_id == tenant_id))
    return None


def plan_of(db: Session, tenant_id) -> Plan | None:
    sub = db.scalar(select(Subscription).where(Subscription.tenant_id == tenant_id,
                                               Subscription.status.in_(("trialing", "active", "past_due"))))
    return db.get(Plan, sub.plan_id) if sub else None


def effective(db: Session, tenant_id=None, plan_id=None) -> Effective:
    """defaults (config PAYG_*) <- the plan's billing_settings row <- the tenant's row. With a tenant and no plan, the plan of
    its live subscription is used."""
    vals, src = defaults(), {f: "default" for f in FIELDS}
    if plan_id is None and tenant_id is not None:
        p = plan_of(db, tenant_id)
        plan_id = p.id if p else None
    for scope, row in (("plan", _row(db, plan_id=plan_id)), ("tenant", _row(db, tenant_id=tenant_id))):
        if row is None:
            continue
        for f in FIELDS:
            v = getattr(row, f)
            if v is not None:
                vals[f], src[f] = (parse_tiers(v) if f == "bonus_tiers" else v), scope
    if src["grace_paise"] == "default" and settings.payg_grace_paise is None:  # the grace is a number of ORDERS: follow a changed fee
        vals["grace_paise"] = max(0, settings.chilli_grace_orders) * max(vals["per_bill_paise"], 0)
    return Effective(**vals, sources=src)


def save_settings(db: Session, *, actor: str, values: dict, plan_id=None, tenant_id=None) -> BillingSettings:
    """Upserts the plan's or tenant's override row. `values` holds only the fields being changed; None clears (inherit)."""
    row = _row(db, plan_id=plan_id, tenant_id=tenant_id)
    if row is None:
        row = BillingSettings(plan_id=plan_id, tenant_id=tenant_id)
        db.add(row)
    for f, v in values.items():
        if f not in FIELDS:
            continue
        setattr(row, f, parse_tiers(v) if f == "bonus_tiers" and v is not None else v)
    row.updated_by = actor
    db.flush()
    return row


def settings_row_view(row: BillingSettings | None) -> dict:
    return {f: (getattr(row, f) if row else None) for f in FIELDS}


# ------------------------------------------------------------------ wallet + state
def ensure_wallet(db: Session, tenant: Tenant, start: datetime | None = None) -> Wallet:
    """Creates the tenant's wallet (trial from `start`, default the tenant's creation) if it does not exist."""
    w = db.get(Wallet, tenant.id)
    if w is not None:
        return w
    start = start or tenant.created_at or utcnow()
    days = effective(db, tenant.id).trial_days
    db.execute(pg_insert(Wallet).values(tenant_id=tenant.id, balance_paise=0, trial_started_at=start,
                                        trial_ends_at=start + timedelta(days=days), created_at=utcnow(), updated_at=utcnow())
               .on_conflict_do_nothing(index_elements=["tenant_id"]))
    return db.get(Wallet, tenant.id, populate_existing=True)


def lock(db: Session, tenant: Tenant) -> Wallet:
    """The wallet row, locked until the end of the transaction (serialises every balance change of the tenant)."""
    ensure_wallet(db, tenant)
    return db.scalar(select(Wallet).where(Wallet.tenant_id == tenant.id).with_for_update().execution_options(populate_existing=True))


def state_of(w: Wallet, eff: Effective, now: datetime) -> str:
    if w.suspended_at is not None:
        return "suspended"
    if not eff.metered or now < w.trial_ends_at:
        return "trial" if eff.metered else "active"
    # Chilli (docs/CHILLI_WALLET.md): active > low (<= 100) > grace (<= 0: the next N orders are still allowed) > blocked
    # (balance <= -N x fee: new orders are refused). The balance is just the signed ledger sum; the debt is its negative part.
    bal = w.balance_paise
    if bal <= -eff.grace_paise:
        return "blocked"
    if bal <= 0:
        return "grace"
    if bal <= eff.low_balance_paise:
        return "low"
    return "active"


def _rs(paise: int) -> str:
    sign = "-" if paise < 0 else ""
    return f"{sign}₹{abs(paise) // 100}.{abs(paise) % 100:02d}"


def chilli(paise: int):
    """Chilli for an amount in paise: 1 rupee = 1 Chilli. A whole number whenever it is one (every recharge, every bill)."""
    return paise // 100 if paise % 100 == 0 else round(paise / 100, 2)


def _indian(n) -> str:
    """12345 -> '12,345', 1234567 -> '12,34,567' (lakh grouping), 1250.5 -> '1,250.50'."""
    neg = "-" if n < 0 else ""
    whole = str(int(abs(n)))
    frac = "" if float(n).is_integer() else f"{abs(n) % 1:.2f}"[1:]
    head, tail = whole[:-3], whole[-3:]
    while len(head) > 2:
        tail = head[-2:] + "," + tail
        head = head[:-2]
    return neg + (head + "," + tail if head else tail) + frac


def _ch(paise: int) -> str:
    return f"{_indian(chilli(paise))} Chilli"


BANNERS = {
    "trial": ("info", "Free trial: {days} day(s) left. After that each bill uses {fee}.",
              "फ़्री ट्रायल: {days} दिन बाकी। उसके बाद हर बिल पर {fee} लगेंगे।"),
    "trial_ending": ("warning", "Free trial ends in {days} day(s). Recharge to keep billing ({fee} per bill).",
                     "फ़्री ट्रायल {days} दिन में ख़त्म होगा। बिलिंग जारी रखने के लिए रिचार्ज करें ({fee} प्रति बिल)।"),
    "low": ("warning", "Low balance: {balance} left (about {bills} bills). Recharge to keep billing.",
            "बैलेंस कम है: {balance} बचे (लगभग {bills} बिल)। बिलिंग जारी रखने के लिए रिचार्ज करें।"),
    "grace": ("critical", "{bills} orders left before billing stops. Recharge now.",
              "बिलिंग रुकने से पहले {bills} ऑर्डर बाकी हैं। अभी रिचार्ज करें।"),
    "blocked": ("critical", "Recharge to continue. You have no Chilli left for new orders.",
                "जारी रखने के लिए रिचार्ज करें। नए ऑर्डर के लिए Chilli नहीं बचे।"),
    "suspended": ("critical", "Billing is paused by Chilli support. Please contact support.",
                  "Chilli सपोर्ट ने बिलिंग रोक दी है। कृपया सपोर्ट से संपर्क करें।"),
}


def view(db: Session, tenant: Tenant, now: datetime | None = None, w: Wallet | None = None, eff: Effective | None = None) -> dict:
    """The `billing` block (entitlements feed, pos-service /auth/me, GET /billing/wallet). Contract in docs/PAYG_BILLING.md."""
    now = now or utcnow()
    w = w or ensure_wallet(db, tenant)
    eff = eff or effective(db, tenant.id)
    st = state_of(w, eff, now)
    debit = eff.fee()[0]
    days_left = max(0, math.ceil((w.trial_ends_at - now).total_seconds() / 86400)) if eff.metered else 0
    bills_left = None
    if eff.metered and debit > 0 and st not in ("trial", "suspended"):
        bills_left = max(0, (w.balance_paise + eff.grace_paise) // debit)  # orders left before new orders are refused
    in_grace = eff.metered and st == "grace"
    key = st
    if st == "trial" and days_left <= 3:
        key = "trial_ending"
    banner = None
    if eff.metered and key in BANNERS:
        lvl, en, hi = BANNERS[key]
        about = max(0, w.balance_paise // debit) if debit else 0
        fmt = {"days": days_left, "fee": _ch(debit), "balance": _ch(w.balance_paise),
               "bills": about if key == "low" else (bills_left or 0)}
        banner = {"level": lvl, "code": key, "message": {"en": en.format(**fmt), "hi": hi.format(**fmt)}}
    return {"state": st, "model": eff.billing_model, "trial_ends_at": w.trial_ends_at.isoformat(), "days_left": days_left,
            "balance_paise": w.balance_paise, "per_bill_paise": debit, "fee_gst_mode": eff.fee_gst_mode,
            "charge_zero_bills": eff.charge_zero_bills, "low_balance_paise": eff.low_balance_paise,
            "grace_paise": eff.grace_paise, "bonus_tiers": eff.bonus_tiers,
            "can_bill": st not in ("blocked", "suspended"), "in_grace": in_grace, "bills_left": bills_left,
            "orders_left": bills_left if st == "grace" else None, "grace_orders": (eff.grace_paise // debit) if debit else 0,
            "blocked": st == "blocked",
            "suspended_reason": w.suspended_reason if st == "suspended" else None, "banner": banner,
            "topup_online": settings.topup_online_enabled,
            # Chilli view of the same numbers (1 rupee = 1 Chilli); the paise fields stay the source of truth
            "unit": "chilli", "balance_chilli": chilli(w.balance_paise), "per_bill_chilli": chilli(debit),
            "low_balance_chilli": chilli(eff.low_balance_paise), "min_topup_paise": max(eff.min_topup_paise, 100),
            "min_topup_chilli": chilli(max(eff.min_topup_paise, 100)), "max_topup_paise": settings.chilli_max_topup_paise,
            "max_topup_chilli": chilli(settings.chilli_max_topup_paise)}


# ------------------------------------------------------------------ ledger
def post(db: Session, w: Wallet, kind: str, amount: int, idem_key: str, *, source: str, actor: str, ref_type=None,
         ref_id=None, reason=None, fee_base=None, fee_gst=None, meta=None) -> tuple[WalletLedger, bool]:
    """One movement on a LOCKED wallet. Returns (row, created); a known idem_key returns the earlier row untouched."""
    prior = db.scalar(select(WalletLedger).where(WalletLedger.tenant_id == w.tenant_id, WalletLedger.idem_key == idem_key))
    if prior is not None:
        return prior, False
    w.balance_paise += amount
    row = WalletLedger(tenant_id=w.tenant_id, kind=kind, amount_paise=amount, balance_after_paise=w.balance_paise,
                       idem_key=idem_key, source=source, actor=actor, ref_type=ref_type, ref_id=str(ref_id) if ref_id else None,
                       reason=reason, fee_base_paise=fee_base, fee_gst_paise=fee_gst, meta=meta, at=utcnow())
    db.add(row)
    db.flush()
    return row, True


def _after_change(db: Session, tenant: Tenant, w: Wallet, eff: Effective, cause: WalletLedger | None, now=None) -> str:
    """Records the new state; entering `low` / `grace` / `blocked` emits a billing.notice once per transition."""
    now = now or utcnow()
    st = state_of(w, eff, now)
    if st != w.last_state:
        if st in ("low", "grace", "blocked") and cause is not None:
            notice(db, tenant, {"low": "low_balance", "grace": "grace_started", "blocked": "credit_exhausted"}[st], f"{st}:{cause.id}", w=w, eff=eff)
        w.last_state = st
    return st


# ------------------------------------------------------------------ notices (outbox)
NOTICE_TEXT = {
    "trial_ends_3d": ("Your Chilli Agent free trial ends in 3 days",
                      "Your free trial ends on {trial_end}. After that each bill uses {fee}, taken from your Chilli balance. Recharge to keep billing without interruption."),
    "trial_ends_1d": ("Your Chilli Agent free trial ends tomorrow",
                      "Your free trial ends on {trial_end}. Each bill after that uses {fee}. Current balance: {balance}."),
    "trial_ended": ("Your Chilli Agent free trial has ended",
                    "Your free trial ended on {trial_end}. Each bill now uses {fee} (current balance: {balance}). Recharge to keep taking new orders."),
    "low_balance": ("Low Chilli balance: {balance} left",
                    "Your balance is {balance} (about {bills} bills at {fee} per bill). Recharge soon to keep billing."),
    "grace_started": ("Chilli used up: {orders} more orders allowed",
                      "Your balance is {balance}. You can still take {orders} more orders before billing stops. Recharge now to keep going; "
                      "what you used is taken off your next recharge."),
    "credit_exhausted": ("Out of Chilli: recharge to continue",
                         "Your balance is {balance}. New orders are blocked until you recharge. Bills that are already open can still be paid."),
    "topup_received": ("Chilli added: {amount}",
                       "We added {amount} to your account (receipt {receipt}). New balance: {balance}."),
    "billing_suspended": ("Chilli Agent billing paused", "Billing has been paused by Chilli support. Please contact support."),
}


def notice(db: Session, tenant: Tenant, kind: str, dedupe_key: str, *, w: Wallet | None = None, eff: Effective | None = None,
           extra: dict | None = None) -> bool:
    """Queues one `billing.notice` (idempotent on (tenant, dedupe_key)); True if it was new. The mail module renders/sends it
    (docs/PAYG_BILLING.md)."""
    w = w or ensure_wallet(db, tenant)
    eff = eff or effective(db, tenant.id)
    prof = db.get(BusinessProfile, tenant.id)
    debit = eff.fee()[0]
    data = {"trial_ends_at": w.trial_ends_at.isoformat(), "balance_paise": w.balance_paise, "per_bill_paise": debit,
            "bills_left": (max(0, w.balance_paise // debit) if debit else None), **(extra or {})}
    fmt = {"trial_end": w.trial_ends_at.astimezone(ZoneInfo(settings.billing_timezone)).strftime("%d %b %Y %H:%M"),
           "fee": _ch(debit), "balance": _ch(w.balance_paise), "bills": data["bills_left"] or 0,
           "orders": max(0, (w.balance_paise + eff.grace_paise) // debit) if debit else 0,
           "amount": _ch(int((extra or {}).get("amount_paise", 0))), "receipt": (extra or {}).get("receipt_number", "")}
    subj, body = NOTICE_TEXT[kind]
    payload = {"event": "billing.notice", "kind": kind,
               "tenant": {"id": str(tenant.id), "slug": tenant.slug, "name": tenant.display_name},
               "recipient": {"email": prof.contact_email if prof else None, "name": prof.contact_name if prof else None},
               "data": data, "text": {"en": {"subject": subj.format(**fmt), "body": body.format(**fmt)}}}
    res = db.execute(pg_insert(BillingOutbox).values(tenant_id=tenant.id, event_type="billing.notice", kind=kind,
                                                     dedupe_key=dedupe_key, payload=payload, status="pending", attempts=0,
                                                     created_at=utcnow())
                     .on_conflict_do_nothing(constraint="uq_billing_outbox_dedupe").returning(BillingOutbox.id))
    return res.scalar() is not None


def claim_outbox(db: Session, limit: int, now: datetime | None = None) -> list[BillingOutbox]:
    now = now or utcnow()
    rows = db.scalars(select(BillingOutbox).where(
        BillingOutbox.status == "pending",
        (BillingOutbox.lease_until.is_(None)) | (BillingOutbox.lease_until <= now))
        .order_by(BillingOutbox.id).limit(limit).with_for_update(skip_locked=True)).all()
    for r in rows:
        r.attempts += 1
        if r.attempts > settings.billing_outbox_max_attempts:
            r.status = "dead"
        else:
            r.lease_until = now + timedelta(seconds=settings.billing_outbox_lease_seconds)
    db.flush()
    return [r for r in rows if r.status == "pending"]


# ------------------------------------------------------------------ metering
def _clamp(at: datetime, now: datetime) -> datetime:
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return min(at, now + MAX_FUTURE_SKEW)


def ingest(db: Session, tenant: Tenant, events: list[dict], source: str, now: datetime | None = None) -> dict:
    """Applies usage events of ONE tenant from pos-service (POST /billing/tenants/{t}/usage). Each event: bill_id, event
    (finalized|voided), bill_total_paise, occurred_at, offline, outlet_id, invoice_number. Idempotent per (bill_id, event)."""
    now = now or utcnow()
    w = lock(db, tenant)
    eff = effective(db, tenant.id)
    debit, base, gst = eff.fee()
    results, last = [], None
    for ev in events:
        bill_id, kind = str(ev["bill_id"]), ev["event"]
        prior = db.scalar(select(UsageEvent).where(UsageEvent.tenant_id == tenant.id, UsageEvent.bill_id == bill_id,
                                                   UsageEvent.event == kind))
        if prior is not None:
            results.append({"bill_id": bill_id, "event": kind, "status": "duplicate", "outcome": prior.outcome,
                            "charged_paise": prior.charged_paise})
            continue
        occurred = _clamp(ev["occurred_at"], now)
        total = int(ev.get("bill_total_paise") or 0)
        charged, row = 0, None
        if kind == "finalized":
            voided_first = db.scalar(select(UsageEvent.id).where(UsageEvent.tenant_id == tenant.id, UsageEvent.bill_id == bill_id,
                                                                 UsageEvent.event == "voided"))
            if voided_first:
                outcome = "voided_before_sync"
            elif not eff.metered:
                outcome = "not_metered"
            elif occurred < w.trial_ends_at:
                outcome = "trial"
            elif total <= 0 and not eff.charge_zero_bills:
                outcome = "zero_total"
            elif debit <= 0:
                outcome = "free"
            else:
                row, _ = post(db, w, "bill_fee", -debit, f"bill_fee:{bill_id}", source="pos", actor=source, ref_type="bill",
                              ref_id=bill_id, fee_base=base, fee_gst=gst,
                              meta={"invoice_number": ev.get("invoice_number"), "offline": bool(ev.get("offline"))})
                outcome, charged = "charged", debit
        else:
            fee_row = db.scalar(select(WalletLedger).where(WalletLedger.tenant_id == tenant.id,
                                                           WalletLedger.idem_key == f"bill_fee:{bill_id}"))
            if fee_row is None:
                outcome = "nothing_to_credit"
            else:
                row, _ = post(db, w, "void_credit_back", -fee_row.amount_paise, f"void:{bill_id}", source="pos", actor=source,
                              ref_type="bill", ref_id=bill_id, fee_base=fee_row.fee_base_paise, fee_gst=fee_row.fee_gst_paise,
                              meta={"invoice_number": ev.get("invoice_number")})
                outcome, charged = "credited_back", -fee_row.amount_paise
        db.add(UsageEvent(tenant_id=tenant.id, bill_id=bill_id, event=kind, outlet_id=ev.get("outlet_id"),
                          invoice_number=ev.get("invoice_number"), bill_total_paise=total, occurred_at=occurred,
                          offline=bool(ev.get("offline")), outcome=outcome, charged_paise=charged,
                          ledger_id=row.id if row else None, source=source, received_at=now))
        db.flush()
        last = row or last
        results.append({"bill_id": bill_id, "event": kind, "status": "applied", "outcome": outcome, "charged_paise": charged})
    _after_change(db, tenant, w, eff, last, now)
    return {"results": results, "billing": view(db, tenant, now, w, eff)}


# ------------------------------------------------------------------ top-ups, adjustments
def _fy(now: datetime) -> str:
    local = now.astimezone(ZoneInfo(settings.billing_timezone))
    y = local.year if local.month >= 4 else local.year - 1
    return f"{y % 100:02d}{(y + 1) % 100:02d}"


def credit_topup(db: Session, tenant: Tenant, w: Wallet, eff: Effective, amount: int, *, source: str, actor: str,
                 idem_key: str, payment_ref: str | None = None, note: str | None = None) -> tuple[WalletReceipt, bool]:
    """Money received: a numbered receipt, the `topup` ledger row and the tier bonus (a `promo` row). Idempotent on idem_key."""
    prior = db.scalar(select(WalletLedger).where(WalletLedger.tenant_id == tenant.id, WalletLedger.idem_key == idem_key))
    if prior is not None:
        rec = db.scalar(select(WalletReceipt).where(WalletReceipt.ledger_id == prior.id))
        return rec, False
    rid = uuid.uuid4()
    now = utcnow()
    bonus = eff.bonus_for(amount)
    row, _ = post(db, w, "topup", amount, idem_key, source=source, actor=actor, ref_type="receipt", ref_id=rid,
                  reason=note, meta={"payment_ref": payment_ref} if payment_ref else None)
    prof = db.get(BusinessProfile, tenant.id)
    rate = settings.gst_rate_bps
    # PLACEHOLDER (CA to confirm): the amount received is treated as GST-inclusive; CGST+SGST for a same-state buyer, else IGST.
    taxable = (2 * amount * 10000 + (10000 + rate)) // (2 * (10000 + rate))
    tax = amount - taxable
    same_state = bool(prof and prof.state_code == settings.seller_state_code)
    cg = tax // 2 if same_state else 0
    rec = WalletReceipt(id=rid, number=f"{settings.receipt_prefix}/{_fy(now)}/{db.scalar(receipt_seq.next_value()):06d}",
                        tenant_id=tenant.id, source=source, amount_paise=amount, bonus_paise=bonus, gst_mode="inclusive",
                        taxable_paise=taxable, gst_rate_bps=rate, cgst_paise=cg, sgst_paise=(tax - cg) if same_state else 0,
                        igst_paise=0 if same_state else tax, sac_code=settings.gst_sac_code,
                        supplier_gstin=settings.seller_gstin or None, supplier_state_code=settings.seller_state_code,
                        buyer_gstin=prof.gstin if prof else None, buyer_state_code=prof.state_code if prof else None,
                        tax_needs_ca_verification=True, payment_ref=payment_ref, ledger_id=row.id, note=note,
                        created_by=actor, created_at=now)
    db.add(rec)
    db.flush()
    if bonus > 0:
        post(db, w, "promo", bonus, f"bonus:{rid}", source="promo", actor="system:bonus_tier", ref_type="receipt", ref_id=rid,
             reason=f"Recharge bonus for {_ch(amount)}")
    notice(db, tenant, "topup_received", f"topup:{rec.number}", w=w, eff=eff,
           extra={"amount_paise": amount, "bonus_paise": bonus, "receipt_number": rec.number})
    _after_change(db, tenant, w, eff, row)
    return rec, True


def adjust(db: Session, tenant: Tenant, *, kind: str, amount: int, reason: str, actor: str, idem: str,
           payment_ref: str | None = None, allow_negative: bool = False) -> dict:
    """Admin credit change. kind topup (money received: receipt + bonus), promo (free credit), adjustment (+/- correction)."""
    w = lock(db, tenant)
    eff = effective(db, tenant.id)
    key = f"adm:{idem}"
    prior = db.scalar(select(WalletLedger).where(WalletLedger.tenant_id == tenant.id, WalletLedger.idem_key == key))
    if prior is not None:
        if prior.kind != kind or prior.amount_paise != amount:
            raise errors.conflict("This Idempotency-Key was used for a different adjustment", "idempotency_key_reused")
        rec = db.scalar(select(WalletReceipt).where(WalletReceipt.ledger_id == prior.id))
        return {"replayed": True, "ledger": prior, "receipt": rec, "wallet": w, "eff": eff}
    if kind in ("topup", "promo") and amount <= 0:
        raise errors.bad(f"A {kind} must be a positive amount", "invalid_amount")
    if amount == 0:
        raise errors.bad("Amount must not be zero", "invalid_amount")
    if amount < 0 and w.balance_paise + amount < 0 and not allow_negative:
        raise errors.conflict(f"This would take the balance to {_ch(w.balance_paise + amount)}; pass allow_negative to confirm",
                              "would_go_negative")
    rec = None
    if kind == "topup":
        rec, _ = credit_topup(db, tenant, w, eff, amount, source="admin", actor=actor, idem_key=key, payment_ref=payment_ref,
                              note=reason)
        row = db.scalar(select(WalletLedger).where(WalletLedger.tenant_id == tenant.id, WalletLedger.idem_key == key))
    else:
        row, _ = post(db, w, kind, amount, key, source="promo" if kind == "promo" else "admin", actor=actor, ref_type="op",
                      ref_id=idem[:64], reason=reason, meta={"payment_ref": payment_ref} if payment_ref else None)
        _after_change(db, tenant, w, eff, row)
    return {"replayed": False, "ledger": row, "receipt": rec, "wallet": w, "eff": eff}


def set_suspended(db: Session, tenant: Tenant, suspended: bool, reason: str) -> Wallet:
    w = lock(db, tenant)
    if suspended:
        if w.suspended_at is None:
            w.suspended_at, w.suspended_reason = utcnow(), reason
            notice(db, tenant, "billing_suspended", f"suspended:{w.suspended_at.isoformat()}", w=w)
    else:
        w.suspended_at, w.suspended_reason = None, None
    w.last_state = state_of(w, effective(db, tenant.id), utcnow())
    return w


def set_trial_days(db: Session, tenant: Tenant, days: int) -> Wallet:
    w = lock(db, tenant)
    w.trial_ends_at = w.trial_started_at + timedelta(days=days)
    return w


# ------------------------------------------------------------------ Chilli recharge (Razorpay payment link)
def topup_limits(eff: Effective) -> tuple[int, int]:
    """(minimum, maximum) of one online recharge in paise."""
    return max(eff.min_topup_paise, 100), max(settings.chilli_max_topup_paise, 100)


def topup_intent(db: Session, tenant: Tenant, amount: int, requested_by: str) -> TopupOrder:
    """A recharge attempt: validates the amount, asks Razorpay for a payment link (reference_id = the intent id) and stores
    it. Nothing is credited here; only the verified webhook credits."""
    from app.services import payment_links as pl
    if not settings.topup_online_enabled:
        raise errors.AppError(503, "topup_unavailable", "Recharge is not available yet. Contact Chilli support to add Chilli.")
    eff = effective(db, tenant.id)
    lo, hi = topup_limits(eff)
    if amount % 100:
        raise errors.bad("Enter a whole number of rupees", "not_whole_rupees")
    if amount < lo:
        raise errors.bad(f"The minimum recharge is Rs {_indian(lo // 100)}", "below_min_topup")
    if amount > hi:
        raise errors.bad(f"The maximum recharge is Rs {_indian(hi // 100)} at a time", "above_max_topup")
    recent = db.scalar(select(func.count()).select_from(TopupOrder).where(
        TopupOrder.tenant_id == tenant.id, TopupOrder.created_at > utcnow() - timedelta(hours=1))) or 0
    if recent >= settings.chilli_intents_per_hour:
        raise errors.AppError(429, "too_many_recharges", "Too many recharge attempts. Please wait a little and try again.")
    provider = pl.provider()
    o = TopupOrder(id=uuid.uuid4(), tenant_id=tenant.id, provider="razorpay", amount_paise=amount,
                   bonus_paise=eff.bonus_for(amount), status="created", requested_by=requested_by,
                   expires_at=utcnow() + timedelta(minutes=max(settings.chilli_link_ttl_minutes, 16)))
    db.add(o)
    db.flush()
    link = provider.create_link(pl.LinkRequest(
        intent_id=str(o.id), tenant_id=str(tenant.id), amount_paise=amount,
        description=f"Chilli Agent recharge: {_indian(amount // 100)} Chilli", callback_url=settings.chilli_billing_return_url or None,
        expire_by=o.expires_at))
    o.provider_link_id, o.short_url = link.id, link.short_url
    db.flush()
    return o


def intent_view(o: TopupOrder, now: datetime | None = None) -> dict:
    now = now or utcnow()
    status = "expired" if o.status == "created" and o.expires_at is not None and o.expires_at < now else o.status
    return {"id": str(o.id), "status": status, "amount_paise": o.amount_paise, "chilli": chilli(o.amount_paise),
            "bonus_chilli": chilli(o.bonus_paise or 0), "payment_url": o.short_url if status == "created" else None,
            "expires_at": o.expires_at.isoformat() if o.expires_at else None,
            "created_at": o.created_at.isoformat() if o.created_at else None,
            "paid_at": o.paid_at.isoformat() if o.paid_at else None}


def razorpay_paid(db: Session, order: TopupOrder, payment_id: str, amount: int, raw: dict) -> tuple[WalletReceipt, bool]:
    """A verified Razorpay capture of `order`: credits once per payment id (and once per order). (receipt, newly credited)"""
    if amount != order.amount_paise:
        raise errors.conflict("Paid amount does not match the top-up order", "amount_mismatch")
    tenant = db.get(Tenant, order.tenant_id)
    w = lock(db, tenant)
    order = db.scalar(select(TopupOrder).where(TopupOrder.id == order.id).with_for_update().execution_options(populate_existing=True))
    if order.status == "paid":
        if order.provider_payment_id != payment_id:
            raise errors.conflict("Top-up order already paid by another payment", "order_already_paid")
        return db.get(WalletReceipt, order.receipt_id), False
    rec, _ = credit_topup(db, tenant, w, effective(db, tenant.id), amount, source="razorpay", actor="razorpay:webhook",
                          idem_key=f"rzp:{payment_id}", payment_ref=payment_id, note=f"Online recharge {order.id}")
    order.status, order.provider_payment_id, order.receipt_id, order.paid_at, order.raw = "paid", payment_id, rec.id, utcnow(), raw
    return rec, True


PAID_EVENTS = ("payment_link.paid", "payment.captured", "order.paid")


def handle_razorpay_event(db: Session, event_id: str, body: dict) -> dict:
    """One verified Razorpay webhook. Returns {outcome, ...}; never raises for a business reason (Razorpay would retry for days
    and finally switch the webhook off), the outcome is stored in razorpay_events instead.

    Credit rules: only payment_link.paid / payment.captured / order.paid; the payment must be captured (never failed or
    pending), in INR, and the amount Razorpay says was paid must equal the intent's amount; the intent must exist (found by
    notes.topup_order_id, the payment link id or reference_id) and belong to the tenant in the notes; each event id is handled
    once and each payment id is credited once (ledger idem key rzp:<payment id>), even when delivered concurrently."""
    ev = str(body.get("event") or "")[:40]
    pl = body.get("payload") or {}
    pay = (pl.get("payment") or {}).get("entity") or {}
    link = (pl.get("payment_link") or {}).get("entity") or {}
    order = (pl.get("order") or {}).get("entity") or {}
    payment_id = str(pay["id"])[:100] if pay.get("id") else None

    def record(outcome: str, intent: TopupOrder | None = None, amount: int | None = None) -> bool:
        res = db.execute(pg_insert(RazorpayEvent).values(
            event_id=event_id[:120], event=ev, payment_id=payment_id, topup_order_id=intent.id if intent else None,
            tenant_id=intent.tenant_id if intent else None, amount_paise=amount, outcome=outcome, received_at=utcnow())
            .on_conflict_do_nothing(index_elements=["event_id"]).returning(RazorpayEvent.id))
        return res.scalar() is not None  # False: this event id was already processed

    if ev not in PAID_EVENTS:
        record("ignored")
        return {"outcome": "ignored"}
    if not payment_id:
        record("ignored")
        return {"outcome": "ignored"}
    notes = {**(order.get("notes") or {}), **(link.get("notes") or {}), **(pay.get("notes") or {})}
    intent = None
    oid = notes.get("topup_order_id") or link.get("reference_id")
    try:
        if oid:
            intent = db.get(TopupOrder, uuid.UUID(str(oid)))
    except ValueError:
        intent = None
    if intent is None and link.get("id"):
        intent = db.scalar(select(TopupOrder).where(TopupOrder.provider_link_id == str(link["id"])))
    paid = pay.get("amount")
    if (pay.get("status") not in (None, "captured")) or (ev == "payment_link.paid" and link.get("status") not in (None, "paid")) \
            or (ev == "order.paid" and order.get("status") not in (None, "paid")):
        record("not_captured", intent, paid if isinstance(paid, int) else None)
        return {"outcome": "not_captured"}
    if intent is None:
        record("unknown_intent", None, paid if isinstance(paid, int) else None)
        log.warning("razorpay %s for payment %s matches no recharge intent", ev, payment_id)
        return {"outcome": "unknown_intent"}
    if not isinstance(paid, int) or str(pay.get("currency") or "INR").upper() != "INR" or paid != intent.amount_paise \
            or (notes.get("tenant_id") and str(notes["tenant_id"]) != str(intent.tenant_id)):
        if record("amount_mismatch", intent, paid if isinstance(paid, int) else None):
            log.error("razorpay %s: payment %s of %s does not match recharge %s (%s)", ev, payment_id, paid, intent.id, intent.amount_paise)
        return {"outcome": "amount_mismatch"}
    if not record("credited", intent, paid):  # event id seen before
        return {"outcome": "duplicate"}
    try:
        with db.begin_nested():
            rec, created = razorpay_paid(db, intent, payment_id, paid, body)
    except errors.AppError as e:  # the intent is already paid by ANOTHER payment: money in twice, owner refunds by hand
        db.execute(pg_update(RazorpayEvent).where(RazorpayEvent.event_id == event_id[:120]).values(outcome="duplicate_payment"))
        log.error("razorpay payment %s paid recharge %s which another payment already paid (%s)", payment_id, intent.id, e.code)
        return {"outcome": "duplicate_payment", "tenant_id": str(intent.tenant_id)}
    if not created:  # the same payment arrived under another event type / id: already credited
        db.execute(pg_update(RazorpayEvent).where(RazorpayEvent.event_id == event_id[:120]).values(outcome="duplicate"))
        return {"outcome": "duplicate"}
    return {"outcome": "credited", "receipt": rec.number, "tenant_id": str(intent.tenant_id), "order_id": str(intent.id),
            "amount_paise": paid, "payment_id": payment_id}


# ------------------------------------------------------------------ sweep: trial notices + conversion
def run_due(db: Session, now: datetime | None = None) -> dict:
    """Trial-ending notices (3 days, 1 day, ended; only the most recent one that is due) and conversion of finished PAYG
    trials to active subscriptions. Idempotent; safe from several workers (notices are deduplicated)."""
    from app.services import entitlements as ent
    now = now or utcnow()
    out = {"notices": 0, "converted": 0}
    rows = db.scalars(select(Wallet).where(Wallet.trial_ends_at > now - timedelta(days=2),
                                           Wallet.trial_ends_at <= now + timedelta(days=3))).all()
    for w in rows:
        tenant = db.get(Tenant, w.tenant_id)
        if tenant is None or tenant.status != "active":
            continue
        eff = effective(db, tenant.id)
        if not eff.metered:
            continue
        end = w.trial_ends_at
        kind = "trial_ended" if now >= end else "trial_ends_1d" if now >= end - timedelta(days=1) else "trial_ends_3d"
        out["notices"] += notice(db, tenant, kind, f"{kind}:{end.isoformat()}", w=w, eff=eff)
    subs = db.scalars(select(Subscription).where(Subscription.status == "trialing", Subscription.trial_end <= now)).all()
    for sub in subs:
        tenant = db.get(Tenant, sub.tenant_id)
        if tenant is None or not effective(db, tenant.id, sub.plan_id).metered:
            continue  # subscription plans: trial end switches features off (entitlements.sub_entitled), as before

        def convert(s=sub):
            s.status, s.current_period_start = "active", s.trial_end
        ent.tracked_change(db, tenant, "trial_converted_payg", "system:billing", "PAYG trial ended", convert)
        out["converted"] += 1
    db.flush()
    return out


# ------------------------------------------------------------------ statements
def month_bounds(month: str) -> tuple[datetime, datetime]:
    try:
        y, m = (int(x) for x in month.split("-"))
        tz = ZoneInfo(settings.billing_timezone)
        start = datetime(y, m, 1, tzinfo=tz)
    except (ValueError, TypeError):
        raise errors.bad("month must be YYYY-MM", "invalid_month")
    end = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=tz)
    return start, end


def _balance_before(db: Session, tenant_id, at: datetime) -> int:
    return db.scalar(select(WalletLedger.balance_after_paise).where(WalletLedger.tenant_id == tenant_id, WalletLedger.at < at)
                     .order_by(WalletLedger.id.desc()).limit(1)) or 0


def statement(db: Session, tenant: Tenant, month: str) -> dict:
    """Monthly usage statement. Money is by ledger time, so opening + movements = closing exactly; bill counts are by the
    time pos-service reported them (when they were charged): an offline bill synced next month counts next month."""
    start, end = month_bounds(month)
    sums = dict(db.execute(select(WalletLedger.kind, func.coalesce(func.sum(WalletLedger.amount_paise), 0)).where(
        WalletLedger.tenant_id == tenant.id, WalletLedger.at >= start, WalletLedger.at < end).group_by(WalletLedger.kind)).all())
    gst = db.scalar(select(func.coalesce(func.sum(WalletLedger.fee_gst_paise), 0)).where(
        WalletLedger.tenant_id == tenant.id, WalletLedger.at >= start, WalletLedger.at < end, WalletLedger.kind == "bill_fee")) or 0
    gst_back = db.scalar(select(func.coalesce(func.sum(WalletLedger.fee_gst_paise), 0)).where(
        WalletLedger.tenant_id == tenant.id, WalletLedger.at >= start, WalletLedger.at < end,
        WalletLedger.kind == "void_credit_back")) or 0
    outcomes = dict(db.execute(select(UsageEvent.outcome, func.count()).where(
        UsageEvent.tenant_id == tenant.id, UsageEvent.received_at >= start, UsageEvent.received_at < end)
        .group_by(UsageEvent.outcome)).all())
    receipts = db.scalars(select(WalletReceipt).where(WalletReceipt.tenant_id == tenant.id, WalletReceipt.created_at >= start,
                                                      WalletReceipt.created_at < end).order_by(WalletReceipt.created_at)).all()
    opening, closing = _balance_before(db, tenant.id, start), _balance_before(db, tenant.id, end)
    finalized = sum(v for k, v in outcomes.items() if k in ("charged", "trial", "zero_total", "not_metered", "free", "voided_before_sync"))
    return {"tenant_id": str(tenant.id), "tenant": tenant.display_name, "month": month, "timezone": settings.billing_timezone,
            "period_start": start.isoformat(), "period_end": end.isoformat(),
            "opening_balance_paise": opening, "closing_balance_paise": closing,
            "bills": {"reported": finalized, "charged": outcomes.get("charged", 0), "free_trial": outcomes.get("trial", 0),
                      "zero_total": outcomes.get("zero_total", 0), "voided": outcomes.get("credited_back", 0) + outcomes.get("nothing_to_credit", 0),
                      "credited_back": outcomes.get("credited_back", 0)},
            "fees_paise": -int(sums.get("bill_fee", 0)), "fee_credit_backs_paise": int(sums.get("void_credit_back", 0)),
            "net_fees_paise": -int(sums.get("bill_fee", 0)) - int(sums.get("void_credit_back", 0)),
            "gst_in_net_fees_paise": int(gst) - int(gst_back),
            "topups_paise": int(sums.get("topup", 0)), "promo_paise": int(sums.get("promo", 0)),
            "adjustments_paise": int(sums.get("adjustment", 0)),
            "receipts": [{"id": str(r.id), "number": r.number, "amount_paise": r.amount_paise, "bonus_paise": r.bonus_paise,
                          "created_at": r.created_at.isoformat()} for r in receipts],
            "tax_notice": "GST on platform fees is computed from configuration (PAYG_FEE_GST_MODE, GST_RATE_BPS) and must be verified by a CA."}
