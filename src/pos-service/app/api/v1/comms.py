"""Communication settings, WhatsApp sharing of a bill, the WhatsApp outbox and the Meta webhook (docs/COMMS.md)."""
import hmac
import json
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_principal, P, Principal, require_perm
from app.api.v1.billing import _load, _public_base
from app.core.config import settings
from app.core.db import get_db
from app.models.core import Restaurant, WhatsAppOutbox
from app.schemas.common import CommsSettingsIn, CommsSettingsOut, WhatsAppOutboxOut, WhatsAppSendIn
from app.services import audit, mail, money, receipt_links, whatsapp

router = APIRouter(tags=["communications"])


def _settings_out(r: Restaurant) -> CommsSettingsOut:
    return CommsSettingsOut(whatsapp_enabled=r.whatsapp_enabled, login_alert_emails=r.login_alert_emails,
                            whatsapp_available=whatsapp.available(), email_available=mail.get_provider() is not None)


@router.get("/restaurant/communications", response_model=CommsSettingsOut)
def get_comms(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return _settings_out(db.get(Restaurant, p.restaurant_id))


@router.put("/restaurant/communications", response_model=CommsSettingsOut)
def put_comms(data: CommsSettingsIn, p: Principal = Depends(require_perm(P.SETTINGS_OWNER)), db: Session = Depends(get_db)):
    """Owner only. WhatsApp messages to customers and 'new device sign-in' emails to staff; both default OFF."""
    r = db.get(Restaurant, p.restaurant_id)
    changes = data.model_dump(exclude_none=True)
    for k, v in changes.items():
        setattr(r, k, v)
    if changes:
        audit.record(db, p, "restaurant.communications", "restaurant", r.id, changes)
    db.commit()
    return _settings_out(r)


def _bill_target(db: Session, p: Principal, bill_id: uuid.UUID, data: WhatsAppSendIn):
    r = db.get(Restaurant, p.restaurant_id)
    b = _load(db, p, bill_id)  # first: another tenant's bill is a 404 whatever the settings are
    if not r.whatsapp_enabled:
        raise HTTPException(409, "WhatsApp messages are switched off for this restaurant")
    phone = whatsapp.normalize_phone(data.phone or b.customer_phone)
    if not phone:
        raise HTTPException(422, "A valid customer phone number is needed")
    return r, b, phone, (b.customer_name or "").strip() or "Guest"


def _queue(db: Session, p: Principal, row: WhatsAppOutbox, action: str, b) -> WhatsAppOutbox:
    audit.record(db, p, action, "bill", b.id, {"outbox_id": str(row.id)})
    db.commit()
    if row.status == "queued":
        whatsapp.submit(whatsapp.deliver, p.restaurant_id, row.id)  # after the commit; a failure only affects the outbox row
    return row


@router.post("/bills/{bill_id}/whatsapp-receipt", response_model=WhatsAppOutboxOut, status_code=202)
def whatsapp_receipt(bill_id: uuid.UUID, request: Request, data: WhatsAppSendIn | None = None,
                     p: Principal = Depends(require_perm(P.BILLS_RECEIPT)), db: Session = Depends(get_db)):
    """Queues the bill's public receipt link (the same expiring link as /share-link) to the customer's WhatsApp. 202: the
    message is sent in the background with retries; check GET /comms/whatsapp/outbox. 409 when WhatsApp is off / the customer
    opted out; 422 without a usable phone number."""
    data = data or WhatsAppSendIn()
    r, b, phone, name = _bill_target(db, p, bill_id, data)
    exp = int(time.time()) + settings.receipt_link_days * 86400
    url = f"{_public_base(request)}/api/v1/public/receipts/{receipt_links.make_token(b.id, b.restaurant_id, exp, b.receipt_link_gen or 0)}.pdf"
    row = whatsapp.enqueue_template(db, r.id, "receipt_link", phone, whatsapp.TEMPLATE_RECEIPT, data.language,
                                    [name, r.name, b.invoice_number, url], bill_id=b.id, created_by=p.user_id,
                                    dedupe_key=whatsapp.bucket_key("receipt_link", b.id, phone))
    return _queue(db, p, row, "bill.whatsapp_receipt", b)


@router.post("/bills/{bill_id}/whatsapp-bill-ready", response_model=WhatsAppOutboxOut, status_code=202)
def whatsapp_bill_ready(bill_id: uuid.UUID, data: WhatsAppSendIn | None = None,
                        p: Principal = Depends(require_perm(P.BILLS_RECEIPT)), db: Session = Depends(get_db)):
    """Queues a 'your bill is ready' notification (restaurant, invoice number, total) to the customer's WhatsApp."""
    data = data or WhatsAppSendIn()
    r, b, phone, name = _bill_target(db, p, bill_id, data)
    row = whatsapp.enqueue_template(db, r.id, "bill_ready", phone, whatsapp.TEMPLATE_BILL_READY, data.language,
                                    [name, r.name, b.invoice_number, money.fmt_inr(b.total)], bill_id=b.id,
                                    created_by=p.user_id, dedupe_key=whatsapp.bucket_key("bill_ready", b.id, phone))
    return _queue(db, p, row, "bill.whatsapp_ready", b)


@router.get("/comms/whatsapp/outbox", response_model=list[WhatsAppOutboxOut])
def outbox(status: str | None = Query(default=None, pattern="^(queued|sent|dead|skipped)$"), limit: int = Query(default=50, ge=1, le=200),
           p: Principal = Depends(require_perm(P.SETTINGS_OWNER)), db: Session = Depends(get_db)):
    """Owner only. Recent WhatsApp messages with their delivery state (newest first)."""
    q = select(WhatsAppOutbox).where(WhatsAppOutbox.restaurant_id == p.restaurant_id)
    if status:
        q = q.where(WhatsAppOutbox.status == status)
    return db.scalars(q.order_by(WhatsAppOutbox.created_at.desc()).limit(limit)).all()


@router.post("/comms/whatsapp/outbox/{outbox_id}/retry", response_model=WhatsAppOutboxOut, status_code=202)
def outbox_retry(outbox_id: uuid.UUID, p: Principal = Depends(require_perm(P.SETTINGS_OWNER)), db: Session = Depends(get_db)):
    """Owner only. Re-queues a dead or skipped message."""
    row = whatsapp.retry(db, p.restaurant_id, outbox_id)
    audit.record(db, p, "whatsapp.retry", "whatsapp_outbox", row.id)
    db.commit()
    whatsapp.submit(whatsapp.deliver, p.restaurant_id, row.id)
    return row


# ---------------------------------------------------------------- Meta webhook (public: Meta calls it; signature-checked)
@router.get("/webhooks/whatsapp")
def webhook_verify(request: Request):
    """Meta's subscription handshake: echoes hub.challenge when hub.verify_token matches WHATSAPP_VERIFY_TOKEN."""
    q = request.query_params
    expected = settings.whatsapp_verify_token.get_secret_value()
    if expected and q.get("hub.mode") == "subscribe" and hmac.compare_digest(q.get("hub.verify_token", ""), expected):
        return Response(q.get("hub.challenge", ""), media_type="text/plain")
    raise HTTPException(403, "Forbidden")


@router.post("/webhooks/whatsapp")
async def webhook_receive(request: Request):
    """Inbound messages: STOP / START change the customer's opt-out, any message opens the 24-hour free-text window. The
    body must carry a valid X-Hub-Signature-256 (HMAC with WHATSAPP_APP_SECRET); otherwise 403 and nothing is read."""
    raw = await request.body()
    if not whatsapp.verify_signature(raw, request.headers.get("x-hub-signature-256")):
        raise HTTPException(403, "Forbidden")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HTTPException(400, "Bad request") from None
    whatsapp.handle_webhook(payload if isinstance(payload, dict) else {})
    return {"status": "ok"}
