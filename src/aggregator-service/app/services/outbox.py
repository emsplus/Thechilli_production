from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import OutboundJob, now
from app.providers.base import PermanentError
from app.services.audit import audit


def enqueue(s: Session, *, kind: str, tenant_id: str, provider: str, key: str, payload: dict, order_id=None) -> OutboundJob:
    """Idempotent on `key`: re-enqueueing the same logical push returns the existing job."""
    key = f"{tenant_id}:{key}"  # the key space is global; a tenant must never collide with, or reuse, another's job
    job = s.scalar(select(OutboundJob).where(OutboundJob.idempotency_key == key, OutboundJob.tenant_id == tenant_id))
    if job is None:
        job = OutboundJob(idempotency_key=key, tenant_id=tenant_id, kind=kind, provider=provider, order_id=order_id,
                          payload=payload)
        s.add(job)
        s.flush()
    return job


def backoff_seconds(attempt: int) -> float:
    """Exponential: base * 2**(attempt-1), capped. attempt is 1-based (the attempt that just failed)."""
    return min(settings.outbox_backoff_base_seconds * 2 ** (attempt - 1), settings.outbox_backoff_max_seconds)


def run_due(s: Session, handlers: dict, *, at: datetime | None = None, limit: int = 50) -> dict:
    """Executes due jobs. handlers: kind -> callable(session, job). Each job commits independently; SKIP LOCKED lets
    several workers run safely."""
    at = at or now()
    stats = {"done": 0, "retry": 0, "dead": 0}
    ids = list(s.scalars(select(OutboundJob.id).where(OutboundJob.status == "pending", OutboundJob.next_attempt_at <= at)
                         .order_by(OutboundJob.next_attempt_at).limit(limit)))
    for jid in ids:
        job = s.scalar(select(OutboundJob).where(OutboundJob.id == jid, OutboundJob.status == "pending")
                       .with_for_update(skip_locked=True))
        if job is None:
            continue
        try:
            with s.begin_nested():
                handlers[job.kind](s, job)
            job.status, job.last_error = "done", None
            stats["done"] += 1
        except Exception as e:  # noqa: BLE001 - never lose a job to a bug; unknown errors are retried like transient ones
            job.attempts += 1
            job.last_error = f"{type(e).__name__}: {e}"[:2000]
            permanent = isinstance(e, PermanentError)
            if permanent or job.attempts >= settings.outbox_max_attempts:
                job.status = "dead"
                stats["dead"] += 1
                audit(s, actor="worker", action="job.dead", tenant_id=job.tenant_id, entity_type="job",
                      entity_id=job.id, kind=job.kind, attempts=job.attempts, error=job.last_error)
            else:
                job.next_attempt_at = at + timedelta(seconds=backoff_seconds(job.attempts))
                stats["retry"] += 1
        s.commit()
    return stats
