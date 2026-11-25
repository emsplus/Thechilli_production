import json
import logging
from contextlib import closing

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.errors import AppError, Unauthorized
from app.core.security import resolve_secret, verify_pos_signature
from app.core.tenancy import bind_tenant, tenant_session
from app.models import DeliveryOrder, ProcessedPosEvent, Restaurant, UnprocessedInbound
from app.providers.registry import get_provider
from app.services import conversation, notify
from app.services import orders as svc

router = APIRouter(prefix="/webhooks")
log = logging.getLogger(__name__)


async def _raw(request: Request) -> bytes:
    body = await request.body()
    if len(body) > settings.max_webhook_bytes:
        raise AppError("payload too large", code="too_large", status=413)
    return body


# ---------------- WhatsApp inbound ----------------

@router.get("/whatsapp")
def whatsapp_verify(hub_mode: str = Query("", alias="hub.mode"), hub_verify_token: str = Query("", alias="hub.verify_token"),
                    hub_challenge: str = Query("", alias="hub.challenge")):
    """Handshake only. hub.verify_token is a non-secret challenge, separate from the signing secret."""
    import hmac
    expected = settings.whatsapp_verify_token.get_secret_value()
    if not expected or hub_mode != "subscribe" or not hmac.compare_digest(hub_verify_token.encode(), expected.encode()):
        raise Unauthorized("verification failed")
    return Response(hub_challenge, media_type="text/plain")


@router.post("/whatsapp")
async def whatsapp_inbound(request: Request, x_hub_signature_256: str = Header(default=""),
                           db: Session = Depends(get_db)):
    """Signature in the X-Hub-Signature-256 header ONLY (never a query parameter), checked BEFORE parsing.
    Tenant comes ONLY from phone_number_id -> channel_numbers. Unknown ids: 200 + recorded, not processed."""
    raw = await _raw(request)
    provider = get_provider()
    provider.verify_webhook_signature(raw, x_hub_signature_256)
    try:
        payload = json.loads(raw)
        events = provider.parse_webhook(payload)
    except (ValueError, AttributeError, TypeError):
        raise AppError("malformed payload", code="bad_payload") from None
    for ev in events:
        # Pre-tenant lookup through the SECURITY DEFINER function; every tenant gets its own bound session.
        rid = db.scalar(select(func.resolve_channel(ev.phone_number_id)))
        if not rid:
            log.warning("inbound for unknown phone_number_id %s", ev.phone_number_id)
            db.add(UnprocessedInbound(phone_number_id=ev.phone_number_id[:64], reason="unknown_phone_number_id"))
            db.commit()
            continue
        with closing(tenant_session(rid)) as tdb:
            conversation.handle_inbound(tdb, rid, ev)
            tdb.commit()
            notify.flush_all(tdb)
    for st in provider.parse_statuses(payload):
        rid = db.scalar(select(func.resolve_channel(st.phone_number_id)))
        if rid:
            with closing(tenant_session(rid)) as tdb:
                notify.record_status(tdb, rid, st)
                tdb.commit()
    return {"ok": True}


# ---------------- POS -> delivery status events ----------------

@router.post("/pos")
async def pos_event(request: Request, x_pos_timestamp: str = Header(default=""),
                    x_pos_signature: str = Header(default=""), x_pos_event_id: str = Header(default=""),
                    x_pos_restaurant_id: str = Header(default=""), db: Session = Depends(get_db)):
    """HMAC-SHA256(secret, timestamp + '.' + raw_body), header only, 5 minute window, per-restaurant secret.
    The restaurant header only selects WHICH secret to verify with; nothing is trusted until the signature
    verifies, and the signed body must name the same restaurant."""
    raw = await _raw(request)
    if x_pos_restaurant_id and len(x_pos_restaurant_id) <= 64:
        bind_tenant(db, x_pos_restaurant_id)  # only to read THAT restaurant's secret ref; nothing is trusted yet
    rest = db.get(Restaurant, x_pos_restaurant_id) if x_pos_restaurant_id else None
    if not rest or not x_pos_event_id:
        raise Unauthorized("unknown sender")
    verify_pos_signature(resolve_secret(rest.pos_webhook_secret_ref), x_pos_timestamp, raw, x_pos_signature)
    try:
        ev = json.loads(raw)
        etype, rid = ev["event"], ev["restaurant_id"]
    except (ValueError, KeyError, TypeError):
        raise AppError("malformed event", code="bad_payload") from None
    if rid != rest.restaurant_id:
        raise Unauthorized("restaurant mismatch")
    o = None
    if etype != "menu.changed":
        o = db.scalar(_order_q(rid, str(ev.get("order_id", ""))))
        if o is None:
            # Usually the race where POS sends the event before our create-order call has committed the row. Do NOT
            # mark the event processed: answer non-2xx so the POS outbox retries it (same event id) with backoff.
            log.warning("pos event %s for unknown order; asking POS to retry", etype)
            raise AppError("order not known yet; retry", code="unknown_order", status=409)
    try:
        with db.begin_nested():
            db.add(ProcessedPosEvent(restaurant_id=rid, event_id=x_pos_event_id[:128]))
    except IntegrityError:
        return {"ok": True, "duplicate": True}
    if etype == "menu.changed":
        svc.invalidate_menu(rid)
    else:
        status = {"order.accepted": "accepted", "order.preparing": "preparing", "order.ready": "ready",
                  "order.cancelled": "cancelled"}.get(etype)
        if status or etype == "order.payment_confirmed":
            svc.apply_pos_status(db, o, status, int(ev.get("version", 0)),
                                 payment_confirmed=etype == "order.payment_confirmed")
    db.commit()
    notify.flush_all(db)
    return {"ok": True}


def _order_q(rid: str, pos_order_id: str):
    return select(DeliveryOrder).where(DeliveryOrder.restaurant_id == rid,
                                       DeliveryOrder.pos_order_id == pos_order_id)
