import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import current_principal, P, Principal, require_perm
from app.core.config import settings
from app.core.db import get_db
from app.models.core import Category, DiningTable, MenuItem, MenuVariant, Restaurant
from app.schemas.common import (
    CategoryIn, CategoryOrderIn, CategoryOut, CategoryPatch, ItemActiveIn, ItemIn, ItemOut, ItemPatch, SoldOutIn, TableIn,
    TaxKindsIn, TableOut, TablePatch, VariantIn,
)
from app.services import audit, business_type, manage, menu_images, modifiers, order_rules, outlets

router = APIRouter(tags=["menu"])


@router.get("/menu/categories", response_model=list[CategoryOut])
def list_categories(include_inactive: bool = False, p: Principal = Depends(current_principal),
                    db: Session = Depends(get_db)):
    """Active categories. `include_inactive` is honoured for owner/manager only; others still get active rows."""
    q = select(Category).where(Category.restaurant_id == p.restaurant_id)
    if not _wants_inactive(p, include_inactive):
        q = q.where(Category.is_active)
    return db.scalars(q.order_by(Category.sort_order, Category.name)).all()


def _wants_inactive(p: Principal, flag: bool) -> bool:
    return flag and p.can(P.MENU_MANAGE)


@router.post("/menu/categories", response_model=CategoryOut, status_code=201)
def create_category(data: CategoryIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)), db: Session = Depends(get_db)):
    if db.scalar(select(Category).where(Category.restaurant_id == p.restaurant_id, Category.name == data.name)):
        raise HTTPException(409, "Category already exists")
    c = Category(restaurant_id=p.restaurant_id, **data.model_dump())
    db.add(c)
    db.flush()
    audit.record(db, p, "category.create", "category", c.id)
    db.commit()
    return c


@router.put("/menu/categories/order", response_model=list[CategoryOut])
def reorder_categories(data: CategoryOrderIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)),
                       db: Session = Depends(get_db)):
    """`ids` must list every category of the restaurant (inactive included) exactly once; sort_order becomes 0..n-1."""
    return manage.reorder_categories(db, p, data.ids)


@router.patch("/menu/categories/{category_id}", response_model=CategoryOut)
def patch_category(category_id: uuid.UUID, data: CategoryPatch, p: Principal = Depends(require_perm(P.MENU_MANAGE)),
                   db: Session = Depends(get_db)):
    return manage.patch_category(db, p, category_id, data)


@router.get("/menu/items", response_model=list[ItemOut])
def list_items(category_id: uuid.UUID | None = None, include_inactive: bool = False,
               p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Menu: active items of active categories. `include_inactive` (owner/manager only) lists everything."""
    q = select(MenuItem).where(MenuItem.restaurant_id == p.restaurant_id)
    if not _wants_inactive(p, include_inactive):
        q = q.join(Category, Category.id == MenuItem.category_id).where(MenuItem.is_active, Category.is_active)
    if category_id:
        q = q.where(MenuItem.category_id == category_id)
    # variants in one query for the whole menu, not one per item (BREAK_BACKEND_REPORT.md P1: 107 statements for 100 items)
    return _items_out(db, p, db.scalars(q.options(selectinload(MenuItem.variants)).order_by(MenuItem.name)).all())


def _items_out(db: Session, p: Principal, items) -> list[ItemOut]:
    """ItemOut plus modifier_group_ids / is_combo (docs/MODIFIERS_OFFERS.md), two queries for the whole list."""
    ids = [i.id for i in items]
    groups = modifiers.links_of(db, p.restaurant_id, ids) if ids else {}
    combos = modifiers.combo_item_ids(db, p.restaurant_id, ids) if ids else set()
    today = order_rules.local_today(db, p.restaurant_id) if ids else None
    out = []
    for i in items:
        o = ItemOut.model_validate(i)
        o.modifier_group_ids, o.is_combo = groups.get(i.id, []), i.id in combos
        dv = order_rules.default_variant(i)  # docs/ORDER_RULES.md: what the server applies when a line names no option
        o.sold_out, o.default_variant_id, o.base_orderable = order_rules.is_sold_out(i, today), dv.id if dv else None, dv is None
        out.append(o)
    return out


def _item_out(db: Session, p: Principal, item) -> ItemOut:
    return _items_out(db, p, [item])[0]


@router.post("/menu/items", response_model=ItemOut, status_code=201)
def create_item(data: ItemIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)), db: Session = Depends(get_db)):
    cat = db.get(Category, data.category_id)
    if not cat or cat.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Category not found")
    manage.ensure_item_name_free(db, p.restaurant_id, data.category_id, data.name)
    item = MenuItem(restaurant_id=p.restaurant_id, category_id=data.category_id,
                    name=data.name, price=data.price, tax_kind=data.tax_kind or "standard",
                    hsn=data.hsn, supply_type=data.supply_type or "restaurant", gst_rate_code=data.gst_rate_code,
                    food_type=data.food_type, description=data.description,
                    variants=[MenuVariant(name=v.name, price_delta=v.price_delta, is_default=v.is_default)
                              for v in _one_default(data.variants or [])])
    db.add(item)
    db.flush()
    detail = {"price": str(data.price), "tax_kind": item.tax_kind}
    detail.update({k: v for k, v in (("food_type", item.food_type), ("description", item.description)) if v is not None})
    audit.record(db, p, "item.create", "menu_item", item.id, detail)
    db.commit()
    return _item_out(db, p, item)


@router.put("/menu/items/{item_id}", response_model=ItemOut)
def update_item(item_id: uuid.UUID, data: ItemIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)),
                db: Session = Depends(get_db)):
    item = db.get(MenuItem, item_id, with_for_update=True)
    if not item or item.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Item not found")
    cat = db.get(Category, data.category_id)
    if not cat or cat.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Category not found")
    if item.is_active and (item.category_id != data.category_id or manage.item_name_key(item.name) != manage.item_name_key(data.name)):
        # only a real change of name / category is checked: saving a dish under its own name (or an old duplicate pair, edited
        # for something else) stays fine
        manage.ensure_item_name_free(db, p.restaurant_id, data.category_id, data.name, exclude_id=item.id)
    old = str(item.price)
    item.name, item.price, item.category_id = data.name, data.price, data.category_id
    detail = {"old_price": old, "new_price": str(data.price)}
    if data.tax_kind is not None and data.tax_kind != item.tax_kind:
        detail["tax_kind"] = {"old": item.tax_kind, "new": data.tax_kind}
        item.tax_kind = data.tax_kind
    for k in ("hsn", "supply_type", "gst_rate_code"):  # India GST fields: omitted = unchanged
        v = getattr(data, k)
        if v is not None and v != getattr(item, k):
            detail[k] = {"old": getattr(item, k), "new": v}
            setattr(item, k, v)
    detail.update(_apply_meta(item, data.meta_sent()))
    if data.variants is not None:
        detail["variants"] = _sync_variants(item, _one_default(data.variants))
    audit.record(db, p, "item.update", "menu_item", item.id, detail)
    db.commit()
    return _item_out(db, p, item)


def _apply_meta(item: MenuItem, sent: dict) -> dict:
    """Sets the food_type / description that were SENT (omitted = unchanged, null = cleared); {field: {old, new}} for audit."""
    changes = {}
    for k, v in sent.items():
        if getattr(item, k) != v:
            changes[k] = {"old": getattr(item, k), "new": v}
            setattr(item, k, v)
    return changes


@router.patch("/menu/items/tax-kinds")
def set_tax_kinds(data: TaxKindsIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)), db: Session = Depends(get_db)):
    """Bulk, atomic (all or nothing), audited. Body `{updates: [{item_id, tax_kind}]}`; any item that is not this
    restaurant's gives 404 and nothing changes. Returns `{updated: <changed count>, items: [{item_id, tax_kind}]}`."""
    return manage.set_tax_kinds(db, p, data.updates)


@router.patch("/menu/items/{item_id}/sold-out", response_model=ItemOut)
def set_item_sold_out(item_id: uuid.UUID, data: SoldOutIn, p: Principal = Depends(require_perm(P.MENU_SOLD_OUT)),
                      db: Session = Depends(get_db)):
    """Sold out for the rest of today (true) / available again (false). Resets itself at midnight in the restaurant's
    timezone. A sold-out dish stays on the menu list with `sold_out: true` and cannot be ordered (409 item_unavailable).
    Idempotent; audited when it changes."""
    item = _own_item(db, p, item_id)
    today = order_rules.local_today(db, p.restaurant_id)
    want = today if data.sold_out else None
    if order_rules.is_sold_out(item, today) != data.sold_out:
        item.sold_out_on = want
        audit.record(db, p, "item.sold_out" if data.sold_out else "item.back_in_stock", "menu_item", item.id,
                     {"name": item.name, "day": today.isoformat()})
    db.commit()
    return _item_out(db, p, item)


@router.patch("/menu/items/{item_id}/active", response_model=ItemOut)
def set_item_active(item_id: uuid.UUID, data: ItemActiveIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)),
                    db: Session = Depends(get_db)):
    """Archive (false) / unarchive (true). Archived items vanish from the menu and cannot be ordered."""
    return _item_out(db, p, manage.set_item_active(db, p, item_id, data.is_active))


@router.patch("/menu/items/{item_id}", response_model=ItemOut)
def patch_item(item_id: uuid.UUID, data: ItemPatch, p: Principal = Depends(require_perm(P.MENU_MANAGE)),
               db: Session = Depends(get_db)):
    """Menu metadata only (docs/MENU_META.md): `{food_type?, description?}`, omitted = unchanged, null = clear. Archived items
    can be edited too. Audited as item.update only when something changed; a no-op is idempotent (the demo seed re-runs it)."""
    item = _own_item(db, p, item_id)
    changes = _apply_meta(item, data.meta_sent())
    if changes:
        audit.record(db, p, "item.update", "menu_item", item.id, changes)
    db.commit()
    return _item_out(db, p, item)


def _own_item(db: Session, p: Principal, item_id: uuid.UUID) -> MenuItem:
    item = db.get(MenuItem, item_id, with_for_update=True)
    if not item or item.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Item not found")
    return item


@router.post("/menu/items/{item_id}/image", response_model=ItemOut)
def upload_item_image(item_id: uuid.UUID, file: UploadFile = File(...), p: Principal = Depends(require_perm(P.MENU_MANAGE)),
                      db: Session = Depends(get_db)):
    """JPEG/PNG/WebP (sniffed), max MAX_IMAGE_BYTES. Stored as an 800px WebP + a 320px thumbnail; replaces any old photo."""
    item = _own_item(db, p, item_id)
    data = file.file.read(settings.max_image_bytes + 1)
    return _item_out(db, p, menu_images.set_image(db, p, item, data))


@router.delete("/menu/items/{item_id}/image", status_code=204)
def delete_item_image(item_id: uuid.UUID, p: Principal = Depends(require_perm(P.MENU_MANAGE)), db: Session = Depends(get_db)):
    menu_images.clear_image(db, p, _own_item(db, p, item_id))
    return Response(status_code=204)


def _one_default(variants: list[VariantIn]) -> list[VariantIn]:
    if sum(1 for v in variants if v.is_default) > 1:
        raise HTTPException(422, "Only one option can be the default")
    return variants


def _sync_variants(item: MenuItem, incoming: list[VariantIn]) -> dict:
    """Makes the item's ACTIVE variants equal `incoming`. Matched by id (an inactive one is reactivated); entries
    without id are created; active variants not listed are deactivated, never deleted, because order_lines
    reference them. Returns a summary for the audit log."""
    by_id = {v.id: v for v in item.variants}
    seen: set[uuid.UUID] = set()
    changes: dict[str, list] = {"added": [], "updated": [], "deactivated": []}
    for vin in incoming:
        if vin.id is None:
            item.variants.append(MenuVariant(name=vin.name, price_delta=vin.price_delta, is_default=vin.is_default))
            changes["added"].append({"name": vin.name, "price_delta": str(vin.price_delta)})
            continue
        v = by_id.get(vin.id)
        if v is None:
            raise HTTPException(422, f"Variant {vin.id} does not belong to this item")
        if vin.id in seen:
            raise HTTPException(422, f"Variant {vin.id} is listed twice")
        seen.add(vin.id)
        if (v.name, v.price_delta, v.is_active, v.is_default) != (vin.name, vin.price_delta, True, vin.is_default):
            changes["updated"].append({"id": str(v.id), "old": [v.name, str(v.price_delta), v.is_active, v.is_default],
                                       "new": [vin.name, str(vin.price_delta), True, vin.is_default]})
            v.name, v.price_delta, v.is_active, v.is_default = vin.name, vin.price_delta, True, vin.is_default
    for v in by_id.values():
        if v.id not in seen and v.is_active:
            v.is_active = False
            changes["deactivated"].append({"id": str(v.id), "name": v.name})
    return {k: x for k, x in changes.items() if x}


@router.get("/tables", response_model=list[TableOut])
def list_tables(include_inactive: bool = False, outlet_id: uuid.UUID | None = None,
                p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Tables of the outlet. A business without the tables capability (cloud / hotel kitchen only) gets [] (its tables, if
    any, are hidden, not deleted: they come back when Restaurant is selected again)."""
    if not business_type.capabilities(business_type.stored(db.get(Restaurant, p.restaurant_id)))["tables"]:
        return []
    q = select(DiningTable).where(DiningTable.restaurant_id == p.restaurant_id,
                                  DiningTable.outlet_id.in_(outlets.scope(p, outlet_id, all_by_default=False)))
    if not _wants_inactive(p, include_inactive):
        q = q.where(DiningTable.is_active)
    return db.scalars(q.order_by(DiningTable.label)).all()


@router.post("/tables", response_model=TableOut, status_code=201)
def create_table(data: TableIn, p: Principal = Depends(require_perm(P.TABLES_MANAGE)), db: Session = Depends(get_db)):
    business_type.require(db, p.restaurant_id, "tables")  # 409 not_available_for_business_type
    oid = outlets.outlet_of(db, p)
    if db.scalar(select(DiningTable).where(DiningTable.restaurant_id == p.restaurant_id, DiningTable.outlet_id == oid,
                                           DiningTable.label == data.label)):
        raise HTTPException(409, "Table label already exists")
    t = DiningTable(restaurant_id=p.restaurant_id, outlet_id=oid, **data.model_dump())
    db.add(t)
    db.flush()
    audit.record(db, p, "table.create", "table", t.id, {"label": data.label})
    db.commit()
    return t


@router.patch("/tables/{table_id}", response_model=TableOut)
def patch_table(table_id: uuid.UUID, data: TablePatch, p: Principal = Depends(require_perm(P.TABLES_MANAGE)),
                db: Session = Depends(get_db)):
    business_type.require(db, p.restaurant_id, "tables")
    return manage.patch_table(db, p, table_id, data)
