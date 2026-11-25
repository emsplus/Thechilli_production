import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import ratelimit
from app.core.config import settings
from app.core.db import get_db
from app.core.errors import AppError, NotFound
from app.core.security import Caller, require_caller, validate_secret_ref
from app.models import AuditLog, PaymentIntent, ProviderAccount, ReconciliationRecord, Settlement, WebhookEvent
from app.providers import registry
from app.schemas import (
    IntentIn,
    IntentOut,
    ProviderAccountIn,
    ProviderAccountOut,
    ReconRecordOut,
    RefundIn,
    RefundOut,
    SettlementIn,
    UnallocatedOut,
    UnallocatedRefundIn,
)
from app.services import intents as svc
from app.services import reconciliation as recon
from app.services.audit import audit, scrub
from app.services.payments import PAID
from app.services.webhooks import RETRYABLE, process_event, reprocess_unmatched

router = APIRouter()


def _audit_bad_signature(db: Session, acc: ProviderAccount) -> None:
    """An unauthenticated caller must not be able to grow the append-only audit table without bound:
    at most one row per account per window; the rest are only counted in the log."""
    since = datetime.now(UTC) - timedelta(seconds=settings.bad_signature_audit_window_seconds)
    recent = db.scalar(select(AuditLog.id).where(
        AuditLog.tenant_id == acc.tenant_id, AuditLog.action == "webhook_rejected_bad_signature",
        AuditLog.created_at > since).limit(1))
    if recent is None:
        audit(db, acc.tenant_id, "webhook", "webhook_rejected_bad_signature", None, account_id=str(acc.id),
              window_seconds=settings.bad_signature_audit_window_seconds)
        db.commit()
    logging.getLogger("payments.alerts").warning("webhook_bad_signature account=%s audited=%s", acc.id, recent is None)


@router.get("/health")
def health():
    return {"status": "ok"}


@router.post("/provider-accounts", response_model=ProviderAccountOut, status_code=201)
def create_account(body: ProviderAccountIn, caller: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    for ref in (body.key_id_ref, body.key_secret_ref, body.webhook_secret_ref):
        validate_secret_ref(ref, caller.tenant_id)  # names inside this tenant's namespace only
    acc = ProviderAccount(tenant_id=caller.tenant_id, **body.model_dump())
    db.add(acc)
    db.flush()
    audit(db, caller.tenant_id, "service", "provider_account_created", None, account_id=str(acc.id))
    db.commit()
    return acc


@router.post("/payment-intents", response_model=IntentOut)
def create_intent(body: IntentIn, response: Response, idempotency_key: str = Header(min_length=8, max_length=128),
                  caller: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    intent, created = svc.create_intent(db, caller.tenant_id, idempotency_key, body)
    response.status_code = 201 if created else 200
    return intent


@router.get("/payment-intents/{intent_id}", response_model=IntentOut)
def get_intent(intent_id: uuid.UUID, caller: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    return svc.get_intent(db, caller.tenant_id, intent_id)


@router.post("/payment-intents/{intent_id}/sync", response_model=IntentOut)
def sync(intent_id: uuid.UUID, caller: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    return svc.sync_intent(db, caller.tenant_id, intent_id)


@router.post("/payment-intents/{intent_id}/refunds", response_model=RefundOut)
def refund(intent_id: uuid.UUID, body: RefundIn, response: Response,
           idempotency_key: str = Header(min_length=8, max_length=128),
           caller: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    r, created = svc.create_refund(db, caller.tenant_id, intent_id, idempotency_key, body)
    response.status_code = 201 if created else 200
    return r


@router.get("/unallocated-payments", response_model=list[UnallocatedOut])
def unallocated(caller: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    return svc.unallocated_payments(db, caller.tenant_id)


@router.post("/payment-intents/{intent_id}/unallocated-payments/{payment_id}/refund", response_model=RefundOut)
def refund_unallocated(intent_id: uuid.UUID, payment_id: str, body: UnallocatedRefundIn, response: Response,
                       idempotency_key: str = Header(min_length=8, max_length=128),
                       caller: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    r, created = svc.refund_unallocated(db, caller.tenant_id, intent_id, payment_id, idempotency_key, body)
    response.status_code = 201 if created else 200
    return r


@router.post("/webhooks/reprocess")
def reprocess(caller: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    """Retry events that arrived before their intent/refund was known (tenant-scoped)."""
    return {"outcomes": reprocess_unmatched(db, caller.tenant_id)}


async def _read_capped(request: Request, limit: int) -> bytes:
    """Read the body but stop as soon as it exceeds the cap (Content-Length can be absent or a lie)."""
    declared = request.headers.get("content-length")
    if declared is not None:
        if not declared.isdigit():
            raise AppError("invalid Content-Length", code="bad_request", status=400)
        if int(declared) > limit:
            raise AppError("webhook body too large", code="too_large", status=413)
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise AppError("webhook body too large", code="too_large", status=413)
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/webhooks/{provider}/{account_id}")
async def webhook(provider: str, account_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    """Unauthenticated by design: trust comes solely from the HMAC signature over the raw body."""
    client_ip = request.client.host if request.client else "?"
    if not ratelimit.allow(f"wh:{client_ip}:{account_id}", settings.webhook_rate_limit_per_minute):
        raise AppError("too many requests", code="rate_limited", status=429)
    declared = request.headers.get("content-length")  # cheap rejection before we read or look up anything
    if declared is not None and (not declared.isdigit() or int(declared) > settings.max_webhook_bytes):
        raise AppError("invalid or oversized Content-Length", code="too_large" if declared.isdigit() else "bad_request",
                       status=413 if declared.isdigit() else 400)
    acc = db.get(ProviderAccount, account_id)
    if not acc or acc.provider != provider or not acc.active:
        raise NotFound("unknown webhook endpoint")
    body = await _read_capped(request, settings.max_webhook_bytes)
    adapter = registry.get_provider(acc)
    if not adapter.verify_webhook(body, request.headers.get("x-razorpay-signature", "")):
        _audit_bad_signature(db, acc)
        return JSONResponse({"error": {"code": "bad_signature", "message": "invalid signature"}}, status_code=401)
    ev = adapter.parse_webhook(body, {k.lower(): v for k, v in request.headers.items()})
    row = WebhookEvent(provider_account_id=acc.id, tenant_id=acc.tenant_id, event_id=ev.event_id,
                       event_type=ev.event_type, payload=scrub(json.loads(body)),
                       body_hash=hashlib.sha256(body).hexdigest())
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()  # unique (account, event_id) and (account, body_hash): a concurrent duplicate blocks, then loses
    except IntegrityError:
        row = db.scalars(select(WebhookEvent).where(
            WebhookEvent.provider_account_id == acc.id, WebhookEvent.tenant_id == acc.tenant_id,
            or_(WebhookEvent.event_id == ev.event_id, WebhookEvent.body_hash == row.body_hash)
        ).with_for_update()).first()
        if row is None or row.outcome not in RETRYABLE:
            return {"status": "duplicate"}
        row.attempts += 1  # redelivery of an event we could not match yet: process it again, do not consume it
    row.outcome = process_event(db, acc, ev)
    db.commit()
    return {"status": "processed", "outcome": row.outcome}


@router.post("/reconciliation/settlements", response_model=dict)
def import_settlement(body: SettlementIn, response: Response, caller: Caller = Depends(require_caller),
                      db: Session = Depends(get_db)):
    s, created = recon.import_settlement(db, caller.tenant_id, body)
    response.status_code = 201 if created else 200
    recs = db.scalars(select(ReconciliationRecord).where(
        ReconciliationRecord.settlement_id == s.id, ReconciliationRecord.tenant_id == caller.tenant_id)).all()
    counts: dict[str, int] = {}
    for r in recs:
        counts[r.status] = counts.get(r.status, 0) + 1
    return {"settlement_id": str(s.id), "created": created, "counts": counts}


@router.post("/reconciliation/settlements/{settlement_id}/rematch", response_model=list[ReconRecordOut])
def rematch(settlement_id: uuid.UUID, caller: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    if not db.scalars(select(Settlement).where(Settlement.id == settlement_id,
                                               Settlement.tenant_id == caller.tenant_id)).first():
        raise NotFound("settlement not found")
    return recon.rematch(db, caller.tenant_id, settlement_id)


@router.get("/reconciliation/records", response_model=list[ReconRecordOut])
def records(status: str | None = None, caller: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    q = select(ReconciliationRecord).where(ReconciliationRecord.tenant_id == caller.tenant_id)
    if status:
        q = q.where(ReconciliationRecord.status == status)
    return db.scalars(q.order_by(ReconciliationRecord.provider_txn_id)).all()


@router.get("/reconciliation/unsettled", response_model=list[IntentOut])
def unsettled(caller: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    """Paid intents with no matched settlement line yet."""
    matched = select(ReconciliationRecord.intent_id).where(
        ReconciliationRecord.tenant_id == caller.tenant_id, ReconciliationRecord.item_type == "payment",
        ReconciliationRecord.status == "matched")
    return db.scalars(select(PaymentIntent).where(
        PaymentIntent.tenant_id == caller.tenant_id, PaymentIntent.status.in_(PAID),
        PaymentIntent.id.not_in(matched))).all()
