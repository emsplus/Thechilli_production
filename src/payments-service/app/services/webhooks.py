import json
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.models import PaymentIntent, ProviderAccount, Refund, WebhookEvent
from app.providers import registry
from app.providers.base import NormalizedEvent
from app.services.payments import apply_capture, apply_failure, apply_refund_result

log = logging.getLogger(__name__)
RETRYABLE = {"unmatched"}  # an event for an intent/refund we do not know *yet* (webhook raced our own commit)


def _uuid(v) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(v))
    except (ValueError, TypeError):
        return None


def _find_intent(db: Session, acc: ProviderAccount, ev: NormalizedEvent) -> PaymentIntent | None:
    """Resolve the intent from every identifier the event carries. provider_ref is not authoritative on its own
    (the QR/link id may not be stored yet, or may differ): fall back to the intent id we put in notes /
    reference_id. If two identifiers point at different intents the event is NOT applied."""
    base = select(PaymentIntent).where(PaymentIntent.tenant_id == acc.tenant_id,
                                       PaymentIntent.provider_account_id == acc.id)
    probes = []
    if ev.provider_ref:
        probes.append(base.where(PaymentIntent.provider_ref == ev.provider_ref))
    for raw in (ev.intent_id, ev.reference_id):
        if raw and (u := _uuid(raw)):
            probes.append(base.where(PaymentIntent.id == u))
    if ev.provider_payment_id:
        probes.append(base.where(PaymentIntent.provider_payment_id == ev.provider_payment_id))
    found = {}
    for q in probes:
        row = db.scalars(q).first()
        if row:
            found[row.id] = row
    if len(found) != 1:
        return None  # nothing matched, or identifiers disagree
    row = next(iter(found.values()))
    return db.scalars(select(PaymentIntent).where(PaymentIntent.id == row.id, PaymentIntent.tenant_id == acc.tenant_id)
                      .with_for_update().execution_options(populate_existing=True)).one()


def process_event(db: Session, acc: ProviderAccount, ev: NormalizedEvent) -> str:
    """Apply an already signature-verified, de-duplicated event. Returns an outcome label."""
    actor = "webhook"
    if ev.event_type == "ignored":
        return "ignored"
    if ev.event_type.startswith("refund."):
        refund = db.scalars(select(Refund).where(
            Refund.tenant_id == acc.tenant_id, Refund.provider_refund_id == ev.provider_refund_id).with_for_update()
        ).first() if ev.provider_refund_id else None
        if not refund:
            return "unmatched"
        intent = db.scalars(select(PaymentIntent).where(
            PaymentIntent.id == refund.intent_id, PaymentIntent.tenant_id == acc.tenant_id).with_for_update()).one()
        return apply_refund_result(db, intent, refund, ok=ev.event_type == "refund.processed",
                                   evidence_id=ev.event_id, actor=actor)
    intent = _find_intent(db, acc, ev)
    if not intent:
        return "unmatched"
    if ev.event_type == "payment.captured":
        if not ev.provider_payment_id or ev.amount is None or not ev.currency:
            return "rejected_incomplete"
        return apply_capture(db, intent, payment_id=ev.provider_payment_id, amount=ev.amount, currency=ev.currency,
                             evidence_id=ev.event_id, actor=actor)
    return apply_failure(db, intent, payment_id=ev.provider_payment_id, evidence_id=ev.event_id, actor=actor)


def reprocess_unmatched(db: Session, tenant_id: str, limit: int = 100) -> dict[str, int]:
    """Re-run events that arrived before we could match them. Events are stored scrubbed but complete enough to
    re-parse; the stored event id is the evidence id. Commits per event so one bad row cannot block the rest."""
    rows = db.scalars(select(WebhookEvent).where(WebhookEvent.tenant_id == tenant_id, WebhookEvent.outcome.in_(RETRYABLE))
                      .order_by(WebhookEvent.received_at).limit(limit).with_for_update(skip_locked=True)).all()
    counts: dict[str, int] = {}
    for row in rows:
        acc = db.scalars(select(ProviderAccount).where(ProviderAccount.id == row.provider_account_id,
                                                       ProviderAccount.tenant_id == tenant_id)).first()
        try:
            ev = registry.get_provider(acc).parse_webhook(json.dumps(row.payload).encode(),
                                                          {"x-razorpay-event-id": row.event_id})
            outcome = process_event(db, acc, ev)
        except AppError:
            outcome = "rejected_malformed"
        row.attempts += 1
        row.outcome = outcome
        db.commit()
        counts[outcome] = counts.get(outcome, 0) + 1
    return counts
