"""Back-office CRUD behind the "Manage" panel: profile, staff roles, categories, tables, suppliers,
inventory items, recipe history and the overview counts. Routes stay thin; every change is audited with
old -> new values and is tenant scoped. A no-op change (nothing differs) writes no audit row, so repeats are idempotent."""
import unicodedata
import uuid
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import exists, func, select, text
from sqlalchemy.orm import Session

from app.models.core import (
    Alert, Category, DiningTable, InventoryItem, MenuItem, Order, OrderStatus, PurchaseLine, Recipe,
    RecipeIngredient, Restaurant, Role, StockMovement, Supplier, User, ZReport,
)
from app.services import alerts, audit, inventory


def _diff(obj, changes: dict) -> dict:
    """Applies changes to obj and returns {field: {old, new}} for the fields that really changed."""
    out = {}
    for k, new in changes.items():
        old = getattr(obj, k)
        if old != new:
            out[k] = {"old": _s(old), "new": _s(new)}
            setattr(obj, k, new)
    return out


def _s(v):
    return str(v) if isinstance(v, (Decimal, uuid.UUID)) else getattr(v, "value", v)


def _given(data, *, non_null: tuple[str, ...] = ()) -> dict:
    """Fields the client actually sent. Fields in `non_null` may not be sent as null."""
    sent = {k: getattr(data, k) for k in data.model_fields_set}
    for k in non_null:
        if k in sent and sent[k] is None:
            raise HTTPException(422, f"{k} cannot be null")
    return sent


def _commit_if(db: Session, p, changed: dict, action: str, entity: str, obj) -> None:
    if changed:
        audit.record(db, p, action, entity, obj.id, changed)
    db.commit()


# ---- restaurant profile ----
def update_restaurant(db: Session, p, data) -> Restaurant:
    from app.schemas.common import check_tax_number
    r = db.get(Restaurant, p.restaurant_id, with_for_update=True)
    try:
        trn = check_tax_number(data.trn)  # the GSTIN
    except ValueError as e:
        raise HTTPException(422, str(e))
    registered = data.vat_registered if data.vat_registered is not None else r.vat_registered
    if not registered and trn != r.trn:  # GST switched off: no GSTIN can be entered or changed until it is switched on
        raise HTTPException(422, "GST is switched off for this business. Turn on GST registration to enter a GSTIN.")
    from app.services import gst  # local import: loads the tax engine only when needed
    gst.check_trn_for_gst(r, trn)  # engine on: the GSTIN must pass the engine's full validation (checksum, state)
    changes = {"name": data.name, "trn": trn, "address": data.address}
    if "phone" in data.model_fields_set:  # omitted = unchanged, null / "" = cleared
        changes["phone"] = data.phone
    if data.z_report_next_number is not None and data.z_report_next_number != r.z_report_next_number:
        from app.services import billing, outlets  # local import: billing pulls in inventory/alerts
        default_id = outlets.default_outlet(db, r.id).id  # the restaurant-level setting is the default outlet's
        billing.lock_close(db, default_id)  # a concurrent first Z close cannot slip in between check and update
        if db.scalar(select(exists().where(ZReport.restaurant_id == r.id, ZReport.outlet_id == default_id))):
            raise HTTPException(409, "The first Z-report number can only be changed before the first Z report exists")
        changes["z_report_next_number"] = data.z_report_next_number
    for k in ("vat_registered", "service_charge_percent", "max_cashier_discount_percent", "prices_include_tax",
              "bill_amend_days", "allow_negative_stock", "kitchen_target_minutes", "require_kot_before_bill", "kitchen_status_mode", "kitchen_display_minutes"):
        if getattr(data, k) is not None:  # omitted / null = unchanged
            changes[k] = getattr(data, k)
    # Changing prices_include_tax / GST registration never rewrites issued bills: they keep their own snapshot.
    changed = _diff(r, changes)
    if changed:
        from app.services import outlets  # local import: keeps the default outlet's mirrored settings equal
        outlets.sync_default(db, r)
    _commit_if(db, p, changed, "restaurant.update", "restaurant", r)
    return r


# ---- staff ----
def list_staff(db: Session, p) -> list[User]:
    return list(db.scalars(select(User).where(User.restaurant_id == p.restaurant_id)
                           .order_by(User.created_at, User.email)))


def patch_user(db: Session, p, user_id: uuid.UUID, data) -> User:
    """Owner-only (route). Locks the tenant's owners first (same order as accounts.set_active) so two owners
    cannot demote each other concurrently. The role is read from the DB on every request, so it applies at once."""
    owners = db.scalars(select(User).where(User.restaurant_id == p.restaurant_id, User.role == Role.owner)
                        .order_by(User.id).with_for_update()).all()
    target = db.scalar(select(User).where(User.id == user_id, User.restaurant_id == p.restaurant_id)
                       .with_for_update())
    if not target:
        raise HTTPException(404, "User not found")
    from app.services import staff_accounts  # local: keeps this module's imports light
    sent = _given(data, non_null=("full_name", "role"))
    staff_accounts.require_can_manage(db, p, target, "change")
    if "role" in sent and sent["role"] != target.role:
        staff_accounts.require_can_grant(p, sent["role"], "make someone")
        if target.id == p.user_id and target.role != Role.owner:
            raise HTTPException(403, "You cannot change your own role")
    if "role" in sent and target.role == Role.owner and sent["role"] != Role.owner:
        if not any(o.is_active and o.id != target.id for o in owners):
            raise HTTPException(409, "Cannot demote the last active owner")
    ids = staff_accounts.apply_identifier_changes(db, p, target, {k: sent.pop(k) for k in ("email", "phone", "username") if k in sent})
    sent.update(ids)
    changed = _diff(target, sent)
    _commit_if(db, p, changed, "user.update", "user", target)
    return target


# ---- categories ----
def patch_category(db: Session, p, category_id: uuid.UUID, data) -> Category:
    c = db.scalar(select(Category).where(Category.id == category_id, Category.restaurant_id == p.restaurant_id)
                  .with_for_update())
    if not c:
        raise HTTPException(404, "Category not found")
    sent = _given(data, non_null=("name", "sort_order", "is_active"))
    if "name" in sent and sent["name"] != c.name and db.scalar(select(Category.id).where(
            Category.restaurant_id == p.restaurant_id, Category.name == sent["name"])):
        raise HTTPException(409, "Category already exists")
    changed = _diff(c, sent)
    _commit_if(db, p, changed, "category.update", "category", c)
    return c


def reorder_categories(db: Session, p, ids: list[uuid.UUID]) -> list[Category]:
    cats = db.scalars(select(Category).where(Category.restaurant_id == p.restaurant_id)
                      .order_by(Category.id).with_for_update()).all()
    if len(set(ids)) != len(ids) or set(ids) != {c.id for c in cats}:
        raise HTTPException(422, "ids must list every category of this restaurant exactly once")
    by_id = {c.id: c for c in cats}
    moved = {}
    for pos, cid in enumerate(ids):  # one transaction: all or nothing
        if by_id[cid].sort_order != pos:
            moved[str(cid)] = {"old": by_id[cid].sort_order, "new": pos}
            by_id[cid].sort_order = pos
    if moved:
        audit.record(db, p, "category.reorder", "category", None, {"moved": moved})
    db.commit()
    return [by_id[i] for i in ids]


# ---- menu items ----
class DuplicateItemName(HTTPException):
    """409 `duplicate_item_name`: another ACTIVE dish of the same category already has this name (BREAK_UI_REPORT.md D13)."""

    def __init__(self, name: str, existing_id: uuid.UUID):
        super().__init__(409, f"A dish called \"{name.strip()}\" is already on the menu in this category. "
                              "Use a different name, or edit the existing dish.")
        self.code = "duplicate_item_name"
        self.details = {"item_id": str(existing_id)}


def item_name_key(name: str) -> str:
    """Comparison key of a dish name: Unicode-normalised (NFKC: full-width letters, ligatures, composed / decomposed accents),
    case-folded, inner whitespace collapsed, trimmed. Stored names are left exactly as typed."""
    return " ".join(unicodedata.normalize("NFKC", name).casefold().split())


def ensure_item_name_free(db: Session, restaurant_id: uuid.UUID, category_id: uuid.UUID, name: str,
                          exclude_id: uuid.UUID | None = None) -> None:
    """Refuses (409 duplicate_item_name) a second ACTIVE dish with the same name in the same category of a restaurant.
    Archived dishes do not count. A transaction-level advisory lock per (restaurant, category) makes two simultaneous creates
    of one name serialise, so both cannot pass the check; it is released at commit. Existing duplicates are never touched."""
    db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"menu-item-name:{restaurant_id}:{category_id}"})
    key = item_name_key(name)
    q = select(MenuItem.id, MenuItem.name).where(MenuItem.restaurant_id == restaurant_id, MenuItem.category_id == category_id,
                                                 MenuItem.is_active)
    if exclude_id:
        q = q.where(MenuItem.id != exclude_id)
    for iid, other in db.execute(q):
        if item_name_key(other) == key:
            raise DuplicateItemName(name, iid)


def set_item_active(db: Session, p, item_id: uuid.UUID, active: bool) -> MenuItem:
    item = db.get(MenuItem, item_id, with_for_update=True)
    if not item or item.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Item not found")
    if active and not item.is_active:  # unarchiving must not bring back a second dish of the same name
        ensure_item_name_free(db, p.restaurant_id, item.category_id, item.name, exclude_id=item.id)
    if item.is_active != active:
        item.is_active = active
        audit.record(db, p, "item.unarchive" if active else "item.archive", "menu_item", item.id,
                     {"is_active": {"old": not active, "new": active}})
    db.commit()
    return item


# ---- tables ----
def patch_table(db: Session, p, table_id: uuid.UUID, data) -> DiningTable:
    t = db.scalar(select(DiningTable).where(DiningTable.id == table_id, DiningTable.restaurant_id == p.restaurant_id)
                  .with_for_update())
    if not t:
        raise HTTPException(404, "Table not found")
    sent = _given(data, non_null=("label", "seats", "area", "is_active"))
    if "label" in sent and sent["label"] != t.label and db.scalar(select(DiningTable.id).where(
            DiningTable.restaurant_id == p.restaurant_id, DiningTable.outlet_id == t.outlet_id,
            DiningTable.label == sent["label"])):
        raise HTTPException(409, "Table label already exists")
    if sent.get("is_active") is False and t.is_active and db.scalar(select(Order.id).where(
            Order.table_id == t.id, Order.status.in_((OrderStatus.open, OrderStatus.sent_to_kitchen))).limit(1)):
        raise HTTPException(409, f"Table {t.label} has an open order; bill or cancel it first")
    changed = _diff(t, sent)
    _commit_if(db, p, changed, "table.update", "table", t)
    return t


# ---- suppliers ----
def check_supplier_tax_number(db: Session, p, value: str | None) -> str | None:
    """A supplier's tax number is its GSTIN (normalised, validated; blank = none)."""
    from app.schemas.common import check_tax_number
    try:
        return check_tax_number(value)
    except ValueError as e:
        raise HTTPException(422, str(e))


def check_supplier_phone(db: Session, p, value: str | None) -> str | None:
    """A supplier's phone is stored as E.164 (+91 for a bare Indian number: 98765 43210 -> +919876543210);
    blank = none; a number that cannot be a phone number is a 422 (the owner types it, so tell them)."""
    from app.schemas.crm import normalize_phone
    if value is None or not value.strip():
        return None
    try:
        return normalize_phone(value)
    except ValueError as e:
        raise HTTPException(422, str(e))


def patch_supplier(db: Session, p, supplier_id: uuid.UUID, data) -> Supplier:
    s = db.scalar(select(Supplier).where(Supplier.id == supplier_id, Supplier.restaurant_id == p.restaurant_id)
                  .with_for_update())
    if not s:
        raise HTTPException(404, "Supplier not found")
    sent = _given(data, non_null=("name", "is_active", "auto_reorder"))
    if "trn" in sent:
        sent["trn"] = check_supplier_tax_number(db, p, sent["trn"])
    if "phone" in sent:
        sent["phone"] = check_supplier_phone(db, p, sent["phone"])
    if "name" in sent and sent["name"] != s.name and db.scalar(select(Supplier.id).where(
            Supplier.restaurant_id == p.restaurant_id, Supplier.name == sent["name"])):
        raise HTTPException(409, "Supplier already exists")
    changed = _diff(s, sent)
    _commit_if(db, p, changed, "supplier.update", "supplier", s)
    return s


def usable_supplier(db: Session, p, supplier_id: uuid.UUID, keep: uuid.UUID | None = None) -> Supplier:
    """A supplier that may be assigned to an invoice: must be the tenant's and active (an invoice may keep
    the inactive supplier it already has: pass it as `keep`)."""
    sup = db.get(Supplier, supplier_id)
    if not sup or sup.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Supplier not found")
    if not sup.is_active and sup.id != keep:
        raise HTTPException(409, f"Supplier '{sup.name}' is inactive")
    return sup


# ---- inventory items ----
def reorder_fields(db: Session, p, base_unit: str, sent: dict, keep_supplier: uuid.UUID | None = None) -> dict:
    """The "usual supplier" / re-order quantity part of an item create or patch, as column values. `sent` holds only the
    fields the client sent (consumed here). Choosing a supplier pins it (supplier_manual: a later confirmed invoice will not
    replace it); clearing it lets the next confirmed invoice set one again. The quantity is converted to the base unit."""
    from app.services.units import to_base
    out: dict = {}
    unit = sent.pop("reorder_unit", None)
    if "supplier_id" in sent:
        sid = sent.pop("supplier_id")
        if sid is not None:
            usable_supplier(db, p, sid, keep=keep_supplier)
        out["supplier_id"], out["supplier_manual"] = sid, sid is not None
    if "reorder_quantity" in sent:
        q = sent.pop("reorder_quantity")
        if q is not None:
            q = to_base(q, unit or base_unit, base_unit)
            if q <= 0 or q > Decimal("99999999"):
                raise HTTPException(422, "Re-order quantity must be above zero")
        out["reorder_quantity"] = q
    return out


def patch_inventory_item(db: Session, p, item_id: uuid.UUID, data) -> InventoryItem:
    item = inventory.get_item(db, p, item_id, lock=True)
    sent = _given(data, non_null=("name", "base_unit", "reorder_level", "is_active", "tracks_batches"))
    if sent.get("sku") and sent["sku"] != item.sku and db.scalar(select(InventoryItem.id).where(
            InventoryItem.restaurant_id == p.restaurant_id, InventoryItem.sku == sent["sku"])):
        raise HTTPException(409, "SKU already used by another item")
    if sent.get("sku") == "":
        sent["sku"] = None
    extra = reorder_fields(db, p, sent.get("base_unit") or item.base_unit, sent, keep_supplier=item.supplier_id)
    if "name" in sent and sent["name"] != item.name and db.scalar(select(InventoryItem.id).where(
            InventoryItem.restaurant_id == p.restaurant_id, InventoryItem.name == sent["name"])):
        raise HTTPException(409, "Inventory item already exists")
    if "base_unit" in sent and sent["base_unit"] != item.base_unit and (
            db.scalar(select(StockMovement.id).where(StockMovement.item_id == item.id).limit(1))
            or db.scalar(select(RecipeIngredient.id).where(RecipeIngredient.item_id == item.id).limit(1))
            or db.scalar(select(PurchaseLine.id).where(PurchaseLine.item_id == item.id).limit(1))):
        raise HTTPException(422, "base_unit cannot change once the item has stock movements, recipes or purchases")
    if sent.get("is_active") is False and item.is_active:
        dishes = db.scalars(select(MenuItem.name).join(Recipe, Recipe.menu_item_id == MenuItem.id)
                            .join(RecipeIngredient, RecipeIngredient.recipe_id == Recipe.id)
                            .where(RecipeIngredient.item_id == item.id, Recipe.effective_to.is_(None))
                            .distinct().order_by(MenuItem.name)).all()
        if dishes:
            raise HTTPException(409, "Used by current recipes: " + ", ".join(dishes))
    sent.update(extra)
    changed = _diff(item, sent)
    if changed:
        audit.record(db, p, "inventory_item.update", "inventory_item", item.id, changed)
        alerts.evaluate(db, p.restaurant_id, [item.id])  # reorder level / archive change the low-stock state
    db.commit()
    db.refresh(item)  # numeric columns come back in their stored scale (50.000)
    return item


# ---- recipes ----
def recipe_history(db: Session, p, menu_item_id: uuid.UUID) -> list[dict]:
    mi = db.get(MenuItem, menu_item_id)
    if not mi or mi.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Menu item not found")
    recipes = db.scalars(select(Recipe).where(Recipe.menu_item_id == mi.id).order_by(Recipe.version.desc())).all()
    inv_items = {i.id: i for i in db.scalars(select(InventoryItem).where(InventoryItem.restaurant_id == p.restaurant_id))}
    return [{"id": r.id, "version": r.version, "effective_from": r.effective_from, "effective_to": r.effective_to,
             "is_current": r.effective_to is None,
             "ingredients": [{"item_id": g.item_id, "name": inv_items[g.item_id].name,
                              "unit": inv_items[g.item_id].base_unit, "quantity": g.quantity}
                             for g in sorted(r.ingredients, key=lambda g: inv_items[g.item_id].name)]}
            for r in recipes]


# ---- overview ----
def summary(db: Session, p) -> dict:
    rid = p.restaurant_id
    n = lambda q: db.scalar(q) or 0
    cnt = lambda col, *cond: n(select(func.count()).select_from(col).where(*cond))
    bal = inventory.balances(db, rid)
    active_inv = db.execute(select(InventoryItem.id, InventoryItem.reorder_level)
                            .where(InventoryItem.restaurant_id == rid, InventoryItem.is_active)).all()
    has_recipe = exists().where(Recipe.menu_item_id == MenuItem.id, Recipe.effective_to.is_(None))
    return {
        "menu_items": cnt(MenuItem, MenuItem.restaurant_id == rid, MenuItem.is_active),
        "categories": cnt(Category, Category.restaurant_id == rid, Category.is_active),
        "tables": cnt(DiningTable, DiningTable.restaurant_id == rid, DiningTable.is_active),
        "inventory_items": len(active_inv),
        "suppliers": cnt(Supplier, Supplier.restaurant_id == rid, Supplier.is_active),
        "staff_active": cnt(User, User.restaurant_id == rid, User.is_active),
        "staff_inactive": cnt(User, User.restaurant_id == rid, User.is_active.is_(False)),
        "open_alerts": cnt(Alert, Alert.restaurant_id == rid, Alert.status == "open"),
        "items_without_recipe": cnt(MenuItem, MenuItem.restaurant_id == rid, MenuItem.is_active, ~has_recipe),
        "low_stock": sum(1 for i, lvl in active_inv if bal.get(i, Decimal(0)) <= lvl),
    }


def set_tax_kinds(db: Session, p, updates) -> dict:
    ids = [u.item_id for u in updates]
    if len(set(ids)) != len(ids):
        raise HTTPException(422, "An item is listed twice")
    items = {i.id: i for i in db.scalars(select(MenuItem).where(
        MenuItem.restaurant_id == p.restaurant_id, MenuItem.id.in_(ids)).order_by(MenuItem.id).with_for_update())}
    if len(items) != len(ids):
        raise HTTPException(404, "Item not found")
    changed = {}
    for u in updates:
        it = items[u.item_id]
        if it.tax_kind != u.tax_kind:
            changed[str(it.id)] = {"name": it.name, "old": it.tax_kind, "new": u.tax_kind}
            it.tax_kind = u.tax_kind
    if changed:
        audit.record(db, p, "item.tax_kinds", "menu_item", None, {"changed": changed})
    db.commit()
    return {"updated": len(changed), "items": [{"item_id": str(u.item_id), "tax_kind": u.tax_kind} for u in updates]}
