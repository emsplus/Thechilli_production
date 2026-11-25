"""Online payments for a bill through payments-service (docs/PAYMENTS_INTEGRATION.md).

The rule everything here serves: **a bill's `payments` row is created only from money payments-service reports as captured**
(status succeeded / partially_refunded / refunded, `captured_amount` > 0), read by THIS service over the authenticated
service-to-service channel. No request field from a client ever says "it was paid".

Flow: start -> row `creating` is committed BEFORE the network call (so a timeout after the provider succeeded cannot lose the
attempt; the retry uses the same derived idempotency key and gets the same intent back) -> poll / sync -> `apply_remote`
turns newly captured money into a bill payment, under the bill's row lock, exactly once per captured amount.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.core import Bill, OnlinePayment, Payment, PaymentMethod, PaymentProviderAccount
from app.services import audit, billing, outlets
from app.services.payments_client import (
    PAID_STATUSES, PaymentsClient, PaymentsRejected, PaymentsUnavailable, RemoteIntent, secret_prefix_for, tenant_id_for,
)

log = logging.getLogger("app.online_payments")
_PAYMENT_NS = uuid.UUID("5d1c9c53-3f2e-4a8e-9a55-0c1f6f1b7a10")  # namespace of the deterministic bill-payment keys
OPEN_STATUSES = ("creating", "created", "pending")


def err(status: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message, **extra})


def require_client(client: PaymentsClient | None) -> PaymentsClient:
    if client is None:
        raise err(503, "online_payments_not_configured",
                  "Online payments are not set up on this server. Cash and card-terminal payments still work.")
    return client


def unavailable(e: Exception, **extra) -> HTTPException:
    return err(503, "online_payments_unavailable",
               "The payment service cannot be reached right now. Nothing was lost: retry in a moment, or take cash.", **extra)


def to_minor(amount: Decimal) -> int:
    return int((amount * 100).to_integral_exact())


def to_major(minor: int) -> Decimal:
    return (Decimal(minor) / 100).quantize(Decimal("0.01"))


def remote_key(op: OnlinePayment) -> str:
    return f"pos:{op.bill_id}:{op.idempotency_key}"  # 8..128 chars, unique per attempt


# ------------------------------------------------------------------------------------------------ provider account (setup)
def active_account(db: Session, restaurant_id: uuid.UUID) -> PaymentProviderAccount | None:
    return db.scalar(select(PaymentProviderAccount).where(
        PaymentProviderAccount.restaurant_id == restaurant_id, PaymentProviderAccount.active.is_(True)))


def setup_account(db: Session, p, client: PaymentsClient | None, *, provider: str, key_id_ref: str, key_secret_ref: str,
                  webhook_secret_ref: str) -> PaymentProviderAccount:
    """Registers the restaurant's provider account in payments-service. Only env var NAMES are exchanged and stored; they
    must live in the restaurant's namespace (checked here for a clear early error and again by payments-service)."""
    client = require_client(client)
    prefix = secret_prefix_for(p.restaurant_id)
    for ref in (key_id_ref, key_secret_ref, webhook_secret_ref):
        if not ref.startswith(prefix) or len(ref) == len(prefix):
            raise err(422, "invalid_secret_ref", f"Secret references are environment variable names starting with {prefix}",
                      prefix=prefix)
    try:
        remote = client.create_provider_account(tenant_id_for(p.restaurant_id), provider=provider, key_id_ref=key_id_ref,
                                                key_secret_ref=key_secret_ref, webhook_secret_ref=webhook_secret_ref)
    except PaymentsRejected as e:
        raise err(422 if e.status == 422 else 502, "payments_rejected", e.message or "payments-service refused the account")
    except PaymentsUnavailable as e:
        raise unavailable(e)
    for old in db.scalars(select(PaymentProviderAccount).where(
            PaymentProviderAccount.restaurant_id == p.restaurant_id, PaymentProviderAccount.provider == provider,
            PaymentProviderAccount.active.is_(True))):
        old.active = False
    db.flush()  # the partial unique index allows one active account per (restaurant, provider)
    acc = PaymentProviderAccount(restaurant_id=p.restaurant_id, provider=provider, remote_account_id=remote.id,
                                 key_id_ref=key_id_ref, key_secret_ref=key_secret_ref, webhook_secret_ref=webhook_secret_ref,
                                 created_by=p.user_id)
    db.add(acc)
    audit.record(db, p, "payments.provider_account", "restaurant", p.restaurant_id,
                 {"provider": provider, "remote_account_id": str(remote.id), "key_id_ref": key_id_ref})
    db.commit()
    return acc


# ------------------------------------------------------------------------------------------------ start
def _load_bill_locked(db: Session, p, bill_id: uuid.UUID) -> Bill:
    billing.lock_activity(db, billing.row_outlet(db, Bill, bill_id, p.restaurant_id))
    bill = db.get(Bill, bill_id, with_for_update=True)  # the same lock add_payment takes: serialises with cash payments
    if not bill or bill.restaurant_id != p.restaurant_id or not outlets.visible(p, bill):
        raise HTTPException(404, "Bill not found")
    return bill


def load(db: Session, p, op_id: uuid.UUID) -> OnlinePayment:
    op = db.get(OnlinePayment, op_id)
    if not op or op.restaurant_id != p.restaurant_id or not outlets.visible(p, op):
        raise HTTPException(404, "Online payment not found")
    return op


def due_of(bill: Bill) -> Decimal:
    return bill.total - billing.paid_total(bill)


def start(db: Session, p, client: PaymentsClient | None, bill_id: uuid.UUID, key: uuid.UUID, method: str,
          amount: Decimal | None, description: str) -> tuple[OnlinePayment, bool]:
    """Creates (or replays) the attempt. Returns (row, created). Idempotent per (tenant, key): a replay with the same key
    returns the same attempt and, if payments-service was not reached the first time, finishes creating it."""
    client = require_client(client)
    bill = _load_bill_locked(db, p, bill_id)
    prior = db.scalar(select(OnlinePayment).where(OnlinePayment.restaurant_id == p.restaurant_id,
                                                  OnlinePayment.idempotency_key == key))
    if prior is not None:
        if prior.bill_id != bill.id:
            raise HTTPException(409, "This idempotency key was already used for a different bill")
        if prior.method != method or (amount is not None and billing.money(amount) != prior.amount):
            raise HTTPException(409, "This idempotency key was already used for a different request")
        db.rollback()  # release the bill lock before talking to the network
        return refresh(db, p, client, prior.id), False
    if bill.status != "active":
        raise HTTPException(409, f"{bill.invoice_number} was corrected and replaced by a newer invoice; pay that one")
    due = due_of(bill)
    if due <= 0:
        raise err(409, "bill_already_paid", "This bill is already fully paid")
    amount = due if amount is None else billing.money(amount)
    if amount <= 0:
        raise HTTPException(422, "Amount must be positive")
    if amount > due:
        raise err(409, "exceeds_amount_due", f"Amount exceeds what is still due on this bill ({due})", due=str(due))
    acc = active_account(db, p.restaurant_id)
    if acc is None:
        raise err(409, "no_provider_account", "No payment provider account is set up for this restaurant (owner: PUT /payments/provider-account)")
    op = OnlinePayment(restaurant_id=p.restaurant_id, outlet_id=bill.outlet_id, bill_id=bill.id, idempotency_key=key,
                       method=method, amount=amount, currency=bill.currency, description=description,
                       provider_account_id=acc.remote_account_id, status="creating", created_by=p.user_id)
    db.add(op)
    audit.record(db, p, "online_payment.start", "bill", bill.id, {"amount": str(amount), "method": method})
    try:
        db.commit()  # BEFORE the network call: a lost answer must never lose the attempt
    except IntegrityError:  # the same key arrived concurrently on another bill / request
        db.rollback()
        raise HTTPException(409, "This idempotency key was already used for a different request")
    return refresh(db, p, client, op.id), True


# ------------------------------------------------------------------------------------------------ talk to payments-service
def _create_remote(db: Session, p, client: PaymentsClient, op: OnlinePayment) -> None:
    """(Re)issues the create call with the derived idempotency key. Same key => same intent, so this is safe to repeat after
    a timeout even if the first call reached the provider."""
    tid = tenant_id_for(op.restaurant_id)
    try:
        remote = client.create_intent(tid, idempotency_key=remote_key(op), amount=to_minor(op.amount), currency=op.currency,
                                      method=op.method, reference=str(op.bill_id), description=op.description,
                                      provider_account_id=op.provider_account_id)
    except PaymentsRejected as e:
        op.status, op.last_error = "failed", f"{e.code}: {e.message}"[:300]
        db.commit()
        raise err(422 if e.status < 500 else 502, "payments_rejected", e.message or "payments-service refused the payment",
                  online_payment_id=str(op.id))
    except PaymentsUnavailable as e:
        op.last_error = str(e)[:300]
        db.commit()
        raise unavailable(e, online_payment_id=str(op.id))
    op.remote_intent_id = remote.id
    op.payment_url, op.qr_payload = remote.payment_url, remote.qr_payload
    op.status = remote.status if remote.status != "created" else "pending"
    op.last_error = None
    op.last_synced_at = datetime.now(timezone.utc)
    db.commit()


def refresh(db: Session, p, client: PaymentsClient | None, op_id: uuid.UUID, *, deep: bool = False) -> OnlinePayment:
    """Brings the attempt up to date from payments-service (`deep` = ask the provider via POST /sync, otherwise read the
    service's own state) and applies newly captured money to the bill. Raises 503 when the service cannot be reached; the
    row is left untouched and the call can simply be repeated."""
    op = load(db, p, op_id)  # 404 for another tenant's id before anything else
    client = require_client(client)
    if op.remote_intent_id is None:
        _create_remote(db, p, client, op)  # the first call's outcome was unknown: finish (or discover) it by key
        op = load(db, p, op_id)
        if op.remote_intent_id is None:
            return op
    tid = tenant_id_for(op.restaurant_id)
    try:
        remote = (client.sync_intent if deep else client.get_intent)(tid, op.remote_intent_id)
    except PaymentsRejected as e:
        raise err(502, "payments_rejected", e.message or "payments-service refused the request", online_payment_id=str(op.id))
    except PaymentsUnavailable as e:
        op.last_error = str(e)[:300]
        db.commit()
        raise unavailable(e, online_payment_id=str(op.id))
    return apply_remote(db, p, op.id, remote)


def refresh_open(db: Session, p, client: PaymentsClient | None, bill_id: uuid.UUID) -> list[str]:
    """Best effort for every attempt on the bill that could still receive money (and recently failed ones: a late success is
    legal). Returns the ids it could not refresh. Never raises for an unreachable service."""
    stale = []
    if client is None:
        return stale
    ids = db.scalars(select(OnlinePayment.id).where(
        OnlinePayment.restaurant_id == p.restaurant_id, OnlinePayment.bill_id == bill_id,
        OnlinePayment.status.in_((*OPEN_STATUSES, "failed")))).all()
    for oid in ids:
        try:
            refresh(db, p, client, oid)
        except HTTPException:
            db.rollback()
            stale.append(str(oid))
    return stale


def apply_remote(db: Session, p, op_id: uuid.UUID, remote: RemoteIntent) -> OnlinePayment:
    """The only place money reaches a bill. Idempotent: replaying the same remote state changes nothing (captured amount only
    ever grows; each increase maps to one deterministic Payment key)."""
    bill_id = db.scalar(select(OnlinePayment.bill_id).where(OnlinePayment.id == op_id))
    bill = _load_bill_locked(db, p, bill_id)
    op = db.get(OnlinePayment, op_id, with_for_update=True)
    if remote.id != op.remote_intent_id or remote.reference != str(op.bill_id) or remote.currency != op.currency:
        log.error("online payment %s: payments-service answered for another intent/reference/currency", op.id)
        db.rollback()
        raise err(502, "payments_mismatch", "payments-service answered for a different payment; nothing was recorded")
    op.last_synced_at = datetime.now(timezone.utc)
    op.last_error = None
    captured = to_major(remote.captured_amount) if remote.status in PAID_STATUSES else Decimal("0")
    if captured > op.captured_amount:  # money only moves forward: a stale answer cannot take it back
        delta = captured - op.captured_amount
        due = max(due_of(bill), Decimal("0")) if bill.status == "active" else Decimal("0")
        applied = min(delta, due)
        if applied > 0:
            pay_key = uuid.uuid5(_PAYMENT_NS, f"{op.id}:{remote.captured_amount}")
            if not db.scalar(select(Payment.id).where(Payment.restaurant_id == op.restaurant_id, Payment.idempotency_key == pay_key)):
                db.add(Payment(restaurant_id=op.restaurant_id, outlet_id=bill.outlet_id, bill_id=bill.id, idempotency_key=pay_key,
                               method=PaymentMethod.other, amount=applied, created_by=op.created_by, created_at=billing.db_now(db)))
            audit.record(db, p, "payment.add", "bill", bill.id, {"amount": str(applied), "method": "other", "online_payment": str(op.id)})
        op.applied_amount += applied
        op.captured_amount = captured
        if delta > applied:
            op.unallocated_amount += delta - applied
            audit.record(db, p, "online_payment.unallocated", "bill", bill.id,
                         {"online_payment": str(op.id), "amount": str(delta - applied), "bill_status": bill.status})
            log.warning("online payment %s: %s received beyond what the bill owed (unallocated)", op.id, delta - applied)
    if op.captured_amount == 0 or remote.status in PAID_STATUSES:  # a stale "pending/failed" after money was seen keeps the paid state
        op.status = remote.status
    db.commit()
    return op


def summary(db: Session, p, client: PaymentsClient | None, bill_id: uuid.UUID, *, refresh_first: bool = True) -> dict:
    bill = db.get(Bill, bill_id)
    if not bill or bill.restaurant_id != p.restaurant_id or not outlets.visible(p, bill):
        raise HTTPException(404, "Bill not found")
    stale = refresh_open(db, p, client, bill_id) if refresh_first else []
    db.expire_all()
    bill = db.get(Bill, bill_id)
    ops = list(db.scalars(select(OnlinePayment).where(OnlinePayment.restaurant_id == p.restaurant_id,
                                                      OnlinePayment.bill_id == bill_id).order_by(OnlinePayment.created_at)))
    extra_remote = []
    if client is not None and ops:
        mine = {o.remote_intent_id for o in ops if o.remote_intent_id}
        try:
            extra_remote = [{"online_payment_id": str(next(o.id for o in ops if o.remote_intent_id == u.intent_id)),
                             "provider_payment_id": u.provider_payment_id, "amount": str(to_major(u.amount)),
                             "refunded": u.refunded}
                            for u in client.list_unallocated(tenant_id_for(p.restaurant_id)) if u.intent_id in mine]
        except (PaymentsUnavailable, PaymentsRejected):
            pass
    unalloc = sum((o.unallocated_amount for o in ops), Decimal("0"))
    return {"bill_id": bill.id, "total": bill.total, "paid": billing.paid_total(bill), "due": due_of(bill),
            "pending_online": sum((o.amount for o in ops if o.status in OPEN_STATUSES), Decimal("0")),
            "unallocated_amount": unalloc, "remote_unallocated": extra_remote, "stale": stale, "items": ops}
