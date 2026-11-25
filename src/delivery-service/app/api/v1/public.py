"""Customer and rider endpoints. Authorised only by purpose-bound signed links (distinct audience per link type)."""
import math
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import authorize
from app.core.config import settings
from app.core.db import get_db
from app.core.errors import AppError
from app.models import Conversation, Restaurant, Rider, RiderLocation
from app.schemas import OtpIn, PingIn, WebOrderIn
from app.services import notify
from app.services import orders as svc

router = APIRouter(prefix="/public")


@router.get("/menu/{token}")
def web_menu(token: str, db: Session = Depends(get_db)):
    c = authorize(db, token, "menu")
    menu = svc.cached_menu(db, c["rid"])
    rest = db.get(Restaurant, c["rid"])
    convo = db.scalar(select(Conversation).where(Conversation.restaurant_id == c["rid"],
                                                 Conversation.wa_number == c.get("wa", "")))
    details = (convo.context or {}).get("details") if convo else None
    prefill = {k: details[k] for k in ("name", "address", "lat", "lng", "pay") if details and details.get(k) is not None}
    return {"brand": rest.brand_name if rest else "", "prefill": prefill, "menu_version": menu.get("menu_version"),
            "categories": menu.get("categories", []),
            "items": sorted((i for i in menu["items"] if i.get("is_active", True)), key=lambda i: i.get("sort_order", 0)),
            "payment_qr_url": rest.payment_qr_url if rest else None}


@router.post("/menu/{token}/order", status_code=201)
def web_order(token: str, body: WebOrderIn, db: Session = Depends(get_db)):
    c = authorize(db, token, "menu")
    o = svc.place_order(db, c["rid"], client_uuid=body.client_uuid, channel="web", name=body.name,
                        wa_number=c["wa"], address=body.address.model_dump(), payment_mode=body.payment_mode,
                        claimed_paid=body.claimed_paid, lines=[ln.model_dump() for ln in body.lines],
                        promo_code=body.promo_code)
    notify.flush_all(db)
    return {"order_id": str(o.id), "order_code": o.order_code, "subtotal": o.subtotal,
            "delivery_fee": o.delivery_fee, "tax": o.tax, "total": o.total, "status": o.status,
            "track_url": svc.track_link(o)}


def _hav_km(a, b, c, d):
    p = math.pi / 180
    x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(x))


@router.get("/track/{token}")
def track(token: str, db: Session = Depends(get_db)):
    c = authorize(db, token, "track")
    o = svc.get_order(db, c["rid"], c["oid"])
    rest = db.get(Restaurant, o.restaurant_id)
    out = {"brand": rest.brand_name if rest else "", "order_code": o.order_code, "status": o.status,
           "total": o.total, "payment_mode": o.payment_mode, "rider_location": None,
           "restaurant_phone": svc.restaurant_phone(db, o.restaurant_id)}
    if o.status == "out_for_delivery" and o.rider_id:  # no location once delivered/cancelled
        loc = db.get(RiderLocation, o.rider_id)
        cutoff = datetime.now(UTC) - timedelta(seconds=settings.rider_location_ttl_seconds)
        if loc and loc.updated_at >= cutoff:
            out["rider_location"] = {"lat": loc.lat, "lng": loc.lng, "updated_at": loc.updated_at.isoformat()}
    return out


@router.get("/rider/{token}")
def rider_view(token: str, db: Session = Depends(get_db)):
    o = svc.get_order(db, (c := authorize(db, token, "rider"))["rid"], c["oid"])
    return {"order_code": o.order_code, "status": o.status, "address": o.address_text, "lat": o.lat, "lng": o.lng,
            "customer_name": o.customer_name, "collect_cash": o.payment_mode == "cod" and not o.payment_confirmed,
            "total": o.total, "offered_to_you": str(o.offered_rider_id) == c["rdr"],
            "yours": str(o.rider_id) == c["rdr"],
            # The customer's number is for the rider who accepted the delivery, never for a rider who was only offered it.
            "customer_phone": o.wa_number if str(o.rider_id) == c["rdr"] else None}


def _act(fn, token, db, *a):
    o = fn(db, authorize(db, token, "rider"), *a)
    notify.flush_all(db)
    return {"order_code": o.order_code, "status": o.status}


@router.post("/rider/{token}/accept")
def accept(token: str, db: Session = Depends(get_db)):
    return _act(svc.rider_accept, token, db)


@router.post("/rider/{token}/decline")
def decline(token: str, db: Session = Depends(get_db)):
    return _act(svc.rider_decline, token, db)


@router.post("/rider/{token}/pickup")
def pickup(token: str, db: Session = Depends(get_db)):
    return _act(svc.rider_pickup, token, db)


@router.post("/rider/{token}/deliver")
def deliver(token: str, body: OtpIn, db: Session = Depends(get_db)):
    return _act(svc.rider_deliver, token, db, body.otp)


@router.post("/rider/{token}/ping")
def ping(token: str, body: PingIn, db: Session = Depends(get_db)):
    c = authorize(db, token, "rider")
    o = svc.get_order(db, c["rid"], c["oid"])
    r = db.scalar(select(Rider).where(Rider.id == c["rdr"], Rider.restaurant_id == c["rid"]))
    if not r or o.rider_id != r.id or o.status != "out_for_delivery":
        raise AppError("tracking is not active for this order", code="forbidden", status=403)
    now = datetime.now(UTC)
    loc = db.get(RiderLocation, r.id)
    if loc:
        dt = (now - loc.updated_at).total_seconds()
        if dt < settings.rider_ping_min_interval_seconds:
            raise AppError("too many pings", code="rate_limited", status=429)
        km = _hav_km(loc.lat, loc.lng, body.lat, body.lng)
        if km > 0.05 and km / max(dt, 1) * 3600 > settings.rider_max_speed_kmh:
            raise AppError("implausible location jump", code="implausible_location", status=422)
        loc.lat, loc.lng, loc.updated_at = body.lat, body.lng, now
    else:
        db.add(RiderLocation(rider_id=r.id, restaurant_id=r.restaurant_id, lat=body.lat, lng=body.lng,
                             updated_at=now))
    db.commit()
    return {"ok": True}
