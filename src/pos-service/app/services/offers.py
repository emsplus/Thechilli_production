"""Automatic offers (docs/MODIFIERS_OFFERS.md): which configured offers apply to an order, and how much each takes off which
line. The evaluation is PURE (no DB): `evaluate()` and `combine()` are unit-tested directly; `for_order()` loads the offers.

Rules
* An offer applies when it is active, its outlet is the order's (or it has none), the order type is listed (or none are),
  and the ORDER's creation time (outlet-local) is inside every window it has: valid_from..valid_to (dates, inclusive),
  days_of_week (Monday = 0) and start_time..end_time (start inclusive, end exclusive; start > end spans midnight). Using the
  order time (not the bill time) makes the preview and the bill agree, and an order placed at lunch keeps its lunch offer.
* min_order_value is compared with the item total before any discount.
* Eligible lines: every line (scope bill), the lines of the listed items (item) or categories (category).
* percent: value % of the eligible amount. amount: once per bill (scope bill), or per unit of each eligible line (item /
  category: '20 off every lassi'), never more than the line. max_discount caps one offer on one bill.
* Never stacking unless configured: of the offers that are not `stackable`, only the one giving the largest discount applies
  (ties: higher priority, then name); every `stackable` offer is added after it, each on what is left of the lines.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, time
from decimal import Decimal
from typing import Any, Sequence
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.permissions import P
from app.models.core import Category, MenuItem, Outlet
from app.models.menu_extras import OFFER_KINDS, OFFER_SCOPES, Offer
from app.services import audit
from app.services.tax import ZERO, allocate, money

LABEL_PREFIX = "Offer: "


@dataclass(frozen=True)
class OLine:
    item_id: Any
    category_id: Any
    amount: Decimal  # line amount before any discount (unit price x quantity, rounded), in the bill's price mode
    quantity: int


@dataclass
class Applied:
    offer_id: uuid.UUID
    name: str
    amount: Decimal
    shares: list[Decimal]  # per order line, adds up to amount

    @property
    def label(self) -> str:
        return label_of(self.name)

    def as_dict(self) -> dict:
        return {"offer_id": str(self.offer_id), "name": self.name, "label": self.label, "amount": str(self.amount)}


def label_of(name: str) -> str:
    return f"{LABEL_PREFIX}{name}"


# ------------------------------------------------------------------------------------------------ pure evaluation
def _value(x) -> str:
    return getattr(x, "value", x)


def in_window(o, at_local: datetime, order_type: Any = None, outlet_id: Any = None) -> bool:
    if not o.is_active:
        return False
    if o.outlet_id is not None and outlet_id is not None and o.outlet_id != outlet_id:
        return False
    if o.order_types and order_type is not None and _value(order_type) not in o.order_types:
        return False
    d = at_local.date()
    if o.valid_from and d < o.valid_from:
        return False
    if o.valid_to and d > o.valid_to:
        return False
    if o.days_of_week is not None and len(o.days_of_week) and at_local.weekday() not in o.days_of_week:
        return False
    if o.start_time is not None or o.end_time is not None:
        t = at_local.time().replace(tzinfo=None)
        start, end = o.start_time or time(0, 0), o.end_time or time(23, 59, 59, 999999)
        if start <= end:
            if not (start <= t < end):
                return False
        elif not (t >= start or t < end):  # spans midnight, e.g. 22:00-02:00
            return False
    return True


def _targets(o) -> set[str]:
    return {str(t) for t in (o.target_ids or [])}


def _raw(o, lines: Sequence[OLine], left: Sequence[Decimal]) -> list[Decimal]:
    """Per line, what the offer would take before the max_discount cap (0 for lines it does not cover)."""
    tg = _targets(o)
    out = []
    for ln, rest in zip(lines, left):
        if o.scope == "item":
            ok = str(ln.item_id) in tg
        elif o.scope == "category":
            ok = str(ln.category_id) in tg
        else:
            ok = True
        out.append(rest if ok and rest > 0 else ZERO)
    return out


def _amount(o, lines: Sequence[OLine], left: Sequence[Decimal]) -> tuple[Decimal, list[Decimal]]:
    base = _raw(o, lines, left)
    eligible = sum(base, ZERO)
    if eligible <= 0:
        return ZERO, [ZERO] * len(lines)
    value = Decimal(o.value)
    if o.kind == "percent":
        total, weights = money(eligible * value / 100), base
    elif o.scope == "bill":
        total, weights = min(money(value), eligible), base
    else:  # per unit of each eligible line, never more than what is left of the line
        weights = [min(money(value * ln.quantity), b) if b > 0 else ZERO for ln, b in zip(lines, base)]
        total = sum(weights, ZERO)
    if o.max_discount is not None:
        total = min(total, money(Decimal(o.max_discount)))
    total = min(total, eligible)
    if total <= 0:
        return ZERO, [ZERO] * len(lines)
    shares = allocate(total, weights)
    return total, [min(s, b) for s, b in zip(shares, base)]  # allocate is proportional, so never above a line's weight


def evaluate(offers: Sequence, lines: Sequence[OLine], at_local: datetime, order_type: Any = None,
             outlet_id: Any = None) -> list[Applied]:
    amounts = [ln.amount for ln in lines]
    items_total = sum(amounts, ZERO)
    live = [o for o in offers if in_window(o, at_local, order_type, outlet_id)
            and items_total >= Decimal(o.min_order_value or 0)]
    if not live or items_total <= 0:
        return []
    best, best_amt = None, ZERO
    for o in sorted((o for o in live if not o.stackable), key=lambda o: (-o.priority, o.name, str(o.id))):
        amt, _ = _amount(o, lines, amounts)
        if amt > best_amt:
            best, best_amt = o, amt
    chosen = ([best] if best is not None else []) + sorted(
        (o for o in live if o.stackable), key=lambda o: (-o.priority, o.name, str(o.id)))
    left = list(amounts)
    out: list[Applied] = []
    for o in chosen:
        amt, shares = _amount(o, lines, left)
        if amt <= 0:
            continue
        left = [l - s for l, s in zip(left, shares)]
        out.append(Applied(o.id, o.name, amt, shares))
    return out


def combine(applied: Sequence[Applied], amounts: Sequence[Decimal], manual) -> tuple[list[Decimal], Decimal, Decimal]:
    """Line discounts of the bill when offers apply: the offers' shares plus the manual discount (a tax.DiscountIn, already
    validated), which is taken from what the offers left (percent of the post-offer amount, or an amount), spread
    proportionally. Returns (line_discounts, offer_total, manual_amount). Raises ValueError when the manual discount is
    larger than what is left."""
    n = len(amounts)
    offer_shares = [sum((a.shares[i] for a in applied), ZERO) for i in range(n)]
    offer_total = sum(offer_shares, ZERO)
    left = [a - s for a, s in zip(amounts, offer_shares)]
    rest = sum(left, ZERO)
    manual_amt = ZERO
    if manual is not None:
        manual_amt = money(rest * manual.value / 100) if manual.type == "percent" else money(manual.value)
        if manual_amt > rest:
            raise ValueError("Discount cannot exceed the bill total after offers")
    m_shares = allocate(manual_amt, left) if manual_amt > 0 else [ZERO] * n
    return [o + m for o, m in zip(offer_shares, m_shares)], offer_total, manual_amt


def reason_of(applied: Sequence[Applied], manual_reason: str | None) -> str:
    parts = [a.label for a in applied] + ([manual_reason] if manual_reason else [])
    return "; ".join(parts)[:200]


# ------------------------------------------------------------------------------------------------ DB side
def order_local_time(db: Session, order) -> datetime:
    tz = db.scalar(select(Outlet.timezone).where(Outlet.id == order.outlet_id)) or "UTC"
    at = order.created_at or datetime.now(ZoneInfo("UTC"))
    return at.astimezone(ZoneInfo(tz))


def for_order(db: Session, order, line_amounts: Sequence[Decimal]) -> list[Applied]:
    """The offers that apply to `order` (lines in order.lines order, amounts already computed by the caller). A restaurant
    without active offers costs one indexed query and nothing else."""
    offers = db.scalars(select(Offer).where(Offer.restaurant_id == order.restaurant_id, Offer.is_active)).all()
    if not offers:
        return []
    cats = dict(db.execute(select(MenuItem.id, MenuItem.category_id).where(
        MenuItem.id.in_({l.item_id for l in order.lines}))).all())
    lines = [OLine(l.item_id, cats.get(l.item_id), a, l.quantity) for l, a in zip(order.lines, line_amounts)]
    return evaluate(offers, lines, order_local_time(db, order), order.order_type, order.outlet_id)


# ------------------------------------------------------------------------------------------------ management
FIELDS = ("name", "kind", "value", "scope", "target_ids", "min_order_value", "max_discount", "days_of_week", "start_time",
          "end_time", "valid_from", "valid_to", "order_types", "stackable", "priority", "outlet_id")


def _check(db: Session, p, data) -> dict:
    from app.models.core import Restaurant
    if data.kind not in OFFER_KINDS or data.scope not in OFFER_SCOPES:
        raise HTTPException(422, "Unknown offer kind / scope")
    if data.kind == "percent" and data.value > 100:
        raise HTTPException(422, "A percent offer cannot exceed 100%")
    targets = [str(t) for t in (data.target_ids or [])]
    if data.scope == "bill":
        if targets:
            raise HTTPException(422, "A bill offer has no target items or categories")
        targets = None
    else:
        if not targets:
            raise HTTPException(422, f"Choose at least one {'item' if data.scope == 'item' else 'category'} for this offer")
        model = MenuItem if data.scope == "item" else Category
        ids = {uuid.UUID(t) for t in targets}
        found = set(db.scalars(select(model.id).where(model.id.in_(ids), model.restaurant_id == p.restaurant_id)))
        if found != ids:
            raise HTTPException(404, f"{'Menu item' if data.scope == 'item' else 'Category'} not found")
        targets = sorted(targets)
    if data.valid_from and data.valid_to and data.valid_to < data.valid_from:
        raise HTTPException(422, "valid_to is before valid_from")
    if (data.start_time is None) != (data.end_time is None):
        raise HTTPException(422, "Give both start_time and end_time, or neither")
    if data.start_time is not None and data.start_time == data.end_time:
        raise HTTPException(422, "start_time and end_time must differ")
    if data.outlet_id is not None:
        o = db.get(Outlet, data.outlet_id)
        if not o or o.restaurant_id != p.restaurant_id:
            raise HTTPException(404, "Outlet not found")
    # Stored discounts respect the cashier cap: a user who is not above the cap cannot create an offer that is.
    if data.kind == "percent" and not p.can(P.BILLS_DISCOUNT_OVER_LIMIT):
        cap = db.get(Restaurant, p.restaurant_id).max_cashier_discount_percent
        if data.value > cap:
            raise HTTPException(403, f"Offers above {cap.normalize():f}% need a manager or owner")
    values = {k: getattr(data, k) for k in FIELDS}
    values["target_ids"] = targets
    values["days_of_week"] = sorted(set(data.days_of_week)) if data.days_of_week else None
    values["order_types"] = sorted({_value(t) for t in data.order_types}) if data.order_types else None
    values["name"] = data.name.strip()
    return values


def _audit_view(values: dict) -> dict:
    return {k: (str(v) if v is not None and not isinstance(v, (bool, int, list)) else v) for k, v in values.items()}


def create(db: Session, p, data) -> Offer:
    values = _check(db, p, data)
    o = Offer(restaurant_id=p.restaurant_id, created_by=p.user_id, is_active=data.is_active, **values)
    db.add(o)
    db.flush()
    audit.record(db, p, "offer.create", "offer", o.id, _audit_view({**values, "is_active": data.is_active}))
    db.commit()
    return o


def _own(db: Session, p, offer_id: uuid.UUID) -> Offer:
    o = db.get(Offer, offer_id, with_for_update=True)
    if not o or o.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Offer not found")
    return o


def update(db: Session, p, offer_id: uuid.UUID, data) -> Offer:
    o = _own(db, p, offer_id)
    values = {**_check(db, p, data), "is_active": data.is_active}
    changes = {k: {"old": getattr(o, k), "new": v} for k, v in values.items() if getattr(o, k) != v}
    for k, v in values.items():
        setattr(o, k, v)
    if changes:
        audit.record(db, p, "offer.update", "offer", o.id,
                     {k: _audit_view(c) for k, c in changes.items()})
    db.commit()
    db.refresh(o)  # numeric columns come back quantized, like a fresh GET
    return o


def set_active(db: Session, p, offer_id: uuid.UUID, active: bool) -> Offer:
    o = _own(db, p, offer_id)
    if o.is_active != active:
        o.is_active = active
        audit.record(db, p, "offer.activate" if active else "offer.deactivate", "offer", o.id, {"name": o.name})
    db.commit()
    return o


def list_offers(db: Session, p, include_inactive: bool = False) -> list[Offer]:
    q = select(Offer).where(Offer.restaurant_id == p.restaurant_id)
    if not include_inactive:
        q = q.where(Offer.is_active)
    return db.scalars(q.order_by(Offer.priority.desc(), Offer.name)).all()


def active_now(db: Session, p, outlet_id: uuid.UUID) -> list[Offer]:
    """Offers whose window contains the current outlet-local time (any order type): for a POS hint ('Lunch 10% on now')."""
    tz = db.scalar(select(Outlet.timezone).where(Outlet.id == outlet_id)) or "UTC"
    now = datetime.now(ZoneInfo(tz))
    return [o for o in list_offers(db, p) if in_window(o, now, None, outlet_id)]
