"""Outbound messaging queue + POS outbox. Both are DB-backed: enqueue inside the caller's transaction, deliver in
`flush_*` (called best-effort after commit and by POST /internal/jobs/run)."""
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import pos as pos_mod
from app.core.config import settings
from app.models import ChannelNumber, DeliveryOrder, InboundMessage, MessageStatus, OutboundMessage, OutboxJob
from app.pos.base import PosError, PosRejected
from app.providers import templates
from app.providers.base import OutboundRequest, ProviderError, StatusEvent, normalize_number
from app.providers.registry import get_provider
from app.services import consent, ratelimit


def _now():
    return datetime.now(UTC)


def enqueue_message(db: Session, restaurant_id: str, to: str, template: str, order: DeliveryOrder | None = None,
                    sensitive: bool = False, **params) -> OutboundMessage:
    tpl = templates.get(template)  # raises for an unknown name; the registry is the single source of the texts
    m = OutboundMessage(restaurant_id=restaurant_id, order_id=order.id if order else None, to_number=to,
                        template=template, params=params, text=tpl.render(params), sensitive=sensitive)
    db.add(m)
    return m


SERVICE_WINDOW = timedelta(hours=24)


def in_service_window(db: Session, m: OutboundMessage, now: datetime) -> bool:
    """True if the recipient messaged us in the last 24 h (Meta customer-service window): free text is allowed."""
    last = db.scalar(select(func.max(InboundMessage.created_at)).where(
        InboundMessage.restaurant_id == m.restaurant_id,
        InboundMessage.wa_number == normalize_number(m.to_number)))
    return bool(last and now - last <= SERVICE_WINDOW)


def _throttle(db: Session, m: OutboundMessage, phone_number_id: str, now: datetime) -> float:
    """Seconds to wait (0 = go): per sender number first, then per recipient (Meta's pair rate limit)."""
    wait = ratelimit.take(db, m.restaurant_id, f"send:{phone_number_id}", capacity=settings.wa_send_bucket_capacity,
                          refill_per_second=settings.wa_send_refill_per_second, now=now)
    if wait:
        return wait
    return ratelimit.take(db, m.restaurant_id, f"to:{normalize_number(m.to_number)}",
                          capacity=settings.wa_pair_bucket_capacity,
                          refill_per_second=settings.wa_pair_refill_per_second, now=now)


def flush_outbound(db: Session, now: datetime | None = None, limit: int = 50, restaurant_id: str | None = None) -> int:
    now = now or _now()
    q = select(OutboundMessage).where(OutboundMessage.status == "pending", OutboundMessage.next_attempt_at <= now)
    if restaurant_id:
        q = q.where(OutboundMessage.restaurant_id == restaurant_id)
    rows = db.scalars(q
                      .order_by(OutboundMessage.created_at).limit(limit).with_for_update(skip_locked=True)).all()
    sent = 0
    for m in rows:
        tpl = templates.REGISTRY.get(m.template)
        if consent.is_opted_out(db, m.restaurant_id, m.to_number) and not (tpl and tpl.essential):
            m.status, m.last_error = "suppressed", "recipient opted out"
            continue
        ch = db.scalar(select(ChannelNumber).where(ChannelNumber.restaurant_id == m.restaurant_id))
        try:
            if not ch:
                raise ProviderError("no channel number configured", retryable=False)
            wait = _throttle(db, m, ch.phone_number_id, now)
            if wait:  # not an attempt: just come back when a token is available
                m.next_attempt_at = now + timedelta(seconds=wait + 0.5)
                continue
            mid = get_provider().send(OutboundRequest(ch.phone_number_id, m.to_number, m.template, m.text, m.params,
                                                      in_window=in_service_window(db, m, now)))
            m.status, m.provider_message_id, m.last_error = "sent", mid, None
            if m.sensitive:
                m.text, m.params = "[redacted]", {}
            sent += 1
        except ProviderError as e:
            m.attempts += 1
            m.last_error = str(e)[:300]
            if not e.retryable or m.attempts >= settings.outbound_max_attempts:
                m.status = "dead"
            else:
                m.next_attempt_at = now + timedelta(seconds=min(2 ** m.attempts * 5, 3600))
    db.commit()
    return sent


def enqueue_outbox(db: Session, order: DeliveryOrder, kind: str) -> None:
    if not db.scalar(select(OutboxJob).where(OutboxJob.order_id == order.id, OutboxJob.kind == kind)):
        db.add(OutboxJob(restaurant_id=order.restaurant_id, order_id=order.id, kind=kind))


def flush_outbox(db: Session, now: datetime | None = None, limit: int = 50, restaurant_id: str | None = None) -> int:
    now = now or _now()
    q = select(OutboxJob).where(OutboxJob.status == "pending", OutboxJob.next_attempt_at <= now)
    if restaurant_id:
        q = q.where(OutboxJob.restaurant_id == restaurant_id)
    jobs = db.scalars(q
                      .order_by(OutboxJob.created_at).limit(limit).with_for_update(skip_locked=True)).all()
    done = 0
    for j in jobs:
        order = db.get(DeliveryOrder, j.order_id)
        try:
            client = pos_mod.get_pos_client(db, j.restaurant_id)
            if j.kind == "dispatch":
                client.dispatch(j.restaurant_id, order.pos_order_id)
            elif j.kind == "delivered":
                client.delivered(j.restaurant_id, order.pos_order_id)
            elif j.kind == "cancel":
                client.cancel_order(j.restaurant_id, order.pos_order_id, j.payload.get("reason", ""))
            j.status = "done"
            done += 1
        except PosError as e:
            j.attempts += 1
            j.last_error = str(e)[:300]
            permanent = isinstance(e, PosRejected) and e.status < 500 and e.status != 429
            if permanent or j.attempts >= settings.outbox_max_attempts:
                j.status = "dead"
            else:
                j.next_attempt_at = now + timedelta(seconds=min(2 ** j.attempts * 5, 3600))
    db.commit()
    return done


def flush_all(db: Session) -> None:
    """Best effort after a request commits; failures stay queued."""
    try:
        flush_outbox(db)
        flush_outbound(db)
    except Exception:  # noqa: BLE001 - never fail the user's request because of delivery side effects
        db.rollback()


STATUS_RANK = {"sent": 1, "delivered": 2, "read": 3}


def record_status(db: Session, restaurant_id: str, st: StatusEvent) -> bool:
    """Stores a delivery receipt (idempotent per (message, status)). A `failed` receipt is surfaced on the message row."""
    if not st.provider_message_id:
        return False
    try:
        with db.begin_nested():
            db.add(MessageStatus(restaurant_id=restaurant_id, provider_message_id=st.provider_message_id[:128],
                                 status=st.status, recipient=st.recipient[:32], error_code=st.error_code,
                                 error_title=st.error_title,
                                 occurred_at=datetime.fromtimestamp(st.timestamp, UTC) if st.timestamp else None))
    except IntegrityError:
        return False
    if st.status == "failed":
        m = db.scalar(select(OutboundMessage).where(OutboundMessage.restaurant_id == restaurant_id,
                                                    OutboundMessage.provider_message_id == st.provider_message_id))
        if m:
            m.last_error = f"delivery failed: {st.error_code} {st.error_title or ''}"[:300]
    return True


def latest_status(db: Session, restaurant_id: str, provider_message_id: str) -> str | None:
    rows = db.scalars(select(MessageStatus.status).where(MessageStatus.restaurant_id == restaurant_id,
                                                         MessageStatus.provider_message_id == provider_message_id)).all()
    if "failed" in rows:
        return "failed"
    return max(rows, key=lambda s: STATUS_RANK.get(s, 0), default=None)
