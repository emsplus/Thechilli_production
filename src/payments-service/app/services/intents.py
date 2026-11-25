import hashlib
import json
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ProviderError
from app.models import LedgerEntry, PaymentIntent, ProviderAccount, Refund
from app.providers import registry
from app.schemas import IntentIn, RefundIn, UnallocatedRefundIn
from app.services.audit import audit
from app.services.payments import (
    PAID,
    apply_capture,
    apply_failure,
    apply_refund_result,
    reserved_refund_total,
    transition,
)
from app.services.webhooks import reprocess_unmatched


def _hash(obj: dict) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


def pick_account(db: Session, tenant_id: str, account_id: uuid.UUID | None) -> ProviderAccount:
    q = select(ProviderAccount).where(ProviderAccount.tenant_id == tenant_id, ProviderAccount.active.is_(True))
    if account_id:
        q = q.where(ProviderAccount.id == account_id)
    acc = db.scalars(q.order_by(ProviderAccount.created_at)).first()
    if not acc:
        raise NotFound("no active provider account for this tenant", code="no_provider_account")
    return acc


def get_intent(db: Session, tenant_id: str, intent_id: uuid.UUID, lock: bool = False) -> PaymentIntent:
    q = select(PaymentIntent).where(PaymentIntent.id == intent_id, PaymentIntent.tenant_id == tenant_id)
    row = db.scalars(q.with_for_update() if lock else q).first()
    if not row:
        raise NotFound("payment intent not found")  # also what other tenants' ids look like
    return row


def _collect(db: Session, intent: PaymentIntent, acc: ProviderAccount) -> None:
    """Create the provider QR/link exactly once per intent. The row lock is the in-progress marker: a concurrent
    request with the same key blocks here, then sees provider_ref set and returns without a second provider call."""
    intent = db.scalars(select(PaymentIntent).where(PaymentIntent.id == intent.id, PaymentIntent.tenant_id == intent.tenant_id)
                        .with_for_update().execution_options(populate_existing=True)).one()
    if intent.provider_ref or intent.status != "created":
        db.commit()
        return
    provider = registry.get_provider(acc)
    if intent.method == "upi_qr":
        res = provider.create_upi_qr(intent_id=str(intent.id), amount=intent.amount, currency=intent.currency,
                                     description=intent.description or intent.reference)
    else:
        res = provider.create_payment_link(intent_id=str(intent.id), amount=intent.amount, currency=intent.currency,
                                           description=intent.description or intent.reference,
                                           reference=intent.reference)
    intent.provider_ref, intent.payment_url, intent.qr_payload = res.provider_ref, res.payment_url, res.qr_payload
    transition(intent, "pending")
    audit(db, intent.tenant_id, "service", "intent_pending", intent.id, provider_ref=res.provider_ref)
    db.commit()


def _reprocess_after_create(db: Session, tenant_id: str) -> None:
    """A webhook can beat our own commit of the provider ref: pick up anything that was held as unmatched."""
    try:
        reprocess_unmatched(db, tenant_id, limit=20)
    except Exception:  # never fail intent creation because of a retry of someone else's event
        db.rollback()
        logging.getLogger(__name__).exception("webhook reprocess failed")


def create_intent(db: Session, tenant_id: str, key: str, body: IntentIn) -> tuple[PaymentIntent, bool]:
    """Returns (intent, created_now). Same key + same body replays; same key + different body is 409."""
    acc = pick_account(db, tenant_id, body.provider_account_id)
    rh = _hash(body.model_dump(mode="json", exclude={"provider_account_id"}) | {"account": str(acc.id)})
    intent = PaymentIntent(
        tenant_id=tenant_id, idempotency_key=key, request_hash=rh, provider_account_id=acc.id, method=body.method,
        reference=body.reference, amount=body.amount, currency=body.currency, description=body.description)
    try:
        with db.begin_nested():
            db.add(intent)
            db.flush()
    except IntegrityError:
        existing = db.scalars(select(PaymentIntent).where(
            PaymentIntent.tenant_id == tenant_id, PaymentIntent.idempotency_key == key).with_for_update()).one()
        if existing.request_hash != rh:
            raise Conflict("Idempotency-Key was already used with a different request", code="idempotency_mismatch")
        db.commit()
        if existing.status == "created" and not existing.provider_ref:
            _collect(db, existing, acc)  # waits on the in-flight attempt, or retries one that died
        return existing, False
    audit(db, tenant_id, "service", "intent_created", intent.id, reference=body.reference, amount=body.amount)
    db.commit()  # reserve the key before talking to the provider
    _collect(db, intent, acc)
    _reprocess_after_create(db, tenant_id)
    return intent, True


def _sync_refund(db: Session, intent: PaymentIntent, provider, refund: Refund) -> None:
    refund = db.scalars(select(Refund).where(Refund.id == refund.id, Refund.tenant_id == intent.tenant_id)
                        .with_for_update().execution_options(populate_existing=True)).one()
    if refund.status != "pending":
        return
    if refund.provider_refund_id:
        pr = provider.fetch_refund(refund.provider_refund_id)
    else:  # response was lost: find it by the deterministic receipt
        pr = provider.find_refund_by_receipt(refund.provider_payment_id or intent.provider_payment_id, refund.receipt)
        if pr is None:
            return  # provider has nothing for this receipt; a retry with the same key re-dispatches it
        refund.provider_refund_id = pr.provider_refund_id
    if pr.status in ("processed", "failed"):
        apply_refund_result(db, intent, refund, ok=pr.status == "processed",
                            evidence_id=f"sync:{pr.provider_refund_id}", actor="provider_sync")


def sync_intent(db: Session, tenant_id: str, intent_id: uuid.UUID) -> PaymentIntent:
    """Ask the provider (authenticated calls) what happened to this intent's QR/link and refunds. The provider's
    answer is the evidence; nothing is inferred locally."""
    intent = get_intent(db, tenant_id, intent_id, lock=True)
    acc = db.scalars(select(ProviderAccount).where(ProviderAccount.id == intent.provider_account_id,
                                                   ProviderAccount.tenant_id == tenant_id)).one()
    provider = registry.get_provider(acc)
    payments = provider.list_collection_payments(intent.method, intent.provider_ref) if intent.provider_ref else []
    if intent.status not in PAID and intent.provider_payment_id and intent.provider_payment_id not in {p.provider_payment_id for p in payments}:
        payments.append(provider.fetch_payment(intent.provider_payment_id))  # attempt we saw in a webhook
    for p in payments:
        if p.status == "captured":
            apply_capture(db, intent, payment_id=p.provider_payment_id, amount=p.amount, currency=p.currency,
                          evidence_id=f"sync:{p.provider_payment_id}", actor="provider_sync")
    if intent.status not in PAID:
        failed = next((p for p in payments if p.status == "failed"), None)
        if failed:
            apply_failure(db, intent, payment_id=failed.provider_payment_id,
                          evidence_id=f"sync:{failed.provider_payment_id}", actor="provider_sync")
    for refund in db.scalars(select(Refund).where(Refund.intent_id == intent.id, Refund.tenant_id == tenant_id,
                                                  Refund.status == "pending")).all():
        _sync_refund(db, intent, provider, refund)
    db.commit()
    _reprocess_after_create(db, tenant_id)
    return intent


def refund_receipt(tenant_id: str, key: str) -> str:
    return "rf_" + hashlib.sha256(f"{tenant_id}\0{key}".encode()).hexdigest()[:36]


def _dispatch_refund(db: Session, intent: PaymentIntent, refund: Refund) -> None:
    """Talk to the provider for a refund that is already committed as pending. Idempotent: if the provider
    already holds a refund for this receipt (earlier attempt timed out after the provider acted), adopt it."""
    # Row lock so a concurrent retry waits for this attempt instead of racing it to the provider.
    refund = db.scalars(select(Refund).where(Refund.id == refund.id, Refund.tenant_id == intent.tenant_id)
                        .with_for_update().execution_options(populate_existing=True)).one()
    if refund.status != "pending" or refund.provider_refund_id:
        return
    acc = db.scalars(select(ProviderAccount).where(ProviderAccount.id == intent.provider_account_id,
                                                   ProviderAccount.tenant_id == intent.tenant_id)).one()
    provider = registry.get_provider(acc)
    pay_id = refund.provider_payment_id or intent.provider_payment_id
    try:
        pr = provider.find_refund_by_receipt(pay_id, refund.receipt)
        if pr is None:
            pr = provider.create_refund(provider_payment_id=pay_id, amount=refund.amount,
                                        refund_id=str(refund.id), receipt=refund.receipt)
    except ProviderError as e:
        if e.definitive:  # provider said no: nothing was created, release the reserved balance
            apply_refund_result(db, intent, refund, ok=False, evidence_id="api:rejected", actor="service")
            db.commit()
        else:
            db.rollback()  # unknown outcome: keep the committed pending row as the reconciliation anchor
        raise
    refund.provider_refund_id = pr.provider_refund_id
    if pr.status in ("processed", "failed"):  # authenticated synchronous answer from the provider
        apply_refund_result(db, intent, refund, ok=pr.status == "processed",
                            evidence_id=f"api:{pr.provider_refund_id}", actor="service")
    db.commit()


def create_refund(db: Session, tenant_id: str, intent_id: uuid.UUID, key: str, body: RefundIn) -> tuple[Refund, bool]:
    intent = get_intent(db, tenant_id, intent_id, lock=True)  # row lock serialises refunds per intent
    rh = _hash(body.model_dump())
    existing = db.scalars(select(Refund).where(Refund.tenant_id == tenant_id, Refund.idempotency_key == key)).first()
    if existing:
        if existing.request_hash != rh or existing.intent_id != intent.id:
            raise Conflict("Idempotency-Key was already used with a different request", code="idempotency_mismatch")
        db.commit()  # release the intent lock before (possibly) talking to the provider
        if existing.status == "pending" and not existing.provider_refund_id:
            _dispatch_refund(db, intent, existing)  # an earlier attempt's outcome is unknown: reconcile
        return existing, False
    if intent.status not in ("succeeded", "partially_refunded"):
        raise Conflict(f"cannot refund a payment in status {intent.status}", code="not_refundable")
    if reserved_refund_total(db, intent.id) + body.amount > intent.captured_amount:
        raise Conflict("refund exceeds the refundable balance", code="refund_exceeds_balance")
    refund = Refund(tenant_id=tenant_id, intent_id=intent.id, idempotency_key=key, request_hash=rh,
                    amount=body.amount, reason=body.reason, id=uuid.uuid4(), receipt=refund_receipt(tenant_id, key))
    db.add(refund)
    audit(db, tenant_id, "service", "refund_requested", intent.id, refund_id=str(refund.id), amount=body.amount)
    db.commit()  # the pending row exists (and reserves the balance) BEFORE the provider is called
    _dispatch_refund(db, intent, refund)
    return refund, True


def unallocated_payments(db: Session, tenant_id: str) -> list[dict]:
    rows = db.scalars(select(LedgerEntry).where(
        LedgerEntry.tenant_id == tenant_id, LedgerEntry.entry_type == "unallocated").order_by(LedgerEntry.created_at)).all()
    out = []
    for e in rows:
        refunded = db.scalar(select(Refund.id).where(
            Refund.tenant_id == tenant_id, Refund.kind == "unallocated", Refund.provider_payment_id == e.provider_txn_id,
            Refund.status.in_(("pending", "succeeded"))).limit(1))
        out.append({"intent_id": e.intent_id, "provider_payment_id": e.provider_txn_id, "amount": e.amount,
                    "currency": e.currency, "refunded": refunded is not None, "created_at": e.created_at})
    return out


def refund_unallocated(db: Session, tenant_id: str, intent_id: uuid.UUID, payment_id: str, key: str,
                       body: UnallocatedRefundIn) -> tuple[Refund, bool]:
    """Return an unallocated payment in full. Same pending-first / receipt-reconciled flow as intent refunds."""
    intent = get_intent(db, tenant_id, intent_id, lock=True)
    rh = _hash(body.model_dump() | {"payment_id": payment_id})
    existing = db.scalars(select(Refund).where(Refund.tenant_id == tenant_id, Refund.idempotency_key == key)).first()
    if existing:
        if existing.request_hash != rh or existing.intent_id != intent.id:
            raise Conflict("Idempotency-Key was already used with a different request", code="idempotency_mismatch")
        db.commit()
        if existing.status == "pending" and not existing.provider_refund_id:
            _dispatch_refund(db, intent, existing)
        return existing, False
    entry = db.scalars(select(LedgerEntry).where(
        LedgerEntry.tenant_id == tenant_id, LedgerEntry.intent_id == intent.id,
        LedgerEntry.entry_type == "unallocated", LedgerEntry.provider_txn_id == payment_id)).first()
    if not entry:
        raise NotFound("no unallocated payment with that id on this intent")
    if db.scalar(select(Refund.id).where(
            Refund.tenant_id == tenant_id, Refund.kind == "unallocated", Refund.provider_payment_id == payment_id,
            Refund.status.in_(("pending", "succeeded"))).limit(1)):
        raise Conflict("this unallocated payment is already refunded or being refunded", code="already_refunded")
    refund = Refund(tenant_id=tenant_id, intent_id=intent.id, idempotency_key=key, request_hash=rh,
                    amount=entry.amount, reason=body.reason, id=uuid.uuid4(), kind="unallocated",
                    provider_payment_id=payment_id, receipt=refund_receipt(tenant_id, key))
    db.add(refund)
    audit(db, tenant_id, "service", "unallocated_refund_requested", intent.id, refund_id=str(refund.id),
          payment_id=payment_id, amount=entry.amount)
    db.commit()
    _dispatch_refund(db, intent, refund)
    return refund, True
