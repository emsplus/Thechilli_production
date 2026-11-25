"""Modifier groups and combos at order time (docs/MODIFIERS_OFFERS.md).

* `resolve()` turns the option ids an order line sent into a price delta (integer paise) and a snapshot stored on the line.
  `modifiers` omitted (None) = the item's default options (what old clients, the counter fast path and voice send); a list
  is the complete choice and is validated against each attached group's min / max.
* The delta is folded into the line's unit_price, so tax follows the item's own tax kind / GST fields automatically.
* `combo_snapshot()` freezes the components of a combo item onto its order line for the kitchen ticket.
* Management (groups, options, item links, combo components) lives here too; routes are in app/api/v1/menu_extras.py.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.core import MenuItem, MenuVariant
from app.models.menu_extras import ComboComponent, MenuItemModifierGroup, ModifierGroup, ModifierOption
from app.services import audit

PAISE = Decimal(100)


def paise_to_money(p: int) -> Decimal:
    return (Decimal(p) / PAISE).quantize(Decimal("0.01"))


# ------------------------------------------------------------------------------------------------ order time
def item_groups(db: Session, item_id: uuid.UUID) -> list[ModifierGroup]:
    """Active groups attached to the item, in the item's order. One query; empty for an unconfigured item."""
    return list(db.scalars(select(ModifierGroup).join(
        MenuItemModifierGroup, MenuItemModifierGroup.group_id == ModifierGroup.id).where(
        MenuItemModifierGroup.item_id == item_id, ModifierGroup.is_active)
        .order_by(MenuItemModifierGroup.sort_order, ModifierGroup.sort_order, ModifierGroup.name)))


def resolve(db: Session, item: MenuItem, selected: list[uuid.UUID] | None) -> tuple[int, list[dict] | None]:
    """(price delta in paise, snapshot or None). Raises 404 / 409 / 422 with a message the cashier can act on."""
    groups = item_groups(db, item.id)
    if not groups:
        if selected:
            raise HTTPException(422, f"{item.name} has no options to choose")
        return 0, None
    by_group: dict[uuid.UUID, list[ModifierOption]] = {g.id: [] for g in groups}
    if selected is None:  # defaults: the 'no extra taps' path
        for g in groups:
            by_group[g.id] = [o for o in g.options if o.is_active and o.is_default][: g.max_select or None]
    else:
        if len(set(selected)) != len(selected):
            raise HTTPException(422, f"An option of {item.name} is listed twice")
        opts = {o.id: o for g in groups for o in g.options}
        for oid in selected:
            o = opts.get(oid)
            if o is None:
                other = db.get(ModifierOption, oid)
                if other is None or other.restaurant_id != item.restaurant_id:
                    raise HTTPException(404, "Modifier option not found")
                raise HTTPException(422, f"'{other.name}' is not an option of {item.name}")
            if not o.is_active:  # removed after a (possibly offline) device cached the menu
                raise HTTPException(409, f"Option '{o.name}' of {item.name} is no longer available")
            by_group[o.group_id].append(o)
    snap: list[dict] = []
    delta = 0
    for g in groups:
        chosen = by_group[g.id]
        if len(chosen) < g.min_select:
            raise HTTPException(422, f"Choose {g.name} for {item.name}" if g.min_select == 1
                                else f"Choose at least {g.min_select} of {g.name} for {item.name}")
        if g.max_select is not None and len(chosen) > g.max_select:
            raise HTTPException(422, f"Choose at most {g.max_select} of {g.name} for {item.name}")
        for o in sorted(chosen, key=lambda o: (o.sort_order, o.name)):
            delta += o.price_delta_paise
            snap.append({"group_id": str(g.id), "group": g.name, "option_id": str(o.id), "name": o.name,
                         "price_delta_paise": o.price_delta_paise})
    return delta, (snap or None)


def describe(name: str, modifiers: list[dict] | None, limit: int = 200) -> str:
    """Bill line text: 'Paneer Tikka (Full) [Medium, Extra cheese]'. Unchanged for lines without modifiers."""
    if not modifiers:
        return name
    return f"{name} [{', '.join(m['name'] for m in modifiers)}]"[:limit]


def kot_lines(modifiers: list[dict] | None) -> list[str]:
    return [f"{m['group']}: {m['name']}" for m in (modifiers or [])]


def combo_snapshot(db: Session, item: MenuItem) -> list[dict] | None:
    rows = db.execute(select(ComboComponent, MenuItem.name, MenuVariant.name).join(
        MenuItem, MenuItem.id == ComboComponent.component_item_id).outerjoin(
        MenuVariant, MenuVariant.id == ComboComponent.variant_id).where(
        ComboComponent.combo_item_id == item.id).order_by(ComboComponent.sort_order)).all()
    if not rows:
        return None
    return [{"item_id": str(c.component_item_id), "item": f"{n} ({vn})" if vn else n,
             "variant_id": str(c.variant_id) if c.variant_id else None, "qty": c.quantity} for c, n, vn in rows]


def expand_combos(db: Session, lines: list[tuple[uuid.UUID | None, int]], has_recipe) -> list[tuple[uuid.UUID | None, int]]:
    """Stock usage of combo items without a recipe of their own: their components (x quantity) instead. `has_recipe(item_id)`
    says whether a line's item has a recipe in force. Other lines are returned unchanged."""
    ids = {i for i, _ in lines if i and not has_recipe(i)}
    if not ids:
        return lines
    comps: dict[uuid.UUID, list[tuple[uuid.UUID, int]]] = {}
    for c in db.scalars(select(ComboComponent).where(ComboComponent.combo_item_id.in_(ids))):
        comps.setdefault(c.combo_item_id, []).append((c.component_item_id, c.quantity))
    out: list[tuple[uuid.UUID | None, int]] = []
    for item_id, qty in lines:
        if item_id in comps:
            out.extend((cid, q * qty) for cid, q in comps[item_id])
        else:
            out.append((item_id, qty))
    return out


# ------------------------------------------------------------------------------------------------ management
def _own_group(db: Session, p, group_id: uuid.UUID, lock: bool = True) -> ModifierGroup:
    g = db.get(ModifierGroup, group_id, with_for_update=lock)
    if not g or g.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Modifier group not found")
    return g


def _check_group(data) -> None:
    if data.max_select is not None and data.max_select < max(1, data.min_select):
        raise HTTPException(422, "max_select must be at least 1 and at least min_select")
    active = [o for o in data.options]
    if data.min_select > len(active):
        raise HTTPException(422, f"The group needs at least {data.min_select} options")
    defaults = sum(1 for o in active if o.is_default)
    if data.max_select is not None and defaults > data.max_select:
        raise HTTPException(422, "More default options than max_select allows")
    names = [o.name.strip().lower() for o in active]
    if len(set(names)) != len(names):
        raise HTTPException(422, "Option names must be unique within a group")


def create_group(db: Session, p, data) -> ModifierGroup:
    _check_group(data)
    g = ModifierGroup(restaurant_id=p.restaurant_id, name=data.name.strip(), min_select=data.min_select,
                      max_select=data.max_select, sort_order=data.sort_order)
    g.options = [ModifierOption(restaurant_id=p.restaurant_id, name=o.name.strip(), price_delta_paise=o.price_delta_paise,
                                is_default=o.is_default, sort_order=o.sort_order if o.sort_order is not None else i)
                 for i, o in enumerate(data.options)]
    db.add(g)
    db.flush()
    audit.record(db, p, "modifier_group.create", "modifier_group", g.id,
                 {"name": g.name, "min": g.min_select, "max": g.max_select,
                  "options": [[o.name, o.price_delta_paise, o.is_default] for o in g.options]})
    db.commit()
    return g


def update_group(db: Session, p, group_id: uuid.UUID, data) -> ModifierGroup:
    """Replaces the group's settings and its ACTIVE options (matched by id; options without id are created; active options
    not listed are deactivated, never deleted: order lines keep their snapshot anyway)."""
    _check_group(data)
    g = _own_group(db, p, group_id)
    detail: dict = {}
    for k in ("name", "min_select", "max_select", "sort_order"):
        v = getattr(data, k).strip() if k == "name" else getattr(data, k)
        if getattr(g, k) != v:
            detail[k] = {"old": getattr(g, k), "new": v}
            setattr(g, k, v)
    by_id = {o.id: o for o in g.options}
    seen: set[uuid.UUID] = set()
    changes: dict[str, list] = {"added": [], "updated": [], "deactivated": []}
    for i, oin in enumerate(data.options):
        order = oin.sort_order if oin.sort_order is not None else i
        new = (oin.name.strip(), oin.price_delta_paise, oin.is_default, order, True)
        if oin.id is None:
            g.options.append(ModifierOption(restaurant_id=p.restaurant_id, name=new[0], price_delta_paise=new[1],
                                            is_default=new[2], sort_order=order))
            changes["added"].append(list(new[:3]))
            continue
        o = by_id.get(oin.id)
        if o is None:
            raise HTTPException(422, f"Option {oin.id} does not belong to this group")
        if oin.id in seen:
            raise HTTPException(422, f"Option {oin.id} is listed twice")
        seen.add(oin.id)
        old = (o.name, o.price_delta_paise, o.is_default, o.sort_order, o.is_active)
        if old != new:
            changes["updated"].append({"id": str(o.id), "old": list(old), "new": list(new)})
            o.name, o.price_delta_paise, o.is_default, o.sort_order, o.is_active = new
    for o in by_id.values():
        if o.id not in seen and o.is_active:
            o.is_active = False
            changes["deactivated"].append({"id": str(o.id), "name": o.name})
    detail.update({k: v for k, v in changes.items() if v})
    if detail:
        audit.record(db, p, "modifier_group.update", "modifier_group", g.id, detail)
    db.commit()
    return g


def set_group_active(db: Session, p, group_id: uuid.UUID, active: bool) -> ModifierGroup:
    g = _own_group(db, p, group_id)
    if g.is_active != active:
        g.is_active = active
        audit.record(db, p, "modifier_group.activate" if active else "modifier_group.deactivate", "modifier_group", g.id,
                     {"name": g.name})
    db.commit()
    return g


def list_groups(db: Session, p, include_inactive: bool = False) -> list[ModifierGroup]:
    q = select(ModifierGroup).where(ModifierGroup.restaurant_id == p.restaurant_id)
    if not include_inactive:
        q = q.where(ModifierGroup.is_active)
    return list(db.scalars(q.order_by(ModifierGroup.sort_order, ModifierGroup.name)))


def links_of(db: Session, restaurant_id, item_ids=None) -> dict[uuid.UUID, list[uuid.UUID]]:
    """item id -> ids of its ACTIVE groups in order, one query."""
    q = select(MenuItemModifierGroup.item_id, MenuItemModifierGroup.group_id).join(
        ModifierGroup, ModifierGroup.id == MenuItemModifierGroup.group_id).where(
        MenuItemModifierGroup.restaurant_id == restaurant_id, ModifierGroup.is_active)
    if item_ids is not None:
        q = q.where(MenuItemModifierGroup.item_id.in_(set(item_ids)))
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    for item_id, gid in db.execute(q.order_by(MenuItemModifierGroup.item_id, MenuItemModifierGroup.sort_order)):
        out.setdefault(item_id, []).append(gid)
    return out


def group_item_ids(db: Session, restaurant_id) -> dict[uuid.UUID, list[uuid.UUID]]:
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    for item_id, gid in db.execute(select(MenuItemModifierGroup.item_id, MenuItemModifierGroup.group_id).where(
            MenuItemModifierGroup.restaurant_id == restaurant_id)):
        out.setdefault(gid, []).append(item_id)
    return out


def combo_item_ids(db: Session, restaurant_id, item_ids=None) -> set[uuid.UUID]:
    q = select(ComboComponent.combo_item_id).where(ComboComponent.restaurant_id == restaurant_id)
    if item_ids is not None:
        q = q.where(ComboComponent.combo_item_id.in_(set(item_ids)))
    return set(db.scalars(q.distinct()))


def _own_item(db: Session, p, item_id: uuid.UUID) -> MenuItem:
    item = db.get(MenuItem, item_id, with_for_update=True)
    if not item or item.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Item not found")
    return item


def set_item_groups(db: Session, p, item_id: uuid.UUID, group_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    item = _own_item(db, p, item_id)
    if len(set(group_ids)) != len(group_ids):
        raise HTTPException(422, "A group is listed twice")
    for gid in group_ids:
        g = db.get(ModifierGroup, gid)
        if not g or g.restaurant_id != p.restaurant_id:
            raise HTTPException(404, "Modifier group not found")
    old = [r.group_id for r in db.scalars(select(MenuItemModifierGroup).where(
        MenuItemModifierGroup.item_id == item.id).order_by(MenuItemModifierGroup.sort_order))]
    if old != list(group_ids):
        for r in db.scalars(select(MenuItemModifierGroup).where(MenuItemModifierGroup.item_id == item.id)):
            db.delete(r)
        db.flush()
        for i, gid in enumerate(group_ids):
            db.add(MenuItemModifierGroup(item_id=item.id, group_id=gid, restaurant_id=p.restaurant_id, sort_order=i))
        audit.record(db, p, "item.modifier_groups", "menu_item", item.id,
                     {"old": [str(x) for x in old], "new": [str(x) for x in group_ids]})
    db.commit()
    return list(group_ids)


def set_combo(db: Session, p, item_id: uuid.UUID, components) -> list[ComboComponent]:
    """Replaces the components of a combo item (empty list = not a combo any more). Components must be this tenant's items,
    not the combo itself and not combos themselves (no nesting)."""
    item = _own_item(db, p, item_id)
    new = []
    for i, c in enumerate(components):
        if c.item_id == item.id:
            raise HTTPException(422, "A combo cannot contain itself")
        ci = db.get(MenuItem, c.item_id)
        if not ci or ci.restaurant_id != p.restaurant_id:
            raise HTTPException(404, "Component item not found")
        if c.variant_id is not None:
            v = db.get(MenuVariant, c.variant_id)
            if not v or v.item_id != ci.id:
                raise HTTPException(404, "Component variant not found")
        new.append((c.item_id, c.variant_id, c.quantity, i))
    if new and combo_item_ids(db, p.restaurant_id, [x[0] for x in new]):
        raise HTTPException(422, "A combo cannot contain another combo")
    if new and db.scalar(select(ComboComponent.id).where(ComboComponent.component_item_id == item.id).limit(1)):
        raise HTTPException(422, "This item is a component of another combo and cannot become a combo")
    old_rows = list(db.scalars(select(ComboComponent).where(ComboComponent.combo_item_id == item.id)
                               .order_by(ComboComponent.sort_order)))
    old = [(r.component_item_id, r.variant_id, r.quantity, r.sort_order) for r in old_rows]
    if old != new:
        for r in old_rows:
            db.delete(r)
        db.flush()
        for cid, vid, q, i in new:
            db.add(ComboComponent(restaurant_id=p.restaurant_id, combo_item_id=item.id, component_item_id=cid,
                                  variant_id=vid, quantity=q, sort_order=i))
        audit.record(db, p, "item.combo", "menu_item", item.id,
                     {"old": [[str(a), str(b) if b else None, c] for a, b, c, _ in old],
                      "new": [[str(a), str(b) if b else None, c] for a, b, c, _ in new]})
    db.commit()
    return list(db.scalars(select(ComboComponent).where(ComboComponent.combo_item_id == item.id)
                           .order_by(ComboComponent.sort_order)))


def list_combos(db: Session, p) -> list[dict]:
    rows = db.execute(select(ComboComponent, MenuItem).join(MenuItem, MenuItem.id == ComboComponent.combo_item_id).where(
        ComboComponent.restaurant_id == p.restaurant_id).order_by(MenuItem.name, ComboComponent.sort_order)).all()
    names = dict(db.execute(select(MenuItem.id, MenuItem.name).where(
        MenuItem.id.in_({c.component_item_id for c, _ in rows}))).all()) if rows else {}
    out: dict[uuid.UUID, dict] = {}
    for c, item in rows:
        d = out.setdefault(item.id, {"item_id": item.id, "name": item.name, "price": item.price, "is_active": item.is_active,
                                     "components": []})
        d["components"].append({"item_id": c.component_item_id, "name": names.get(c.component_item_id, ""),
                                "variant_id": c.variant_id, "quantity": c.quantity})
    return list(out.values())
