"""Delivery orders for delivery-service (docs/DELIVERY_API.md): menu/config pull, order placement with server-side price
re-validation, the delivery state machine mapped onto the existing order/KOT states, and the webhook events.

Mapping (nothing here changes dine-in / takeaway; a delivery order is an ``orders`` row with order_type=delivery):

  delivery state     orders.status      kot_tickets             who moves it
  placed             open               (none yet)              placement; stays here while accept_before_kot is on
  accepted           sent_to_kitchen    pending                 auto at placement, or staff accept (KOT is sent here)
  preparing          sent_to_kitchen    preparing               kitchen (PATCH /kot/{id})
  ready              sent_to_kitchen    ready                   kitchen
  out_for_delivery   sent_to_kitchen    ready                   delivery-service (dispatch); no table / billing path
  delivered          sent_to_kitchen    served                  delivery-service (delivered); billing stays the cashier's
  cancelled          cancelled          open KOTs cancelled     either side, via the existing cancel
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import Principal
from app.core.permissions import P
from app.models.core import (
    Category, DeliveryOrder, DeliverySettings, Kot, KotStatus, MenuItem, MenuVariant, Order, OrderLine, OrderStatus,
    OrderType, Outlet, Restaurant, Role, User,
)
from app.schemas.delivery import DeliveryOrderIn
from app.services import audit, billing, delivery_outbox, outlets, tax
from app.services import orders as order_svc

log = logging.getLogger("app.delivery")

RANK = {"placed": 0, "accepted": 1, "preparing": 2, "ready": 3, "out_for_delivery": 4, "delivered": 5}
TERMINAL = ("delivered", "cancelled")
EVENT_OF = {"accepted": "order.accepted", "preparing": "order.preparing", "ready": "order.ready", "cancelled": "order.cancelled"}
SYSTEM_EMAIL = "delivery-service@system.invalid"
ID_NS = uuid.UUID("6f1d2c9e-5a3b-4d7e-9c10-0d5e11e11e11")  # idempotency key -> orders.client_uuid


class DeliveryError(Exception):
    """Answered as {"code", "detail", "error": {...}} with this HTTP status (so delivery-service reads `code`)."""

    def __init__(self, status: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


def minor(x: Decimal) -> int:
    """Money on the wire is integer minor units (paise: 2 decimals of INR)."""
    return int((Decimal(x) * 100).to_integral_value(rounding=ROUND_HALF_UP))


def major(n: int) -> Decimal:
    return (Decimal(n) / 100).quantize(Decimal("0.01"))


def get_settings(db: Session, rid: uuid.UUID) -> DeliverySettings:
    row = db.get(DeliverySettings, rid)
    return row if row is not None else default_settings(db, rid)


def default_settings(db: Session, rid: uuid.UUID) -> DeliverySettings:
    """Settings of a business that never saved any. "Take delivery orders" starts ON for a cloud / hotel kitchen whose delivery
    module is on (the module is on by default for kitchens, docs/BUSINESS_TYPES.md), OFF for a restaurant."""
    from app.services import business_type
    r = db.get(Restaurant, rid)
    kitchen = bool(set(business_type.stored(r)) & business_type.KITCHEN_TYPES) if r is not None else False
    if kitchen:
        try:
            business_type.require(db, rid, "delivery_orders")
        except business_type.NotAvailable:
            kitchen = False
    return DeliverySettings(restaurant_id=rid, enabled=kitchen, accept_before_kot=False, delivery_fee=Decimal(0), min_order=Decimal(0))


def resolve_outlet(db: Session, rid: uuid.UUID, outlet_id) -> Outlet:
    if outlet_id in (None, ""):
        return outlets.default_outlet(db, rid)
    try:
        oid = outlet_id if isinstance(outlet_id, uuid.UUID) else uuid.UUID(str(outlet_id))
    except ValueError:
        raise DeliveryError(422, "bad_outlet", "outlet_id is not a valid id") from None
    o = db.get(Outlet, oid)
    if o is None or o.restaurant_id != rid or not o.is_active:
        raise DeliveryError(404, "outlet_not_found", "outlet not found")
    return o


def service_user(db: Session, rid: uuid.UUID) -> User:
    """The tenant's non-login actor for machine-created rows (orders.created_by, audit). Inactive, no usable password."""
    u = db.scalar(select(User).where(User.restaurant_id == rid, User.email == SYSTEM_EMAIL))
    if u is None:
        import secrets
        from app.core.security import hash_password
        u = User(restaurant_id=rid, email=SYSTEM_EMAIL, full_name="Delivery service", role=Role.waiter, is_active=False,
                 password_hash=hash_password(secrets.token_urlsafe(32)))
        try:
            with db.begin_nested():
                db.add(u)
        except IntegrityError:
            u = db.scalar(select(User).where(User.restaurant_id == rid, User.email == SYSTEM_EMAIL))
    return u


def acting_principal(db: Session, rid: uuid.UUID, outlet: Outlet | None = None) -> Principal:
    """A Principal for the services layer: the system user, waiter-level permissions narrowed to what delivery does."""
    u = service_user(db, rid)
    o = outlet or outlets.default_outlet(db, rid)
    return Principal(u.id, rid, Role.waiter, o.id, None,
                     frozenset({P.ORDERS_CREATE, P.ORDERS_UPDATE, P.ORDERS_CANCEL, P.KOT_SEND, P.KOT_VIEW,
                                P.ORDERS_CANCEL_AFTER_KITCHEN}))  # the aggregator's cancel always lands


# ------------------------------------------------------------------------------------------------ menu / config
def menu_payload(db: Session, rid: uuid.UUID, outlet: Outlet) -> dict:
    cats = db.scalars(select(Category).where(Category.restaurant_id == rid, Category.is_active)
                      .order_by(Category.sort_order, Category.name)).all()
    cat_rank = {c.id: i for i, c in enumerate(cats)}
    items = db.scalars(select(MenuItem).where(MenuItem.restaurant_id == rid, MenuItem.category_id.in_(list(cat_rank) or [None]))
                       .order_by(MenuItem.name)).all()
    items.sort(key=lambda i: (cat_rank[i.category_id], i.name))
    cur = (db.get(Restaurant, rid)).currency
    out_items = []
    for n, i in enumerate(items, 1):
        variants = [{"id": str(v.id), "name": v.name, "price_delta": minor(v.price_delta), "price": minor(i.price + v.price_delta),
                     "is_active": v.is_active} for v in sorted(i.variants, key=lambda v: (v.name, str(v.id)))]
        out_items.append({"id": str(i.id), "name": i.name, "price": minor(i.price), "currency": cur, "tax_kind": i.tax_kind,
                          "is_active": bool(i.is_active), "variants": variants, "description": i.description or "", "food_type": i.food_type,
                          "image_url": i.image_url, "sort_order": n, "category_id": str(i.category_id)})
    body = {"currency": cur, "outlet_id": str(outlet.id),
            "categories": [{"id": str(c.id), "name": c.name, "sort_order": c.sort_order} for c in cats], "items": out_items}
    # A version that changes exactly when something a customer can see or pay changes (price, name, availability, variants,
    # food mark, description).
    body["menu_version"] = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]
    return body


def config_payload(db: Session, rid: uuid.UUID, outlet: Outlet) -> dict:
    cfg, r = get_settings(db, rid), db.get(Restaurant, rid)
    return {"enabled": bool(cfg.enabled), "currency": r.currency, "delivery_fee": minor(cfg.delivery_fee),
            "free_delivery_above": minor(cfg.free_delivery_above) if cfg.free_delivery_above is not None else None,
            "min_order": minor(cfg.min_order), "hours": cfg.hours, "timezone": outlet.timezone or r.timezone,
            "tax_mode": "inclusive" if r.prices_include_tax else "exclusive", "outlet_id": str(outlet.id),
            "outlet_name": outlet.name, "address": outlet.address or r.address, "phone": outlet.phone or r.phone,
            "radius_km": float(cfg.radius_km) if cfg.radius_km is not None else None,
            "accept_before_kot": bool(cfg.accept_before_kot)}


def is_open(cfg: DeliverySettings, tz: str, at: datetime | None = None) -> bool:
    if not cfg.hours:
        return True
    local = (at or datetime.now(ZoneInfo("UTC"))).astimezone(ZoneInfo(tz))
    day = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")[local.weekday()]
    hhmm = local.strftime("%H:%M")
    return any(a <= hhmm < b or (b <= a and (hhmm >= a or hhmm < b)) for a, b in (w[:2] for w in cfg.hours.get(day, []) if len(w) >= 2))


# ------------------------------------------------------------------------------------------------ placing an order
def _hash(data: DeliveryOrderIn) -> str:
    return hashlib.sha256(json.dumps(data.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _by_key(db: Session, rid: uuid.UUID, key: str) -> DeliveryOrder | None:
    return db.scalar(select(DeliveryOrder).where(DeliveryOrder.restaurant_id == rid, DeliveryOrder.idempotency_key == key))


def place_order(db: Session, rid: uuid.UUID, key: str, data: DeliveryOrderIn) -> tuple[DeliveryOrder, bool]:
    """(delivery row, created). Replay of the same key + body returns the original (created=False)."""
    key = (key or "").strip()
    if not key or len(key) > 128:
        raise DeliveryError(422, "idempotency_key_required", "Idempotency-Key header is required (max 128 characters)")
    if data.client_uuid and data.client_uuid != key:
        raise DeliveryError(422, "idempotency_key_mismatch", "client_uuid must equal the Idempotency-Key")
    h = _hash(data)
    prior = _by_key(db, rid, key)
    if prior is not None:
        if prior.request_hash != h:
            raise DeliveryError(422, "idempotency_conflict", "Idempotency-Key was already used with a different order")
        _heal_accept(db, prior)
        return prior, False

    from app.services import business_type
    try:  # the delivery module must be on for this business (same rule and code as POST /orders)
        business_type.require(db, rid, "delivery_orders")
    except business_type.NotAvailable as e:
        raise DeliveryError(409, e.code, str(e.detail)) from None
    cfg = get_settings(db, rid)
    if not cfg.enabled:
        raise DeliveryError(409, "delivery_disabled", "delivery is not enabled for this restaurant")
    outlet = resolve_outlet(db, rid, data.outlet_id)
    restaurant = db.get(Restaurant, rid)
    if not is_open(cfg, outlet.timezone or restaurant.timezone):
        raise DeliveryError(422, "outside_hours", "delivery is closed at this time")
    if data.promo_code:
        raise DeliveryError(422, "promo_not_supported", "promo codes are not supported by Chilli Agent")

    lines: list[OrderLine] = []
    changed: list[dict] = []
    for ln in data.lines:
        item = db.get(MenuItem, ln.item_id)
        cat = db.get(Category, item.category_id) if item else None
        if item is None or item.restaurant_id != rid or not item.is_active or not cat or not cat.is_active:
            raise DeliveryError(422, "item_unavailable", f"item {ln.item_id} is not available", item_id=str(ln.item_id))
        price, name = item.price, item.name
        if ln.variant_id:
            v = db.get(MenuVariant, ln.variant_id)
            if v is None or v.item_id != item.id or not v.is_active:
                raise DeliveryError(422, "item_unavailable", f"option {ln.variant_id} is not available",
                                    item_id=str(ln.item_id), variant_id=str(ln.variant_id))
            price, name = price + v.price_delta, f"{item.name} ({v.name})"
        if ln.expected_unit_price is not None and ln.expected_unit_price != minor(price):
            changed.append({"item_id": str(item.id), "variant_id": str(ln.variant_id) if ln.variant_id else None,
                            "new_price": minor(price)})
        lines.append(OrderLine(item_id=item.id, variant_id=ln.variant_id, item_name=name, unit_price=price,
                               quantity=ln.quantity, note=ln.note or None, position=len(lines)))
    if changed:
        raise DeliveryError(409, "price_changed", "prices changed since the customer saw the menu", lines=changed)

    now = datetime.now(ZoneInfo("UTC"))
    rates = billing._rule_rows(db, restaurant, now)
    registered = restaurant.vat_registered
    if registered and "standard" not in rates:
        raise DeliveryError(409, "tax_not_configured", "no tax rule configured for this date")
    inv = tax.compute_invoice(
        [tax.LineIn(l.item_name, l.quantity, l.unit_price, tax.line_tax_code(registered), l.item_id) for l in lines],
        {c: r.rate_percent for c, r in rates.items()}, restaurant.prices_include_tax)
    shown = tax.item_total([tax.LineIn(l.item_name, l.quantity, l.unit_price, "standard") for l in lines])  # what the menu shows
    if shown < cfg.min_order:
        raise DeliveryError(422, "below_min_order", f"minimum order is {minor(cfg.min_order)}", min_order=minor(cfg.min_order))
    free = cfg.free_delivery_above is not None and shown >= cfg.free_delivery_above
    fee = Decimal(0) if free else Decimal(cfg.delivery_fee)
    subtotal = shown
    tax_amt = inv.tax_amount
    total = inv.total + fee  # inv.total is what the customer pays for the items (tax included either way)

    actor = acting_principal(db, rid, outlet)
    order = Order(restaurant_id=rid, outlet_id=outlet.id, client_uuid=uuid.uuid5(ID_NS, f"{rid}:{key}"),
                  order_type=OrderType.delivery, created_by=actor.user_id, status=OrderStatus.open)
    order.lines.extend(lines)
    d = None
    try:
        with db.begin_nested():
            db.add(order)
            db.flush()
            n = billing.next_counter(db, rid, outlets.default_outlet(db, rid).id, "DLV", 0)
            d = DeliveryOrder(
                restaurant_id=rid, order_id=order.id, outlet_id=outlet.id, idempotency_key=key, request_hash=h,
                order_code=f"D{n:04d}", delivery_status="placed", version=1, channel=data.channel,
                customer_name=data.customer.name, customer_phone=data.customer.wa_number, address_text=data.address.text,
                lat=data.address.lat, lng=data.address.lng, subtotal=subtotal, delivery_fee=fee, tax=tax_amt, total=total,
                payment_mode=data.payment.mode, claimed_paid=data.payment.claimed_paid, payment_ref=data.payment.ref)
            db.add(d)
            db.flush()
    except IntegrityError:  # a concurrent request with the same key won
        db.rollback()
        prior = _by_key(db, rid, key)
        if prior is None:
            raise
        if prior.request_hash != h:
            raise DeliveryError(422, "idempotency_conflict", "Idempotency-Key was already used with a different order") from None
        return prior, False
    audit.record(db, actor, "delivery.order.create", "order", order.id, {"code": d.order_code, "channel": data.channel})
    db.commit()
    _heal_accept(db, d)
    return d, True


def _heal_accept(db: Session, d: DeliveryOrder) -> None:
    """With accept_before_kot off an order goes to the kitchen at once. Called after placement and on replay, so an order
    whose accept step failed after the commit is completed by the caller's retry. Never raises."""
    if d.delivery_status != "placed" or get_settings(db, d.restaurant_id).accept_before_kot:
        return
    try:
        accept(db, acting_principal(db, d.restaurant_id, db.get(Outlet, d.outlet_id)), d.id)
    except Exception:  # noqa: BLE001
        db.rollback()
        log.exception("auto-accept of delivery order %s failed; staff can accept it", d.order_id)


# ------------------------------------------------------------------------------------------------ state machine
def _lock(db: Session, rid: uuid.UUID, ref, *, by_order: bool) -> DeliveryOrder:
    col = DeliveryOrder.order_id if by_order else DeliveryOrder.id
    d = db.scalar(select(DeliveryOrder).where(DeliveryOrder.restaurant_id == rid, col == ref).with_for_update())
    if d is None:
        raise DeliveryError(404, "not_found", "delivery order not found")
    return d


def advance(db: Session, d: DeliveryOrder, new: str, **extra) -> bool:
    """Moves forward (or to cancelled), bumps the per-order version and queues the webhook. False = nothing to do."""
    cur = d.delivery_status
    if cur == new:
        return False
    if cur in TERMINAL:
        raise DeliveryError(409, "bad_state", f"order is {cur}")
    if new != "cancelled" and RANK[new] <= RANK[cur]:
        return False  # stale (e.g. a kitchen status that the order already passed)
    d.delivery_status = new
    d.version += 1
    db.flush()
    if new in EVENT_OF:
        delivery_outbox.enqueue(db, d, EVENT_OF[new], **extra)
    return True


def accept(db: Session, p: Principal, ref: uuid.UUID, *, by_order: bool = False) -> DeliveryOrder:
    """placed -> accepted: sends the KOT to the kitchen (the existing send_kot) and tells delivery-service. Idempotent."""
    d = _lock(db, p.restaurant_id, ref, by_order=by_order)
    if d.delivery_status != "placed":
        if d.delivery_status == "cancelled":
            raise DeliveryError(409, "bad_state", "order is cancelled")
        db.commit()
        return d
    db.commit()  # release the row lock: send_kot takes the order lock, then we re-take ours
    order_svc.send_kot(db, p, d.order_id)  # commits
    d = _lock(db, p.restaurant_id, d.id, by_order=False)
    if advance(db, d, "accepted"):
        audit.record(db, p, "delivery.order.accept", "order", d.order_id)
    db.commit()
    return d


def dispatch(db: Session, rid: uuid.UUID, order_id: uuid.UUID) -> DeliveryOrder:
    d = _lock(db, rid, order_id, by_order=True)
    if d.delivery_status == "out_for_delivery":
        db.commit()
        return d
    if d.delivery_status in TERMINAL or d.delivery_status == "placed":
        raise DeliveryError(409, "bad_state", f"order is {d.delivery_status}")
    advance(db, d, "out_for_delivery")
    db.commit()
    return d


def delivered(db: Session, rid: uuid.UUID, order_id: uuid.UUID) -> DeliveryOrder:
    """Handed to the customer. The kitchen tickets are closed (served); the table and billing path is NOT involved: the
    cashier bills the order as for any other takeaway."""
    d = _lock(db, rid, order_id, by_order=True)
    if d.delivery_status == "delivered":
        db.commit()
        return d
    if d.delivery_status in TERMINAL or d.delivery_status == "placed":
        raise DeliveryError(409, "bad_state", f"order is {d.delivery_status}")
    for k in db.scalars(select(Kot).where(Kot.order_id == d.order_id,
                                          Kot.status.in_((KotStatus.pending, KotStatus.preparing, KotStatus.ready))).with_for_update()):
        k.status = KotStatus.served
        k.done_at = k.done_at or billing.db_now(db)
    advance(db, d, "delivered")
    db.commit()
    return d


def cancel(db: Session, rid: uuid.UUID, order_id: uuid.UUID, reason: str) -> DeliveryOrder:
    d = _lock(db, rid, order_id, by_order=True)
    if d.delivery_status == "cancelled":
        db.commit()
        return d
    if d.delivery_status == "delivered":
        raise DeliveryError(409, "bad_state", "order is already delivered")
    db.commit()
    order_svc.cancel_order(db, acting_principal(db, rid, db.get(Outlet, d.outlet_id)), order_id, reason)  # hook below queues the event
    return db.scalar(select(DeliveryOrder).where(DeliveryOrder.order_id == order_id))


def confirm_payment(db: Session, p: Principal, order_id: uuid.UUID) -> DeliveryOrder:
    """Staff saw the money (cash taken / online payment verified). The only way payment_confirmed becomes true."""
    d = _lock(db, p.restaurant_id, order_id, by_order=True)
    if not d.payment_confirmed:
        d.payment_confirmed = True
        d.version += 1
        db.flush()
        delivery_outbox.enqueue(db, d, "order.payment_confirmed", payment_confirmed=True)
        audit.record(db, p, "delivery.order.payment_confirmed", "order", d.order_id)
    db.commit()
    return d


# hooks called by the existing order / kitchen code, inside their transaction (they commit)
def after_cancel(db: Session, order: Order, reason: str) -> None:
    d = db.scalar(select(DeliveryOrder).where(DeliveryOrder.order_id == order.id).with_for_update())
    if d is not None and d.delivery_status not in TERMINAL:
        advance(db, d, "cancelled", reason=reason)


def after_kot_status(db: Session, kot: Kot) -> None:
    new = {KotStatus.preparing: "preparing", KotStatus.ready: "ready"}.get(kot.status)
    if new is None:
        return
    d = db.scalar(select(DeliveryOrder).where(DeliveryOrder.order_id == kot.order_id).with_for_update())
    if d is not None and d.delivery_status not in TERMINAL and d.delivery_status != "placed":
        advance(db, d, new)


def after_kot_done(db: Session, kot: Kot) -> None:
    """KOT-only kitchen: Done means the food is ready, so a delivery order moves on to `ready` (webhook), skipping `preparing`."""
    d = db.scalar(select(DeliveryOrder).where(DeliveryOrder.order_id == kot.order_id).with_for_update())
    if d is not None and d.delivery_status not in TERMINAL and d.delivery_status != "placed":
        advance(db, d, "ready")


def order_payload(d: DeliveryOrder, db: Session | None = None) -> dict:
    out = {"order_id": str(d.order_id), "order_code": d.order_code, "status": d.delivery_status, "version": d.version,
           "subtotal": minor(d.subtotal), "delivery_fee": minor(d.delivery_fee), "tax": minor(d.tax), "total": minor(d.total),
           "restaurant_id": str(d.restaurant_id), "outlet_id": str(d.outlet_id), "channel": d.channel,
           "payment_mode": d.payment_mode, "claimed_paid": d.claimed_paid, "payment_confirmed": d.payment_confirmed,
           "customer": {"name": d.customer_name, "wa_number": d.customer_phone},
           "address": {"text": d.address_text, "lat": float(d.lat) if d.lat is not None else None,
                       "lng": float(d.lng) if d.lng is not None else None}}
    return out
