"""Business types and what each one may use (docs/BUSINESS_TYPES.md).

A business selects ONE OR MORE types at sign-up (owner decision 2026-10-31): restaurant (also cafes), cloud_kitchen,
hotel_kitchen. A hotel kitchen is the cloud-kitchen setup (owner decision 2026-10-30: no room-service build), so a hotel with
an in-house restaurant selects hotel_kitchen + restaurant. The selection is stored on `restaurants.business_types` (the
master prompt's business_profiles live on the restaurants row). Capabilities are the UNION over the selected types:

- restaurant: dine-in (indoor / outdoor orders), tables, reservations, the waiter table flow.
- cloud_kitchen / hotel_kitchen: takeaway + delivery only, no tables; the delivery and aggregator modules are on by default.
- every type: takeaway, waiter app (order taking), kitchen display, inventory, reports.

The delivery / aggregator modules are entitlements (platform-core feature codes `delivery`, `aggregator`; platform-core turns
them on by default when a cloud / hotel kitchen is selected and staff may switch them off). While entitlements are not
enforced (ENTITLEMENTS_ENFORCE=off, nothing is known) the type defaults apply.

`capabilities(types, entitlements, outlet)` takes the outlet so a per-outlet override can be added later without an API break;
today the set lives at business level only. Enforcement is server-side through `require()` / `require_order_type()`: 409 with
error.code `not_available_for_business_type` (delivery and aggregator follow the entitlements, only when they are enforced).
"""
from __future__ import annotations

import logging
import uuid
from typing import Iterable

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

log = logging.getLogger("app.business_type")

TYPES = ("restaurant", "cloud_kitchen", "hotel_kitchen")  # canonical order
DEFAULT = ["restaurant"]
KITCHEN_TYPES = frozenset({"cloud_kitchen", "hotel_kitchen"})
ERROR_CODE = "not_available_for_business_type"

LABELS = {"restaurant": "Restaurant or cafe", "cloud_kitchen": "Cloud kitchen", "hotel_kitchen": "Hotel kitchen"}
DESCRIPTIONS = {
    "restaurant": "Guests eat in: tables, dine-in orders, reservations and the waiter table flow, plus takeaway.",
    "cloud_kitchen": "Delivery-only or pickup kitchen: takeaway and delivery orders, no tables or dine-in.",
    "hotel_kitchen": "A hotel's food service run like a cloud kitchen: takeaway and delivery orders, no tables. "
                     "Select Restaurant as well if the hotel has a dine-in restaurant.",
}
# Human names of the capabilities, for error messages.
CAP_NAMES = {"dine_in": "Dine-in orders", "outdoor": "Outdoor orders", "tables": "Tables", "reservations": "Reservations",
             "waiter_table_flow": "Table service", "delivery_orders": "Delivery orders", "aggregator": "Aggregator orders",
             "takeaway": "Takeaway orders"}
# Capability keys, in the order they are returned.
KEYS = ("dine_in", "outdoor", "takeaway", "delivery_orders", "tables", "reservations", "waiter_app", "waiter_table_flow",
        "kitchen_display", "inventory", "aggregator")


# Optional modules (entitlements, not the business type): what the owner is told when the module is off.
MODULES = {"delivery_orders": "delivery", "aggregator": "aggregator"}
MODULE_MESSAGES = {
    "delivery_orders": "Delivery orders are not turned on for this business. Ask the owner to turn on delivery.",
    "aggregator": "Aggregator orders are not turned on for this business. Ask the owner to turn on aggregator orders.",
}


class NotAvailable(HTTPException):
    """409 not_available_for_business_type (error.code via app/core/errors.py)."""

    def __init__(self, capability: str, types: Iterable[str]):
        what = CAP_NAMES.get(capability, capability)
        names = " + ".join(LABELS[t] for t in normalize(list(types)))
        super().__init__(409, MODULE_MESSAGES.get(capability) or f"{what} are not available for this business type ({names}). "
                                                                 "Change the business type in Settings to use them.")
        self.code = ERROR_CODE
        self.capability = capability


def normalize(values: Iterable[str] | None) -> list[str]:
    """Dedupe into the canonical order. Raises ValueError on an unknown value or an empty selection."""
    vals = list(values) if values is not None else []
    bad = [v for v in vals if v not in TYPES]
    if bad:
        raise ValueError(f"Unknown business type: {', '.join(map(str, bad))}. Allowed: {', '.join(TYPES)}")
    out = [t for t in TYPES if t in vals]
    if not out:
        raise ValueError("Select at least one business type")
    return out


def stored(r) -> list[str]:
    """The restaurant's selection, tolerant of a missing / invalid stored value (falls back to restaurant)."""
    try:
        return normalize(getattr(r, "business_types", None) or DEFAULT)
    except ValueError:
        return list(DEFAULT)


def type_capabilities(t: str) -> dict:
    """What a single type gives (no entitlement applied): the catalogue's per-type column."""
    return capabilities([t])


def capabilities(types: Iterable[str], entitlements=None, outlet=None, prefs: dict | None = None) -> dict:
    """The union over the selected types. `entitlements` (services.entitlements.Entitlements or None) drives the optional
    delivery / aggregator modules and the order-type features (services/feature_access.py); None (enforcement off) = the type
    defaults. `prefs` = the owner's switches (`restaurants.feature_prefs`); None = nothing switched off. `outlet` is reserved
    for a later per-outlet override (unused today)."""
    from app.services import feature_access as fa
    sel = set(normalize(types))
    dine = "restaurant" in sel
    kitchen = bool(sel & KITCHEN_TYPES)

    def module(code: str) -> bool:
        base = kitchen if entitlements is None else bool(entitlements.feature_enabled(code))  # type default when nothing is known
        return base and fa.switched_on(prefs, code)

    def open_(code: str) -> bool:  # super admin granted it (absent = allowed) and the owner has not switched it off
        return fa.granted(entitlements, code) and fa.switched_on(prefs, code)

    delivery = module("delivery")
    indoor, outdoor = dine and open_("order.indoor"), dine and open_("order.outdoor")
    takeaway = open_("order.takeaway")
    seating = indoor or outdoor  # tables / reservations / table service only make sense while a seated order type is on
    caps = {
        "dine_in": indoor, "outdoor": outdoor, "takeaway": takeaway, "delivery_orders": delivery,
        "tables": seating, "reservations": seating, "waiter_app": True, "waiter_table_flow": seating,
        "kitchen_display": True, "inventory": True, "aggregator": module("aggregator"),
    }
    caps["order_types"] = [*(["indoor"] if indoor else []), *(["outdoor"] if outdoor else []), *(["takeaway"] if takeaway else []),
                           *(["delivery"] if delivery else [])]
    return caps


def catalogue() -> list[dict]:
    """GET /business-types: what the sign-up wizard renders ('What do you run? (choose one or more)')."""
    return [{"id": t, "label": LABELS[t], "description": DESCRIPTIONS[t], "capabilities": type_capabilities(t)} for t in TYPES]


def for_restaurant(db: Session, restaurant_id, outlet_id=None) -> tuple[list[str], dict]:
    from app.models.core import Restaurant
    from app.services import entitlements, feature_access
    r = db.get(Restaurant, restaurant_id)
    types = stored(r)
    try:
        e = entitlements.current(restaurant_id)
    except Exception:  # pragma: no cover - entitlements never raise for an outage; never let capabilities fail a request
        e = None
    return types, capabilities(types, e, outlet_id, feature_access.prefs_of(r))


def _business_caps(db: Session, restaurant_id) -> tuple[list[str], dict]:
    """Business-type part only (no entitlements): what enforcement checks. The delivery / aggregator modules are gated by
    entitlements (require_feature), not here."""
    from app.models.core import Restaurant
    types = stored(db.get(Restaurant, restaurant_id))
    return types, capabilities(types, None)


# Capability -> the feature code (platform-core catalogue, services/feature_access.py) that super admin grants and the owner may switch off.
CAP_FEATURE = {"dine_in": "order.indoor", "outdoor": "order.outdoor", "takeaway": "order.takeaway",
               "delivery_orders": "delivery", "aggregator": "aggregator"}


def require(db: Session, restaurant_id, capability: str) -> None:
    """409 not_available_for_business_type. Business-type capabilities are checked from the stored selection. The optional
    modules (delivery_orders, aggregator) follow the entitlements, and only when they are enforced (ENTITLEMENTS_ENFORCE=on):
    off / warn know nothing about modules, so nothing is refused (warn only logs). On top of that the order types and modules are
    feature-access rules (services/feature_access.py): 403 `feature_not_entitled` when super admin has not granted the feature and
    403 `feature_switched_off` when the owner switched it off (that one holds under every ENTITLEMENTS_ENFORCE mode)."""
    from app.services import feature_access
    types, caps = _business_caps(db, restaurant_id)
    if capability in MODULES:
        from app.services import entitlements
        mode = entitlements.mode()
        if mode == "off":
            feature_access.require(db, restaurant_id, CAP_FEATURE[capability], grant=False)
            return
        if not capabilities(types, entitlements.cache().get(restaurant_id))[capability]:
            if mode == "on":
                raise NotAvailable(capability, types)
            log.warning("entitlements(warn): tenant %s has %s switched off", restaurant_id, capability)
        feature_access.require(db, restaurant_id, CAP_FEATURE[capability], grant=False)
        return
    if not caps.get(capability, False):
        raise NotAvailable(capability, types)
    if capability in CAP_FEATURE:
        feature_access.require(db, restaurant_id, CAP_FEATURE[capability])


# order_type value -> the capability that order type needs (dine-in and outdoor are checked separately).
ORDER_TYPE_CAPABILITY = {"indoor": "dine_in", "outdoor": "outdoor", "takeaway": "takeaway", "delivery": "delivery_orders"}


def require_order_type(db: Session, restaurant_id, order_type) -> None:
    """The one rule for creating an order of this type (POST /orders, offline sync, voice commit, reservation seating, and the
    delivery-service order endpoint): indoor needs dine_in, outdoor needs outdoor, delivery needs the delivery module."""
    cap = ORDER_TYPE_CAPABILITY.get(getattr(order_type, "value", order_type))
    if cap:
        require(db, restaurant_id, cap)


# ----------------------------------------------------------------------------------------------- changing the selection
OPEN_ORDERS_CODE = "open_orders_block_business_type_change"


def open_order_count(db: Session, restaurant_id) -> int:
    from sqlalchemy import func
    from app.models.core import Order, OrderStatus
    return db.scalar(select(func.count()).select_from(Order).where(
        Order.restaurant_id == restaurant_id, Order.status.in_((OrderStatus.open, OrderStatus.sent_to_kitchen)))) or 0


def change(db: Session, r, new: Iterable[str], actor, *, staff: bool = False, reason: str | None = None) -> dict:
    """Replace the selection. Owner: refused (409 open_orders_block_business_type_change) while any order is open, so nothing
    in flight loses its table / dine-in flow. Platform staff (`staff=True`): allowed regardless. Nothing is archived or
    deleted: removing restaurant only HIDES tables / reservations (they come back when the type is selected again).
    Audit-logged as restaurant.business_types. Returns {before, after, hidden, shown}. The caller commits."""
    from app.services import audit
    after = normalize(new)
    before = stored(r)
    if after == before:
        return {"before": before, "after": after, "changed": False, "hidden": [], "shown": []}
    if not staff:
        n = open_order_count(db, r.id)
        if n:
            e = HTTPException(409, f"Close or bill the {n} open order(s) before changing the business type.")
            e.code = OPEN_ORDERS_CODE
            raise e
    cb, ca = capabilities(before), capabilities(after)
    hidden = [k for k in KEYS if cb[k] and not ca[k]]
    shown = [k for k in KEYS if ca[k] and not cb[k]]
    r.business_types = after
    detail = {"before": before, "after": after, "hidden": hidden, "shown": shown}
    if reason:
        detail["reason"] = reason[:300]
    if staff:
        detail["by"] = "platform"
    audit.record(db, actor, "restaurant.business_types", "restaurant", r.id, detail)
    return {**detail, "changed": True}


def system_actor(restaurant_id: uuid.UUID):
    """An audit actor for platform-core calls (no tenant user)."""
    from types import SimpleNamespace
    return SimpleNamespace(restaurant_id=restaurant_id, user_id=None, support=None)
