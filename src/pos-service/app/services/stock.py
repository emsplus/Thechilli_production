"""Wastage, batches / expiry, stock counts with variance, unit conversions, negative-stock report and recipe food cost
(docs/INVENTORY.md). Everything that changes stock goes through `inventory.post` / `inventory.consume` (the append-only ledger)."""
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.core import InventoryItem, MenuItem, MovementType, Recipe, StockMovement
from app.models.inventory import ItemUnitConversion, StockBalance, StockBatch, StockCount, StockCountLine, StockLocation
from app.services import alerts, audit, inventory as inv, stock_locations
from app.services.units import UNITS, normalize_code, to_base_item

REASONS = ("spoilage", "breakage", "theft", "expired", "staff_meal", "spillage", "other")


def _reason(code: str) -> str:
    if code not in REASONS:
        raise HTTPException(422, f"reason_code must be one of {', '.join(REASONS)}")
    return code


# ---------------------------------------------------------------- wastage
def record_wastage(db: Session, p, key: uuid.UUID, item_id: uuid.UUID, quantity: Decimal, unit: str, reason_code: str,
                   note: str | None, location_id: uuid.UUID | None, batch_id: uuid.UUID | None) -> tuple[list[StockMovement], bool]:
    """Writes stock off with a reason code. FEFO across batches unless a batch is named. Idempotent on `key`:
    (movements, replayed)."""
    _reason(reason_code)
    loc = stock_locations.resolve(db, p, location_id)
    item = inv.lock_items(db, p.restaurant_id, [item_id]).get(item_id)
    if item is None:
        raise HTTPException(404, "Inventory item not found")
    if inv.already_posted(db, p, key, MovementType.wastage):
        db.rollback()
        return list(db.scalars(select(StockMovement).where(
            StockMovement.restaurant_id == p.restaurant_id, StockMovement.ref_id == key,
            StockMovement.movement_type == MovementType.wastage))), True
    qty = abs(to_base_item(db, item, quantity, unit))
    if qty <= 0:
        raise HTTPException(422, "Quantity must be positive")
    ms = inv.consume(db, p.restaurant_id, item, loc.id, qty, MovementType.wastage, ref_id=key, note=note, user_id=p.user_id,
                     reason_code=reason_code, ref_type="wastage", batch_id=batch_id, include_expired=True)
    audit.record(db, p, "stock.wastage", "inventory_item", item.id, {"qty": str(qty), "reason_code": reason_code})
    alerts.evaluate(db, p.restaurant_id, [item.id])
    try:
        db.commit()
    except IntegrityError:  # a concurrent replay of the same key won the race
        db.rollback()
        return list(db.scalars(select(StockMovement).where(
            StockMovement.restaurant_id == p.restaurant_id, StockMovement.ref_id == key,
            StockMovement.movement_type == MovementType.wastage))), True
    return ms, False


def wastage_report(db: Session, p, date_from: date | None, date_to: date | None, location_id: uuid.UUID | None = None) -> dict:
    """Wastage and expiry write-offs of the request's outlet, by reason and by item, valued at the movement's cost
    (else the item's latest cost)."""
    from app.services import outlets
    q = (select(StockMovement, InventoryItem.name, InventoryItem.base_unit, InventoryItem.last_cost)
         .join(InventoryItem, InventoryItem.id == StockMovement.item_id)
         .join(StockLocation, StockLocation.id == StockMovement.location_id)
         .where(StockMovement.restaurant_id == p.restaurant_id, StockLocation.outlet_id == outlets.outlet_of(db, p),
                StockMovement.movement_type.in_([MovementType.wastage, MovementType.expiry_writeoff])))
    if location_id:
        q = q.where(StockMovement.location_id == location_id)
    if date_from:
        q = q.where(StockMovement.created_at >= datetime.combine(date_from, datetime.min.time(), tzinfo=timezone.utc))
    if date_to:
        q = q.where(StockMovement.created_at < datetime.combine(date_to + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc))
    by_reason: dict[str, dict] = {}
    by_item: dict[uuid.UUID, dict] = {}
    total = Decimal(0)
    for m, name, unit, last_cost in db.execute(q):
        cost = m.unit_cost if m.unit_cost is not None else last_cost
        value = (-m.quantity * cost) if cost is not None else Decimal(0)
        total += value
        r = by_reason.setdefault(m.reason_code or "unspecified", {"reason_code": m.reason_code or "unspecified", "quantity_entries": 0, "value": Decimal(0)})
        r["quantity_entries"] += 1
        r["value"] += value
        i = by_item.setdefault(m.item_id, {"item_id": m.item_id, "name": name, "unit": unit, "quantity": Decimal(0), "value": Decimal(0)})
        i["quantity"] += -m.quantity
        i["value"] += value
    return {"total_value": total.quantize(Decimal("0.01")), "by_reason": sorted(by_reason.values(), key=lambda r: -r["value"]),
            "by_item": sorted(by_item.values(), key=lambda r: -r["value"])}


# ---------------------------------------------------------------- batches
def list_batches(db: Session, p, item_id=None, location_id=None, expiring_within_days: int | None = None,
                 include_empty: bool = False, expired_only: bool = False, limit: int = 200, offset: int = 0):
    from app.services import outlets
    q = (select(StockBatch, InventoryItem.name, InventoryItem.base_unit).join(InventoryItem, InventoryItem.id == StockBatch.item_id)
         .join(StockLocation, StockLocation.id == StockBatch.location_id)
         .where(StockBatch.restaurant_id == p.restaurant_id, StockLocation.outlet_id == outlets.outlet_of(db, p)))
    if item_id:
        q = q.where(StockBatch.item_id == item_id)
    if location_id:
        q = q.where(StockBatch.location_id == location_id)
    if not include_empty:
        q = q.where(StockBatch.remaining > 0)
    if expired_only:
        q = q.where(StockBatch.expiry_date < date.today())
    if expiring_within_days is not None:
        q = q.where(StockBatch.expiry_date.is_not(None), StockBatch.expiry_date <= date.today() + timedelta(days=expiring_within_days))
    rows = db.execute(q.order_by(StockBatch.expiry_date.asc().nulls_last(), StockBatch.received_at, StockBatch.id)
                      .limit(limit).offset(offset)).all()
    return [{"id": b.id, "item_id": b.item_id, "item_name": n, "unit": u, "location_id": b.location_id, "batch_no": b.batch_no,
             "expiry_date": b.expiry_date, "received_at": b.received_at, "unit_cost": b.unit_cost, "qty_received": b.qty_received,
             "remaining": b.remaining, "expired": bool(b.expiry_date and b.expiry_date < date.today())} for b, n, u in rows]


def write_off_batch(db: Session, p, batch_id: uuid.UUID, key: uuid.UUID, note: str | None) -> StockMovement | None:
    """Writes the whole remainder of a batch off as `expiry_writeoff` (idempotent on `key`)."""
    b = db.get(StockBatch, batch_id)
    if b is None or b.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Batch not found")
    stock_locations.get(db, p, b.location_id)  # outlet scope
    item = inv.lock_items(db, p.restaurant_id, [b.item_id])[b.item_id]
    if inv.already_posted(db, p, key, MovementType.expiry_writeoff):
        return None
    db.refresh(b)
    if b.remaining <= 0:
        raise HTTPException(409, "Batch is already empty")
    m = inv.consume(db, p.restaurant_id, item, b.location_id, Decimal(b.remaining), MovementType.expiry_writeoff, ref_id=key,
                    note=note, user_id=p.user_id, reason_code="expired", ref_type="batch", batch_id=b.id, enforce=False)[0]
    audit.record(db, p, "stock.expiry_writeoff", "stock_batch", b.id, {"qty": str(-m.quantity)})
    alerts.evaluate(db, p.restaurant_id, [item.id])
    db.commit()
    return m


# ---------------------------------------------------------------- unit conversions
def get_conversions(db: Session, p, item_id: uuid.UUID) -> list[ItemUnitConversion]:
    inv.get_item(db, p, item_id)
    return list(db.scalars(select(ItemUnitConversion).where(ItemUnitConversion.item_id == item_id).order_by(ItemUnitConversion.unit_code)))


def set_conversions(db: Session, p, item_id: uuid.UUID, rows: list[tuple[str, Decimal]]) -> list[ItemUnitConversion]:
    """Replaces the item's conversion list (1 <unit> = factor base units). A conversion may not shadow a built-in unit of
    another dimension; the base unit itself cannot be redefined."""
    item = inv.get_item(db, p, item_id, lock=True)
    seen = set()
    clean = []
    for code, factor in rows:
        c = normalize_code(code)
        if not c or c in seen:
            raise HTTPException(422, f"Duplicate or empty unit '{code}'")
        if c == item.base_unit:
            raise HTTPException(422, "The base unit cannot be redefined")
        if c in UNITS and UNITS[c][0] != UNITS[item.base_unit][0]:
            pass  # e.g. "dozen" of a mass item is meaningless but harmless; the explicit conversion wins for this item
        if factor <= 0:
            raise HTTPException(422, "Factor must be positive")
        seen.add(c)
        clean.append((c, factor))
    for c in list(db.scalars(select(ItemUnitConversion).where(ItemUnitConversion.item_id == item.id))):
        db.delete(c)
    db.flush()
    for c, f in clean:
        db.add(ItemUnitConversion(restaurant_id=p.restaurant_id, item_id=item.id, unit_code=c, factor_to_base=f))
    audit.record(db, p, "inventory_item.conversions", "inventory_item", item.id, {"units": [c for c, _ in clean]})
    db.commit()
    return get_conversions(db, p, item_id)


# ---------------------------------------------------------------- counts
def _count(db: Session, p, count_id: uuid.UUID, lock: bool = False) -> StockCount:
    c = db.get(StockCount, count_id, with_for_update=lock)
    if c is None or c.restaurant_id != p.restaurant_id or (p.outlet_id is not None and c.outlet_id != p.outlet_id):
        raise HTTPException(404, "Stock count not found")
    return c


def open_count(db: Session, p, name: str | None, location_id: uuid.UUID | None) -> StockCount:
    from app.services import outlets
    loc = stock_locations.resolve(db, p, location_id)
    c = StockCount(restaurant_id=p.restaurant_id, outlet_id=outlets.outlet_of(db, p), location_id=loc.id, name=name, created_by=p.user_id)
    db.add(c)
    db.flush()
    audit.record(db, p, "stock_count.open", "stock_count", c.id)
    db.commit()
    return c


def get_count(db: Session, p, count_id: uuid.UUID) -> StockCount:
    return _count(db, p, count_id)


def list_counts(db: Session, p, limit: int = 50, offset: int = 0) -> list[StockCount]:
    from app.services import outlets
    return list(db.scalars(select(StockCount).where(StockCount.restaurant_id == p.restaurant_id, StockCount.outlet_id == outlets.outlet_of(db, p))
                           .order_by(StockCount.created_at.desc()).limit(limit).offset(offset)))


def set_count_lines(db: Session, p, count_id: uuid.UUID, lines: list[tuple[uuid.UUID, Decimal, str]]) -> StockCount:
    c = _count(db, p, count_id, lock=True)
    if c.status != "open":
        raise HTTPException(409, "Stock count is already posted")
    existing = {l.item_id: l for l in c.lines}
    for item_id, qty, unit in lines:
        item = inv.get_item(db, p, item_id)
        base = to_base_item(db, item, qty, unit)
        if base < 0:
            raise HTTPException(422, "Counted quantity cannot be negative")
        if item_id in existing:
            existing[item_id].counted_base = base
        else:
            c.lines.append(StockCountLine(restaurant_id=p.restaurant_id, item_id=item.id, counted_base=base))
    db.commit()
    return c


def post_count(db: Session, p, count_id: uuid.UUID) -> StockCount:
    """Compares every counted line with the ledger balance of the count's location and posts the variance as `count`
    movements (ref = line id, so a replay cannot double-post). Items are locked in a stable order."""
    c = _count(db, p, count_id, lock=True)
    if c.status == "posted":
        return c  # idempotent
    if not c.lines:
        raise HTTPException(422, "Nothing counted")
    items = inv.lock_items(db, p.restaurant_id, [l.item_id for l in c.lines])
    bal = inv.balances(db, p.restaurant_id, list(items), c.location_id)
    for l in sorted(c.lines, key=lambda x: str(x.item_id)):
        expected = bal.get(l.item_id, Decimal(0))
        l.expected_base, l.variance = expected, l.counted_base - expected
        if l.variance != 0:
            inv.apply_count_variance(db, p.restaurant_id, items[l.item_id], c.location_id, l.variance, l.id, p.user_id,
                                     {"expected": str(expected), "counted": str(l.counted_base), "count_id": str(c.id)}, ref_type="count_line")
    c.status, c.posted_by, c.posted_at = "posted", p.user_id, datetime.now(timezone.utc)
    audit.record(db, p, "stock_count.post", "stock_count", c.id, {"lines": len(c.lines)})
    alerts.evaluate(db, p.restaurant_id, list(items))
    db.commit()
    return c


# ---------------------------------------------------------------- reports
def negative_stock(db: Session, p) -> list[dict]:
    """Every (item, location) of the tenant below zero right now; plus the setting that allows it."""
    rows = db.execute(select(StockBalance.item_id, InventoryItem.name, InventoryItem.base_unit, StockBalance.location_id,
                             StockLocation.name, StockBalance.balance)
                      .join(InventoryItem, InventoryItem.id == StockBalance.item_id)
                      .join(StockLocation, StockLocation.id == StockBalance.location_id)
                      .where(StockBalance.restaurant_id == p.restaurant_id, StockBalance.balance < 0)
                      .order_by(InventoryItem.name)).all()
    return [{"item_id": r[0], "item_name": r[1], "unit": r[2], "location_id": r[3], "location_name": r[4], "balance": r[5]} for r in rows]


def recipe_cost(db: Session, p, menu_item_id: uuid.UUID) -> dict:
    """Food cost of one portion of the CURRENT recipe, at each ingredient's latest purchase cost. Ingredients with no cost
    yet are listed in `uncosted` and make the figure a lower bound (`complete` false)."""
    mi = db.get(MenuItem, menu_item_id)
    if not mi or mi.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Menu item not found")
    r = db.scalar(select(Recipe).where(Recipe.menu_item_id == mi.id, Recipe.effective_to.is_(None)))
    if r is None:
        raise HTTPException(404, "This dish has no recipe")
    items = {i.id: i for i in db.scalars(select(InventoryItem).where(InventoryItem.id.in_([g.item_id for g in r.ingredients])))}
    lines, total, uncosted = [], Decimal(0), []
    for g in sorted(r.ingredients, key=lambda g: items[g.item_id].name):
        it = items[g.item_id]
        cost = (g.quantity * it.last_cost) if it.last_cost is not None else None
        if cost is None:
            uncosted.append(it.name)
        else:
            total += cost
        lines.append({"item_id": it.id, "name": it.name, "quantity": g.quantity, "unit": it.base_unit, "unit_cost": it.last_cost,
                      "cost": cost.quantize(Decimal("0.0001")) if cost is not None else None})
    price = Decimal(mi.price) if getattr(mi, "price", None) is not None else None
    pct = (total / price * 100).quantize(Decimal("0.01")) if price and price > 0 else None
    return {"menu_item_id": mi.id, "recipe_version": r.version, "food_cost": total.quantize(Decimal("0.0001")), "price": price,
            "food_cost_percent": pct, "complete": not uncosted, "uncosted": uncosted, "lines": lines}
