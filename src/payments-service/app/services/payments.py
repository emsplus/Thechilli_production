"""State machine + evidence application. The ONLY code paths that move an intent to succeeded/refunded are
apply_capture (verified webhook or authenticated provider fetch) and apply_refund_result (same)."""
import logging
import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.models import LedgerEntry, PaymentIntent, Refund
from app.services.audit import audit

alerts = logging.getLogger("payments.alerts")

TRANSITIONS = {
    "created": {"pending", "failed"},
    "pending": {"succeeded", "failed"},
    "failed": {"succeeded", "pending"},  # a failed attempt can be followed by a successful one on the same QR/link
    "succeeded": {"partially_refunded", "refunded"},
    "partially_refunded": {"partially_refunded", "refunded"},
    "refunded": set(),
}
PAID = {"succeeded", "partially_refunded", "refunded"}


def transition(intent: PaymentIntent, new: str) -> None:
    if new not in TRANSITIONS[intent.status]:
        raise AppError(f"illegal transition {intent.status} -> {new}", code="illegal_transition", status=409)
    intent.status = new


def record_unallocated(db: Session, intent: PaymentIntent, *, payment_id: str, amount: int, currency: str,
                       evidence_id: str, actor: str, reason: str) -> str:
    """Money the provider captured that does not settle this intent (under/over/extra payment, wrong currency).
    It is booked in the ledger as 'unallocated' (never as the intent's payment), audited, and alerted on, and it can
    be returned through the unallocated-refund path."""
    seen = db.scalars(select(LedgerEntry).where(
        LedgerEntry.tenant_id == intent.tenant_id, LedgerEntry.entry_type == "unallocated",
        LedgerEntry.provider_txn_id == payment_id)).first()
    if seen:
        return "unallocated"  # redelivery / re-sync of the same provider payment
    db.add(LedgerEntry(tenant_id=intent.tenant_id, intent_id=intent.id, entry_type="unallocated", amount=amount,
                       currency=currency, provider_txn_id=payment_id, evidence_event_id=evidence_id))
    audit(db, intent.tenant_id, actor, "unallocated_payment", intent.id, payment_id=payment_id, amount=amount,
          currency=currency, expected_amount=intent.amount, reason=reason, evidence=evidence_id)
    alerts.error("unallocated_payment tenant=%s intent=%s payment=%s amount=%s %s expected=%s reason=%s",
                 intent.tenant_id, intent.id, payment_id, amount, currency, intent.amount, reason)
    return "unallocated"


def apply_capture(db: Session, intent: PaymentIntent, *, payment_id: str, amount: int, currency: str,
                  evidence_id: str, actor: str) -> str:
    """Record a capture backed by verified provider evidence. Returns an outcome label."""
    if intent.status in PAID:
        if payment_id != intent.provider_payment_id:
            record_unallocated(db, intent, payment_id=payment_id, amount=amount, currency=currency,
                               evidence_id=evidence_id, actor=actor, reason="extra_payment")
            return "extra_payment_flagged"
        return "already_succeeded"
    if amount != intent.amount or currency != intent.currency:
        return record_unallocated(db, intent, payment_id=payment_id, amount=amount, currency=currency,
                                  evidence_id=evidence_id, actor=actor,
                                  reason="underpayment" if currency == intent.currency and amount < intent.amount
                                  else "overpayment" if currency == intent.currency else "currency_mismatch")
    if intent.status == "created":
        transition(intent, "pending")  # captured before we recorded the provider ref; still legal evidence
    transition(intent, "succeeded")
    intent.provider_payment_id = payment_id
    intent.captured_amount = amount
    db.add(LedgerEntry(tenant_id=intent.tenant_id, intent_id=intent.id, entry_type="payment", amount=amount,
                       currency=currency, provider_txn_id=payment_id, evidence_event_id=evidence_id))
    audit(db, intent.tenant_id, actor, "payment_succeeded", intent.id, payment_id=payment_id, evidence=evidence_id)
    return "succeeded"


def apply_failure(db: Session, intent: PaymentIntent, *, payment_id: str | None, evidence_id: str, actor: str) -> str:
    if intent.status in PAID or intent.status == "failed":
        return "ignored"
    if intent.status == "created":
        transition(intent, "pending")
    transition(intent, "failed")
    intent.provider_payment_id = intent.provider_payment_id or payment_id  # lets /sync re-check this attempt
    audit(db, intent.tenant_id, actor, "payment_failed", intent.id, payment_id=payment_id, evidence=evidence_id)
    return "failed"


def reserved_refund_total(db: Session, intent_id: uuid.UUID) -> int:
    return db.scalar(select(func.coalesce(func.sum(Refund.amount), 0)).where(
        Refund.intent_id == intent_id, Refund.kind == "intent", Refund.status.in_(("pending", "succeeded")))) or 0


def apply_refund_result(db: Session, intent: PaymentIntent, refund: Refund, *, ok: bool, evidence_id: str,
                        actor: str) -> str:
    if refund.status != "pending":
        return "already_" + refund.status
    if not ok:
        refund.status = "failed"
        audit(db, intent.tenant_id, actor, "refund_failed", intent.id, refund_id=str(refund.id), evidence=evidence_id)
        return "failed"
    refund.status = "succeeded"
    if refund.kind == "intent":
        intent.refunded_amount += refund.amount
        transition(intent, "refunded" if intent.refunded_amount == intent.captured_amount else "partially_refunded")
    db.add(LedgerEntry(tenant_id=intent.tenant_id, intent_id=intent.id,
                       entry_type="refund" if refund.kind == "intent" else "unallocated_refund", amount=-refund.amount,
                       currency=intent.currency, provider_txn_id=refund.provider_refund_id or str(refund.id),
                       evidence_event_id=evidence_id))
    audit(db, intent.tenant_id, actor, "refund_succeeded", intent.id, refund_id=str(refund.id), evidence=evidence_id)
    return "succeeded"
