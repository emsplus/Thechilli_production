"""Feature access: what a restaurant may use and what its owner has switched on.

Two independent layers decide whether a feature is available to a restaurant:

1. GRANT (super admin). platform-core entitlements: the plan's features, overlaid with per-tenant overrides
   (docs/ENTITLEMENTS.md). Only super admin can change it. Under ENTITLEMENTS_ENFORCE=off nothing is known and everything is
   granted; a feature code the tenant's map does not mention follows ENTITLEMENTS_ABSENT_FEATURE (default allow).
2. SWITCH (restaurant owner). `restaurants.feature_prefs`, a JSON object {code: bool}. A code that is absent is ON. The owner can
   only switch OFF what is granted, and switch ON again what was granted; he can never switch on what super admin withheld.

A feature is available when it is granted AND not switched off. The catalogue below is the one list of the controllable things:
the order types, what the bill screen may do, and the back-office modules. Codes are platform-core feature codes
(platform-core alembic 0008 adds the new ones to every plan, so nothing is taken away by shipping this).

Enforcement is server-side (`require`, `allowed`, and `require_feature` in api/deps.py for whole routers); the web apps hide what
is not available from `GET /restaurant` -> `features` and `GET /auth/me` -> `features`, but hiding is only a courtesy.

Error codes (error.code in the body, app/core/errors.py): 403 `feature_not_entitled` (super admin has not granted it) and
403 `feature_switched_off` (the owner switched it off). Both messages say what to do.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from fastapi import HTTPException

from app.services import audit, entitlements
from app.services.entitlements import EntitlementError

log = logging.getLogger("app.feature_access")

NOT_ENTITLED = "feature_not_entitled"
SWITCHED_OFF = "feature_switched_off"
LAST_ORDER_TYPE = "at_least_one_order_type"


@dataclass(frozen=True)
class Feature:
    code: str          # platform-core feature code
    label: str         # shown to the owner (Manage > Features) and in error messages
    group: str         # order_types | billing | modules
    description: str


GROUP_LABELS = {"order_types": "Order types", "billing": "Billing", "modules": "Modules"}

CATALOGUE: tuple[Feature, ...] = (
    Feature("order.indoor", "Dine-in orders", "order_types", "Orders for tables inside the restaurant."),
    Feature("order.outdoor", "Outdoor orders", "order_types", "Orders for outdoor, garden or terrace tables."),
    Feature("order.takeaway", "Takeaway orders", "order_types", "Pickup orders taken at the counter."),
    Feature("delivery", "Delivery orders", "order_types", "Orders that are delivered to the customer."),
    Feature("billing.discount", "Discounts", "billing", "Give a manual discount while billing."),
    Feature("billing.service_charge", "Service charge", "billing", "Add the service charge to dine-in bills."),
    Feature("billing.offers", "Automatic offers", "billing", "Apply the offers from Manage > Offers while billing."),
    Feature("reports", "Reports", "modules", "Sales, tax, staff and stock reports (end of day always stays)."),
    Feature("cash_drawer", "Cash drawer", "modules", "Open and close the cash drawer with a counted float."),
    Feature("customers", "Customers", "modules", "Customer list, visits and loyalty."),
    Feature("expenses", "Expenses", "modules", "Record and scan expenses."),
    Feature("inventory", "Inventory", "modules", "Stock, recipes, suppliers and purchases."),
    Feature("ai.copilot", "Ask AI and voice", "modules", "The AI assistant and voice ordering."),
    Feature("table_qr", "Table QR ordering", "modules", "Guests order from a QR code on the table."),
    Feature("aggregator", "Aggregator orders", "modules", "Orders that arrive from delivery apps."),
)
BY_CODE = {f.code: f for f in CATALOGUE}
CODES = tuple(BY_CODE)
ORDER_TYPE_CODES = ("order.indoor", "order.outdoor", "order.takeaway", "delivery")


def prefs_of(restaurant) -> dict:
    """The owner's switches, tolerant of a missing / invalid stored value."""
    v = getattr(restaurant, "feature_prefs", None)
    return {k: bool(x) for k, x in v.items() if k in BY_CODE} if isinstance(v, dict) else {}


def switched_on(prefs: dict | None, code: str) -> bool:
    return (prefs or {}).get(code, True) is not False


def granted(e: "entitlements.Entitlements | None", code: str) -> bool:
    """Super admin's side. None (ENTITLEMENTS_ENFORCE=off) and a suspended tenant (the read-only rule applies, not a feature
    rule, so what it could read stays visible) count as granted."""
    if e is None or e.suspended:
        return True
    return e.feature_enabled(code)


def effective(restaurant, e: "entitlements.Entitlements | None") -> dict[str, bool]:
    """code -> available, for the web apps (GET /restaurant, GET /auth/me)."""
    prefs = prefs_of(restaurant)
    return {c: granted(e, c) and switched_on(prefs, c) for c in CODES}


def view(restaurant, e: "entitlements.Entitlements | None") -> list[dict]:
    """The owner's Manage > Features list: every controllable feature with who decides what."""
    prefs = prefs_of(restaurant)
    out = []
    for f in CATALOGUE:
        g, on = granted(e, f.code), switched_on(prefs, f.code)
        out.append({"code": f.code, "label": f.label, "group": f.group, "group_label": GROUP_LABELS[f.group],
                    "description": f.description, "granted": g, "switched_on": on, "available": g and on})
    return out


def _restaurant(db, restaurant_id):
    from app.models.core import Restaurant
    return db.get(Restaurant, restaurant_id)


def allowed(db, restaurant_id, code: str) -> bool:
    """Non-raising: is the feature usable right now? Mirrors `require` (the grant only counts while entitlements are enforced)."""
    if entitlements.mode() == "on" and not granted(entitlements.cache().get(restaurant_id), code):
        return False
    return switched_on(prefs_of(_restaurant(db, restaurant_id)), code)


def require(db, restaurant_id, code: str, *, grant: bool = True) -> None:
    """403 `feature_not_entitled` / `feature_switched_off`. `grant=False` checks only the owner's switch (for callers that already
    ran the entitlement rule, like business_type.require for delivery / aggregator)."""
    name = BY_CODE[code].label if code in BY_CODE else code
    mode = entitlements.mode()
    if grant and mode != "off":
        e = entitlements.cache().get(restaurant_id)
        if not e.suspended and not e.feature_enabled(code):
            if mode == "on":
                raise EntitlementError(403, NOT_ENTITLED, f"{name} is not included in your plan. Ask support to turn it on.")
            log.warning("entitlements(warn): tenant %s lacks feature %s", restaurant_id, code)
    if code in BY_CODE and not switched_on(prefs_of(_restaurant(db, restaurant_id)), code):
        raise EntitlementError(403, SWITCHED_OFF, f"{name} is switched off for this restaurant. "
                                                  "The owner can turn it on in Manage > Features.")


def update(db, actor, restaurant, changes: dict[str, bool]) -> dict:
    """Owner: switch granted features on or off. 422 for an unknown code; 403 `feature_not_entitled` when asked to switch ON what
    super admin has not granted; 409 `at_least_one_order_type` when the change would leave no order type to take orders with.
    Audit-logged (restaurant.features). The caller commits. Returns {before, after, changed}."""
    from app.services import business_type
    unknown = sorted(c for c in changes if c not in BY_CODE)
    if unknown:
        raise HTTPException(422, f"Unknown feature: {', '.join(unknown)}")
    e = entitlements.current(restaurant.id)
    before = prefs_of(restaurant)
    after = dict(before)
    for code, on in changes.items():
        if on and not granted(e, code):
            raise EntitlementError(403, NOT_ENTITLED, f"{BY_CODE[code].label} is not included in your plan. Ask support to turn it on.")
        after[code] = bool(on)
    types = business_type.stored(restaurant)
    if not business_type.capabilities(types, e, prefs=after)["order_types"]:
        err = HTTPException(409, "At least one order type must stay on, or no order can be taken.")
        err.code = LAST_ORDER_TYPE
        raise err
    changed = sorted(c for c in after if after[c] != before.get(c, True))
    restaurant.feature_prefs = after  # a new dict: SQLAlchemy sees the JSON change
    audit.record(db, actor, "restaurant.features", "restaurant", restaurant.id,
                 {"changed": {c: after[c] for c in changed}, "before": before, "after": after})
    return {"before": before, "after": after, "changed": changed}
