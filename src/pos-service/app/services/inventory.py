import uuid
from datetime import date, datetime
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from app.models.core import (
    InventoryItem, MovementType, Order, Recipe, RecipeIngredient, Restaurant, StockMovement,
)
from app.models.inventory import StockBalance, StockBatch
from app.services import alerts, audit
from app.services.units import to_base, to_base_item


def balances(db: Session, restaurant_id: uuid.UUID, item_ids: list[uuid.UUID] | None = None,
             location_id: uuid.UUID | None = None) -> dict[uuid.UUID, Decimal]:
    """Current balance per item, read from the per-item column (or the per-location table) the ledger trigger maintains: no
    scan of the ledger. `verify_balances` recomputes from the ledger for audits and tests."""
    if location_id is not None:
        q = select(StockBalance.item_id, StockBalance.balance).where(
            StockBalance.restaurant_id == restaurant_id, StockBalance.location_id == location_id)
        if item_ids is not None:
            q = q.where(StockBalance.item_id.in_(item_ids))
    else:
        q = select(InventoryItem.id, InventoryItem.balance).where(InventoryItem.restaurant_id == restaurant_id)
        if item_ids is not None:
            q = q.where(InventoryItem.id.in_(item_ids))
    return {i: Decimal(b) for i, b in db.execute(q)}


def verify_balances(db: Session, restaurant_id: uuid.UUID) -> list[dict]:
    """Items whose stored balance differs from SUM(ledger) (should always be empty)."""
    led = {i: Decimal(b) for i, b in db.execute(select(StockMovement.item_id, func.sum(StockMovement.quantity)).where(
        StockMovement.restaurant_id == restaurant_id).group_by(StockMovement.item_id))}
    bad = []
    for i, b in db.execute(select(InventoryItem.id, InventoryItem.balance).where(InventoryItem.restaurant_id == restaurant_id)):
        if Decimal(b) != led.get(i, Decimal(0)):
            bad.append({"item_id": i, "stored": Decimal(b), "ledger": led.get(i, Decimal(0))})
    return bad


def get_item(db: Session, p, item_id: uuid.UUID, lock: bool = False) -> InventoryItem:
    item = db.get(InventoryItem, item_id, with_for_update=lock)
    if not item or item.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Inventory item not found")
    return item


def lock_items(db: Session, restaurant_id: uuid.UUID, item_ids) -> dict[uuid.UUID, InventoryItem]:
    """Row-locks items in a stable order (no deadlocks between two postings) and returns them with fresh column values."""
    ids = sorted(set(item_ids), key=str)
    if not ids:
        return {}
    rows = db.scalars(select(InventoryItem).where(InventoryItem.restaurant_id == restaurant_id, InventoryItem.id.in_(ids))
                      .order_by(InventoryItem.id).with_for_update().execution_options(populate_existing=True)).all()
    return {i.id: i for i in rows}


def default_location_id(db: Session, restaurant_id: uuid.UUID, outlet_id: uuid.UUID | None = None) -> uuid.UUID:
    """Default stock location of an outlet (the tenant's default outlet when none is given); created on first use."""
    cache = db.info.setdefault("stock_default_loc", {})
    key = (restaurant_id, outlet_id)
    if key in cache:
        return cache[key]
    from app.services import stock_locations
    cache[key] = stock_locations.ensure_default(db, restaurant_id, outlet_id).id
    return cache[key]


def post(db: Session, restaurant_id, item_id, mtype: MovementType, qty: Decimal, *, ref_id=None,
         unit_cost=None, detail=None, note=None, user_id=None, location_id=None, outlet_id=None, batch_id=None,
         reason_code=None, ref_type=None) -> StockMovement:
    """Appends one ledger row. Location: explicit, else the default location of `outlet_id`, else of the default outlet."""
    if location_id is None:
        location_id = default_location_id(db, restaurant_id, outlet_id)
    m = StockMovement(restaurant_id=restaurant_id, item_id=item_id, movement_type=mtype, quantity=qty,
                      ref_id=ref_id, unit_cost=unit_cost, detail=detail, note=note, created_by=user_id,
                      location_id=location_id, batch_id=batch_id, reason_code=reason_code, ref_type=ref_type)
    db.add(m)
    if mtype == MovementType.purchase and unit_cost is not None and qty > 0:
        db.flush()
        db.execute(update(InventoryItem).where(InventoryItem.id == item_id).values(last_cost=unit_cost))
    return m


def allow_negative(db: Session, restaurant_id: uuid.UUID) -> bool:
    return bool(db.scalar(select(Restaurant.allow_negative_stock).where(Restaurant.id == restaurant_id)))


def consume(db: Session, restaurant_id, item: InventoryItem, location_id, qty: Decimal, mtype: MovementType, *, ref_id=None,
            detail=None, note=None, user_id=None, reason_code=None, ref_type=None, batch_id=None,
            include_expired: bool = False, enforce: bool | None = None) -> list[StockMovement]:
    """Takes `qty` (> 0, base unit) out of one location. Caller holds the item lock (`lock_items`).
    * batch_id given: exactly that batch (must hold enough);
    * item tracks batches: FEFO, earliest expiry first (expired batches only when `include_expired`), the part no batch can
      cover is posted without a batch;
    * otherwise one untracked movement.
    `enforce` (default: the tenant's allow_negative_stock setting) refuses with 409 when the location would go below zero."""
    if qty <= 0:
        raise HTTPException(422, "Quantity must be positive")
    if enforce is None:
        enforce = not allow_negative(db, restaurant_id)
    if enforce:
        have = db.scalar(select(StockBalance.balance).where(StockBalance.item_id == item.id, StockBalance.location_id == location_id)) or 0
        if Decimal(have) < qty:
            raise HTTPException(409, f"Insufficient stock of {item.name}: {Decimal(have).normalize():f} {item.base_unit} on hand, "
                                     f"{qty.normalize():f} needed (negative stock is switched off)")
    out, left = [], qty
    kw = dict(ref_id=ref_id, detail=detail, note=note, user_id=user_id, location_id=location_id, reason_code=reason_code, ref_type=ref_type)
    if batch_id is not None:
        b = db.scalar(select(StockBatch).where(StockBatch.id == batch_id, StockBatch.restaurant_id == restaurant_id,
                                               StockBatch.item_id == item.id, StockBatch.location_id == location_id)
                      .with_for_update().execution_options(populate_existing=True))
        if b is None:
            raise HTTPException(404, "Batch not found for this item and location")
        if Decimal(b.remaining) < qty:
            raise HTTPException(409, f"Batch {b.batch_no} holds only {Decimal(b.remaining).normalize():f} {item.base_unit}")
        return [post(db, restaurant_id, item.id, mtype, -qty, batch_id=b.id, unit_cost=b.unit_cost, **kw)]
    if item.tracks_batches:
        q = select(StockBatch).where(StockBatch.item_id == item.id, StockBatch.location_id == location_id, StockBatch.remaining > 0)
        if not include_expired:
            q = q.where((StockBatch.expiry_date.is_(None)) | (StockBatch.expiry_date >= date.today()))
        q = q.order_by(StockBatch.expiry_date.asc().nulls_last(), StockBatch.received_at, StockBatch.id).with_for_update() \
            .execution_options(populate_existing=True)
        for b in db.scalars(q):
            take = min(left, Decimal(b.remaining))
            out.append(post(db, restaurant_id, item.id, mtype, -take, batch_id=b.id, unit_cost=b.unit_cost, **kw))
            left -= take
            if left <= 0:
                break
    if left > 0:
        out.append(post(db, restaurant_id, item.id, mtype, -left, **kw))
    return out


def already_posted(db: Session, p, key: uuid.UUID, mtype: MovementType) -> bool:
    return db.scalar(select(StockMovement.id).where(
        StockMovement.restaurant_id == p.restaurant_id, StockMovement.ref_id == key,
        StockMovement.movement_type == mtype).limit(1)) is not None


def adjust(db: Session, p, key: uuid.UUID, item_id: uuid.UUID, quantity: Decimal, unit: str,
           kind: MovementType, reason: str) -> StockMovement | None:
    if kind not in (MovementType.adjustment, MovementType.wastage):
        raise HTTPException(422, "kind must be adjustment or wastage")
    item = get_item(db, p, item_id, lock=True)
    if already_posted(db, p, key, kind):
        return None
    delta = to_base(quantity, unit, item.base_unit)
    if kind == MovementType.wastage:
        delta = -abs(delta)  # wastage always reduces stock
    if delta == 0:
        raise HTTPException(422, "Quantity must not be zero")
    loc = default_location_id(db, p.restaurant_id, getattr(p, "outlet_id", None))
    if delta < 0:  # honours the negative-stock setting and FEFO
        m = consume(db, p.restaurant_id, item, loc, -delta, kind, ref_id=key, note=reason, user_id=p.user_id,
                    include_expired=True)[0]
    else:
        m = post(db, p.restaurant_id, item.id, kind, delta, ref_id=key, note=reason, user_id=p.user_id, location_id=loc)
    audit.record(db, p, f"stock.{kind.value}", "inventory_item", item.id, {"delta": str(delta), "reason": reason})
    alerts.evaluate(db, p.restaurant_id, [item.id])
    db.commit()
    return m


def stock_count(db: Session, p, key: uuid.UUID, lines: list[tuple[uuid.UUID, Decimal, str]]) -> list[dict]:
    """Reconcile counted quantities: posts one 'count' movement for the difference per item."""
    if already_posted(db, p, key, MovementType.count):
        return []
    result = []
    loc = default_location_id(db, p.restaurant_id, getattr(p, "outlet_id", None))
    for item_id, counted, unit in sorted(lines, key=lambda x: str(x[0])):  # stable lock order
        item = get_item(db, p, item_id, lock=True)
        counted_base = to_base_item(db, item, counted, unit)
        expected = balances(db, p.restaurant_id, [item.id], loc).get(item.id, Decimal(0))
        diff = counted_base - expected
        if diff != 0:
            apply_count_variance(db, p.restaurant_id, item, loc, diff, key, p.user_id,
                                 {"expected": str(expected), "counted": str(counted_base)})
        result.append({"item_id": item.id, "expected": expected, "counted": counted_base, "difference": diff})
    audit.record(db, p, "stock.count", "inventory", key, {"items": len(lines)})
    alerts.evaluate(db, p.restaurant_id, [r["item_id"] for r in result])
    db.commit()
    return result


def apply_count_variance(db, restaurant_id, item, location_id, diff: Decimal, ref_id, user_id, detail, ref_type=None) -> None:
    """Posts a stocktake variance: a surplus as one untracked movement, a shortage FEFO across batches (expired included),
    never refused (a count states what is physically there)."""
    if diff > 0:
        post(db, restaurant_id, item.id, MovementType.count, diff, ref_id=ref_id, detail=detail, user_id=user_id,
             location_id=location_id, ref_type=ref_type)
    else:
        consume(db, restaurant_id, item, location_id, -diff, MovementType.count, ref_id=ref_id, detail=detail, user_id=user_id,
                include_expired=True, enforce=False, ref_type=ref_type)


def active_recipe(db: Session, menu_item_id: uuid.UUID, at: datetime) -> Recipe | None:
    return db.scalar(select(Recipe).where(
        Recipe.menu_item_id == menu_item_id, Recipe.effective_from <= at,
        (Recipe.effective_to.is_(None)) | (Recipe.effective_to > at)).order_by(Recipe.version.desc()))


def active_recipes(db: Session, menu_item_ids, at: datetime) -> dict[uuid.UUID, Recipe]:
    """The recipe version in force at `at` for each menu item, in ONE query (ingredients eager-loaded)."""
    ids = {i for i in menu_item_ids if i}
    if not ids:
        return {}
    rows = db.scalars(select(Recipe).where(
        Recipe.menu_item_id.in_(ids), Recipe.effective_from <= at,
        (Recipe.effective_to.is_(None)) | (Recipe.effective_to > at)).order_by(Recipe.menu_item_id, Recipe.version)
        .options(selectinload(Recipe.ingredients))).all()
    return {r.menu_item_id: r for r in rows}  # ascending version: the newest wins


def consume_for_order(db: Session, order: Order, ref_id: uuid.UUID, at: datetime, user_id) -> int:
    """Post sale movements per ingredient using the recipe version in force at `at`, from the default location of the
    order's outlet (FEFO for batch-tracked items). Runs inside the billing transaction; the unique index prevents double
    deduction. One query for all recipes; items are locked in a stable order so concurrent bills cannot deadlock or both
    pass the negative-stock check."""
    totals: dict[uuid.UUID, Decimal] = {}
    used: dict[str, int] = {}
    pairs = [(l.item_id, l.quantity) for l in order.lines]
    recipes = active_recipes(db, [i for i, _ in pairs], at)
    if any(l.components for l in order.lines):  # combos without a recipe of their own use their components' recipes
        from app.services.modifiers import expand_combos
        pairs = expand_combos(db, pairs, lambda i: i in recipes)
        recipes.update(active_recipes(db, {i for i, _ in pairs} - set(recipes), at))
    for item_id, quantity in pairs:
        recipe = recipes.get(item_id)
        if not recipe:
            continue
        used[str(item_id)] = recipe.version
        for ing in recipe.ingredients:
            totals[ing.item_id] = totals.get(ing.item_id, Decimal(0)) + ing.quantity * quantity
    if not totals:
        return 0
    items = lock_items(db, order.restaurant_id, totals)
    loc = default_location_id(db, order.restaurant_id, order.outlet_id)
    detail = {"order_id": str(order.id), "recipe_versions": used}
    enforce = not allow_negative(db, order.restaurant_id)
    for item_id in sorted(totals, key=str):
        qty = totals[item_id]
        if qty <= 0:
            continue
        consume(db, order.restaurant_id, items[item_id], loc, qty, MovementType.sale, ref_id=ref_id, detail=detail,
                user_id=user_id, ref_type="bill", enforce=enforce)
    alerts.evaluate(db, order.restaurant_id, list(totals))
    return len(totals)


def recipe_usage(db: Session, lines: list[tuple[uuid.UUID | None, int]], at: datetime) -> tuple[dict[uuid.UUID, Decimal], dict[str, int]]:
    """Base-unit consumption of (menu item, quantity) lines using the recipe versions in force at `at`."""
    totals: dict[uuid.UUID, Decimal] = {}
    used: dict[str, int] = {}
    from app.services.modifiers import expand_combos  # combo items without a recipe: their components
    lines = expand_combos(db, list(lines), lambda i: active_recipe(db, i, at) is not None)
    for item_id, qty in lines:
        recipe = active_recipe(db, item_id, at) if item_id else None
        if not recipe:
            continue
        used[str(item_id)] = recipe.version
        for ing in recipe.ingredients:
            totals[ing.item_id] = totals.get(ing.item_id, Decimal(0)) + ing.quantity * qty
    return totals, used


def create_recipe(db: Session, p, menu_item_id: uuid.UUID, ingredients: list[tuple[uuid.UUID, Decimal, str]]) -> Recipe:
    from app.models.core import MenuItem
    mi = db.get(MenuItem, menu_item_id)
    if not mi or mi.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Menu item not found")
    if not ingredients:
        raise HTTPException(422, "A recipe needs at least one ingredient")
    if len({i for i, _, _ in ingredients}) != len(ingredients):
        raise HTTPException(422, "Duplicate ingredient")
    db.execute(select(MenuItem).where(MenuItem.id == mi.id).with_for_update())  # serialise versioning
    now = datetime.now().astimezone()
    current = db.scalar(select(Recipe).where(Recipe.menu_item_id == mi.id, Recipe.effective_to.is_(None)))
    version = (db.scalar(select(func.max(Recipe.version)).where(Recipe.menu_item_id == mi.id)) or 0) + 1
    if current:
        current.effective_to = now  # history is preserved; old bills keep their consumption
    ings = []
    for item_id, qty, unit in ingredients:
        item = get_item(db, p, item_id)
        base = to_base(qty, unit, item.base_unit)
        if base <= 0:
            raise HTTPException(422, "Ingredient quantity must be positive")
        ings.append(RecipeIngredient(item_id=item.id, quantity=base))
    r = Recipe(restaurant_id=p.restaurant_id, menu_item_id=mi.id, version=version, effective_from=now, ingredients=ings)
    db.add(r)
    db.flush()
    audit.record(db, p, "recipe.create", "recipe", r.id, {"menu_item": str(mi.id), "version": version})
    db.commit()
    return r
