import secrets
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import pos as pos_mod
from app.core.config import settings
from app.core.errors import AppError, Conflict, NotFound
from app.core.security import hash_otp, make_link_token, otp_matches
from app.models import (
    RANK,
    TERMINAL,
    DeliveryOrder,
    OrderEvent,
    Reminder,
    Rider,
    RiderDecline,
)
from app.pos.base import IdempotencyConflict, PosRejected, PosUnavailable, PriceChanged
from app.services import geo, notify, ratings


def _now():
    return datetime.now(UTC)


def event(db, order, kind, **detail):
    db.add(OrderEvent(order_id=order.id, restaurant_id=order.restaurant_id, kind=kind, detail=detail))


def money(minor: int) -> str:
    """Paise -> rupees with Indian lakh/crore grouping and two decimals, no sign: 12345650 -> '1,23,456.50'.
    Messages put the rupee sign in front ('₹{total}'); same rule as common.js App.money."""
    sign, n = ("-" if minor < 0 else ""), abs(int(minor))
    rupees, paise = str(n // 100), n % 100
    if len(rupees) > 3:
        head, tail = rupees[:-3], rupees[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        rupees = ",".join([head, *groups, tail]) if head else ",".join([*groups, tail])
    return f"{sign}{rupees}.{paise:02d}"


def track_link(order) -> str:
    t = make_link_token("track", {"rid": order.restaurant_id, "oid": str(order.id)}, settings.track_link_ttl_seconds)
    return f"{settings.public_base_url}/track/{t}"  # HTML page (app/web); its script calls /api/v1/public/track/{t}


def rider_link(order, rider) -> str:
    t = make_link_token("rider", {"rid": order.restaurant_id, "oid": str(order.id), "rdr": str(rider.id)},
                        settings.rider_link_ttl_seconds)
    return f"{settings.public_base_url}/rider/{t}"  # HTML page; script calls /api/v1/public/rider/{t}


def menu_link(restaurant_id: str, wa_number: str) -> str:
    t = make_link_token("menu", {"rid": restaurant_id, "wa": wa_number}, settings.menu_link_ttl_seconds)
    return f"{settings.public_base_url}/menu/{t}"  # the ordering page (app/web); its script calls /api/v1/public/menu/{t}


def restaurant_phone(db: Session, restaurant_id: str) -> str | None:
    """Number the customer's 'Call restaurant' button dials: ONLY the restaurant's own phone from POS config (`phone`, the
    outlet's or else the restaurant's, set in POS Restaurant settings / the setup checklist; `outlet_phone` accepted too).
    Never a manager's or rider's personal number. None when POS has no phone (or is unreachable): the button is hidden."""
    cfg = cached_config(db, restaurant_id)
    phone = str(cfg.get("phone") or cfg.get("outlet_phone") or "").strip()
    return phone or None


def get_order(db: Session, restaurant_id: str, order_id) -> DeliveryOrder:
    o = db.scalar(select(DeliveryOrder).where(DeliveryOrder.id == order_id,
                                              DeliveryOrder.restaurant_id == restaurant_id))
    if not o:
        raise NotFound("order not found")
    return o


def managers(db: Session, restaurant_id: str) -> list[Rider]:
    return list(db.scalars(select(Rider).where(Rider.restaurant_id == restaurant_id, Rider.role == "manager",
                                               Rider.active.is_(True))))


def alert_managers(db, order, reason):
    for m in managers(db, order.restaurant_id):
        notify.enqueue_message(db, order.restaurant_id, m.phone, "manager_alert", order, code=order.order_code,
                               reason=reason)


# ---- menu cache (convenience only; POS revalidates every order) ----
_menu_cache: dict[str, tuple[float, dict]] = {}


def invalidate_menu(restaurant_id: str) -> None:
    _menu_cache.pop(restaurant_id, None)
    _config_cache.pop(restaurant_id, None)


def cached_menu(db: Session, restaurant_id: str) -> dict:
    hit = _menu_cache.get(restaurant_id)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    menu = pos_mod.get_pos_client(db, restaurant_id).get_menu(restaurant_id)
    _menu_cache[restaurant_id] = (time.monotonic() + settings.menu_cache_ttl_seconds, menu)
    return menu


_config_cache: dict[str, tuple[float, dict]] = {}


def cached_config(db: Session, restaurant_id: str) -> dict:
    """POS config (delivery radius, allowed payment modes, ...). Short cache; a POS outage means no rules are known, so
    the rules that need config are skipped here and POS itself still rejects what it must."""
    hit = _config_cache.get(restaurant_id)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    try:
        cfg = pos_mod.get_pos_client(db, restaurant_id).get_config(restaurant_id)
    except PosUnavailable:
        return {}
    _config_cache[restaurant_id] = (time.monotonic() + settings.menu_cache_ttl_seconds, cfg)
    return cfg


def payment_modes(cfg: dict) -> tuple[bool, bool]:
    """(cash on delivery, online). Both on unless POS switched one off; both off still leaves cash."""
    cod, online = cfg.get("allow_cod") is not False, cfg.get("allow_online") is not False
    return (cod, online) if (cod or online) else (True, False)


def check_delivery_rules(cfg: dict, address: dict, payment_mode: str) -> None:
    cod, online = payment_modes(cfg)
    if (payment_mode == "cod" and not cod) or (payment_mode == "online" and not online):
        raise AppError(f"{payment_mode} payment is not available", code="payment_mode_unavailable", status=422)
    state, dist = geo.delivery_check(cfg, address.get("lat"), address.get("lng"))
    if state == "need_location":
        raise AppError("share your location so we can check we deliver to you", code="location_required", status=422)
    if state == "outside":
        raise AppError(f"outside our delivery area ({dist:.1f} km away)", code="outside_delivery_area", status=422)


# ---- placing an order ----

def line_price(item: dict, variant_id: str | None) -> int:
    """Unit price of an item or of one of its variants, from the menu snapshot (POS: variant `price` = item price + delta).
    An unknown or switched-off variant is unavailable."""
    if not variant_id:
        return int(item["price"])
    v = next((v for v in item.get("variants") or [] if v.get("id") == variant_id), None)
    if v is None or v.get("is_active") is False:
        raise AppError(f"option {variant_id} is not available", code="item_unavailable", status=422)
    return int(v["price"]) if v.get("price") is not None else int(item["price"]) + int(v.get("price_delta") or 0)


def place_order(db: Session, restaurant_id: str, *, client_uuid: str, channel: str, name: str, wa_number: str,
                address: dict, payment_mode: str, claimed_paid: bool, lines: list[dict],
                promo_code: str | None = None) -> DeliveryOrder:
    existing = db.scalar(select(DeliveryOrder).where(DeliveryOrder.restaurant_id == restaurant_id,
                                                     DeliveryOrder.client_uuid == client_uuid))
    if existing:
        return existing
    menu = cached_menu(db, restaurant_id)
    items = {i["id"]: i for i in menu["items"]}
    pos_lines = []
    for ln in lines:
        it = items.get(ln["item_id"])
        if not it or not it.get("is_active", True):
            raise AppError(f"item {ln['item_id']} is not available", code="item_unavailable", status=422)
        # The browser sends only id + quantity; the expected price comes from our cache and POS re-checks it.
        pos_lines.append({"item_id": it["id"], "variant_id": ln.get("variant_id"), "quantity": ln["quantity"],
                          "note": ln.get("note", ""), "expected_unit_price": line_price(it, ln.get("variant_id"))})
    body = {"client_uuid": client_uuid, "channel": channel, "order_type": "delivery",
            "customer": {"name": name, "wa_number": wa_number}, "address": address,
            "payment": {"mode": payment_mode, "claimed_paid": claimed_paid, "ref": None},
            "promo_code": promo_code, "lines": pos_lines}
    check_delivery_rules(cached_config(db, restaurant_id), address, payment_mode)
    client = pos_mod.get_pos_client(db, restaurant_id)
    try:
        resp = client.create_order(restaurant_id, client_uuid, body)
    except PriceChanged as e:
        invalidate_menu(restaurant_id)
        raise AppError("prices changed; please review your cart", code="price_changed", status=409,
                       extra={"lines": e.lines}) from e
    except IdempotencyConflict as e:
        raise AppError("idempotency key reused with a different order", code="idempotency_conflict",
                       status=422) from e
    except PosRejected as e:
        raise AppError(f"order rejected: {e}", code=e.code, status=422) from e
    except PosUnavailable as e:
        raise AppError("ordering is temporarily unavailable", code="pos_unavailable", status=503) from e
    o = DeliveryOrder(
        restaurant_id=restaurant_id, client_uuid=client_uuid, channel=channel, pos_order_id=str(resp["order_id"]),
        order_code=resp.get("order_code", ""), status="placed", pos_version=0,
        customer_name=name, wa_number=wa_number, address_text=address.get("text", ""), lat=address.get("lat"),
        lng=address.get("lng"), subtotal=resp["subtotal"], delivery_fee=resp["delivery_fee"], tax=resp["tax"],
        total=resp["total"], payment_mode=payment_mode, claimed_paid=claimed_paid)
    db.add(o)
    try:
        db.flush()
    except IntegrityError:  # concurrent replay of the same client_uuid
        db.rollback()
        return db.scalar(select(DeliveryOrder).where(DeliveryOrder.restaurant_id == restaurant_id,
                                                     DeliveryOrder.client_uuid == client_uuid))
    event(db, o, "placed", pos_order_id=o.pos_order_id)
    # The create response is a snapshot of the POS order at `version`: POS may already have moved it on (with
    # accept_before_kot off it auto-accepts inside the create call, so it answers status=accepted, version=2). Mirror that
    # snapshot through the normal status path; recording the version without the status would make the matching
    # order.accepted webhook (same version) look stale, leaving the order stuck at `placed`.
    apply_pos_status(db, o, _pos_status(resp.get("status")), int(resp.get("version") or 0))
    now = _now()
    for i, secs in enumerate(settings.reminder_stages_seconds):
        db.add(Reminder(restaurant_id=restaurant_id, order_id=o.id, stage=i, due_at=now + timedelta(seconds=secs)))
    # The customer is shown the SERVER total only.
    notify.enqueue_message(db, restaurant_id, wa_number, "order_received", o, name=name, code=o.order_code,
                           total=money(o.total), link=track_link(o))
    alert_managers(db, o, "new delivery order")
    db.commit()
    return o


# ---- POS -> delivery status mirror ----

def _pos_status(s: str | None) -> str | None:
    """A POS status we mirror from a snapshot (placed is the starting point; the rider statuses are ours)."""
    return s if s in ("accepted", "preparing", "ready", "cancelled") else None


def apply_pos_status(db: Session, order: DeliveryOrder, new_status: str | None, version: int,
                     payment_confirmed: bool = False) -> bool:
    """Monotonic per-order version: stale or replayed events are ignored. Returns True if applied."""
    if version <= order.pos_version:
        return False
    order.pos_version = version
    if payment_confirmed:
        order.payment_confirmed = True
        event(db, order, "payment_confirmed", version=version)
    if new_status and order.status not in TERMINAL:
        if new_status == "cancelled":
            order.status = "cancelled"
            order.otp_hash = None
            order.offered_rider_id = None
            event(db, order, "cancelled", source="pos")
            notify.enqueue_message(db, order.restaurant_id, order.wa_number, "cancelled", order, code=order.order_code)
        elif new_status in RANK and RANK[new_status] > RANK[order.status] and new_status not in (
                "out_for_delivery", "delivered"):  # those two are owned by delivery-service
            order.status = new_status
            event(db, order, new_status, source="pos")
            if new_status == "ready":
                notify.enqueue_message(db, order.restaurant_id, order.wa_number, "order_ready", order,
                                       code=order.order_code)
    return True


# ---- riders ----

def _eligible(db, order) -> Rider | None:
    declined = select(RiderDecline.rider_id).where(RiderDecline.order_id == order.id)
    load = (select(func.count()).select_from(DeliveryOrder)
            .where(DeliveryOrder.rider_id == Rider.id, DeliveryOrder.status.notin_(TERMINAL)).scalar_subquery())
    return db.scalars(select(Rider).where(Rider.restaurant_id == order.restaurant_id, Rider.role == "rider",
                                          Rider.active.is_(True), Rider.id.notin_(declined))
                      .order_by(load, Rider.created_at).limit(1)).first()


def offer(db: Session, order: DeliveryOrder, rider: Rider) -> None:
    if rider.restaurant_id != order.restaurant_id:
        raise NotFound("rider not found")
    if rider.role != "rider" or not rider.active:
        raise Conflict("rider is not assignable", code="rider_inactive")
    if order.status in TERMINAL or order.status == "out_for_delivery":
        raise Conflict("order can no longer be assigned", code="bad_state")
    if db.scalar(select(RiderDecline).where(RiderDecline.order_id == order.id, RiderDecline.rider_id == rider.id)):
        raise Conflict("rider already declined this order", code="rider_declined")
    order.offered_rider_id, order.rider_id = rider.id, None
    event(db, order, "offered", rider_id=str(rider.id))
    notify.enqueue_message(db, order.restaurant_id, rider.phone, "rider_offer", order, code=order.order_code,
                           address=order.address_text, link=rider_link(order, rider))


def auto_assign(db: Session, order: DeliveryOrder) -> Rider | None:
    r = _eligible(db, order)
    if r:
        offer(db, order, r)
    else:
        order.offered_rider_id = None
        alert_managers(db, order, "no rider available")
    return r


def _rider_ctx(db, claims) -> tuple[DeliveryOrder, Rider]:
    o = get_order(db, claims["rid"], claims["oid"])
    r = db.scalar(select(Rider).where(Rider.id == claims["rdr"], Rider.restaurant_id == claims["rid"]))
    if not r or not r.active:
        raise AppError("rider not available", code="forbidden", status=403)
    return o, r


def rider_accept(db, claims):
    o, r = _rider_ctx(db, claims)
    if o.rider_id == r.id:
        return o
    if o.offered_rider_id != r.id or o.status in TERMINAL:
        raise Conflict("this order is not offered to you", code="not_offered")
    o.rider_id, o.offered_rider_id = r.id, None
    event(db, o, "rider_accepted", rider_id=str(r.id))
    db.commit()
    return o


def rider_decline(db, claims):
    o, r = _rider_ctx(db, claims)
    if o.offered_rider_id != r.id:
        raise Conflict("this order is not offered to you", code="not_offered")
    db.add(RiderDecline(order_id=o.id, rider_id=r.id))
    o.offered_rider_id = None
    event(db, o, "rider_declined", rider_id=str(r.id))
    db.flush()
    auto_assign(db, o)
    db.commit()
    return o


def _issue_otp(order: DeliveryOrder) -> str:
    otp = "".join(secrets.choice("0123456789") for _ in range(settings.otp_digits))
    order.otp_hash = hash_otp(order.id, otp)
    order.otp_rider_id = order.rider_id
    order.otp_expires_at = _now() + timedelta(seconds=settings.otp_ttl_seconds)
    order.otp_tries, order.otp_locked = 0, False
    return otp


def rider_pickup(db, claims):
    o, r = _rider_ctx(db, claims)
    if o.rider_id != r.id:
        raise AppError("not your order", code="forbidden", status=403)
    if o.status == "out_for_delivery":
        return o
    if o.status != "ready":
        raise Conflict("order is not ready for pickup", code="not_ready")
    otp = _issue_otp(o)
    o.status = "out_for_delivery"
    event(db, o, "out_for_delivery", rider_id=str(r.id))
    notify.enqueue_outbox(db, o, "dispatch")
    notify.enqueue_message(db, o.restaurant_id, o.wa_number, "out_for_delivery", o, sensitive=True,
                           code=o.order_code, otp=otp, link=track_link(o))
    db.commit()
    return o


def reset_otp(db, order: DeliveryOrder) -> None:
    """Manager action: new OTP, unlock, counter reset."""
    if order.status != "out_for_delivery":
        raise Conflict("order is not out for delivery", code="bad_state")
    otp = _issue_otp(order)
    event(db, order, "otp_reset")
    notify.enqueue_message(db, order.restaurant_id, order.wa_number, "out_for_delivery", order, sensitive=True,
                           code=order.order_code, otp=otp, link=track_link(order))


def _finish(db, order, **detail):
    order.status, order.delivered_at, order.otp_hash = "delivered", _now(), None
    event(db, order, "delivered", **detail)
    notify.enqueue_outbox(db, order, "delivered")
    notify.enqueue_message(db, order.restaurant_id, order.wa_number, "delivered", order, code=order.order_code)
    ratings.ask(db, order)


def rider_deliver(db, claims, otp: str):
    """OTP check fails closed: a missing/expired/locked/foreign OTP can never complete a delivery."""
    o, r = _rider_ctx(db, claims)
    db.refresh(o, with_for_update=True)  # serialise guesses: parallel requests must not each see otp_tries == 0
    if o.status == "delivered":
        return o
    if o.rider_id != r.id or o.otp_rider_id != r.id:
        raise AppError("not your order", code="forbidden", status=403)
    if o.status != "out_for_delivery":
        raise Conflict("order is not out for delivery", code="bad_state")
    if o.otp_locked:
        raise AppError("too many wrong codes; ask a manager to reset", code="otp_locked", status=423)
    if not o.otp_hash or not o.otp_expires_at or o.otp_expires_at < _now():
        raise AppError("no valid delivery code; ask a manager", code="otp_unavailable", status=409)
    if not otp_matches(o.otp_hash, o.id, otp.strip()):
        o.otp_tries += 1
        event(db, o, "otp_failed", tries=o.otp_tries)
        if o.otp_tries >= settings.otp_max_tries:
            o.otp_locked = True
            alert_managers(db, o, "delivery code locked after wrong attempts")
        db.commit()
        notify.flush_all(db)  # deliver the manager lock alert even though the request errors
        raise AppError("wrong code", code="otp_invalid", status=422 if not o.otp_locked else 423)
    _finish(db, o, via="otp")
    db.commit()
    return o


def manager_override_deliver(db, order: DeliveryOrder, reason: str):
    if order.status != "out_for_delivery":
        raise Conflict("order is not out for delivery", code="bad_state")
    _finish(db, order, via="manager_override", reason=reason)
    db.commit()


def cancel_order(db, order: DeliveryOrder, reason: str):
    if order.status in TERMINAL:
        raise Conflict("order already finished", code="bad_state")
    order.status, order.otp_hash, order.offered_rider_id = "cancelled", None, None
    event(db, order, "cancelled", source="delivery", reason=reason)
    notify.enqueue_outbox(db, order, "cancel")
    notify.enqueue_message(db, order.restaurant_id, order.wa_number, "cancelled", order, code=order.order_code)
    db.commit()
