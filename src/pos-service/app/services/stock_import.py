"""Bulk creation of stock items (spreadsheet import, "create all lines from this invoice").

All rows are validated first, then written in ONE transaction: a bad row 7 creates nothing. Names that already exist
(case-insensitive, archived items included) are reported as `existing`, never as an error unless `strict`."""
import re
import uuid
from decimal import ROUND_HALF_UP, Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.core import InventoryItem, MovementType, StockMovement
from app.schemas.inventory import BulkItemsIn
from app.services import alerts, audit, inventory as inv
from app.services.units import BASE_UNITS, UNITS, normalize_code

OPENING_REASON = "Opening stock (import)"
MAX_QTY = Decimal("99999999999")  # NUMERIC(14,3)


def clean_name(name: str) -> str:
    return re.sub(r"\s+", " ", name or "").strip()


def _errors(rows: list[tuple[int, str, str]]) -> HTTPException:
    return HTTPException(422, detail=[{"row": r, "field": f, "message": m} for r, f, m in rows])


def bulk_create(db: Session, p, data: BulkItemsIn) -> dict:
    errs: list[tuple[int, str, str]] = []
    prepared = []  # (row, name, base_unit, reorder, opening_base | None, cost_per_base | None)
    seen: dict[str, int] = {}
    for n, it in enumerate(data.items, start=1):
        name = clean_name(it.name)
        if not name:
            errs.append((n, "name", "Name is required"))
        elif (key := name.lower()) in seen:
            errs.append((n, "name", f"Duplicate of row {seen[key]}"))
        else:
            seen[key] = n
        base = it.base_unit.strip().lower() if it.base_unit else ""
        if base not in BASE_UNITS:
            errs.append((n, "base_unit", "Base unit must be g, ml or pcs"))
            continue
        if it.reorder_level < 0 or it.reorder_level > MAX_QTY:
            errs.append((n, "reorder_level", "Reorder level must be zero or more"))
        opening = cost = None
        if it.opening_quantity is not None:
            qty = it.opening_quantity
            unit = normalize_code(it.opening_unit) if it.opening_unit and it.opening_unit.strip() else base
            u, b = UNITS.get(unit), UNITS[base]
            if qty < 0 or qty > MAX_QTY:
                errs.append((n, "opening_quantity", "Opening quantity must be zero or more"))
            elif u is None:
                errs.append((n, "opening_unit", f"Unknown unit '{it.opening_unit}'"))
            elif u[0] != b[0]:
                errs.append((n, "opening_unit", f"'{it.opening_unit}' cannot be used for an item counted in {base}"))
            else:
                opening = (qty * u[1] / b[1]).quantize(Decimal("0.001"))
                if it.unit_cost is not None:
                    if it.unit_cost < 0 or it.unit_cost > MAX_QTY:
                        errs.append((n, "unit_cost", "Unit cost must be zero or more"))
                    else:
                        cost = (it.unit_cost / (u[1] / b[1])).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)  # column is 4 dp
        elif it.unit_cost is not None and it.unit_cost < 0:
            errs.append((n, "unit_cost", "Unit cost must be zero or more"))
        prepared.append((n, name, base, it.reorder_level, opening, cost))
    if errs:
        raise _errors(errs)

    wanted = {x[1].lower() for x in prepared}
    existing_rows = {i.name.lower(): i for i in db.scalars(select(InventoryItem).where(
        InventoryItem.restaurant_id == p.restaurant_id)) if i.name.lower() in wanted}
    if data.strict and existing_rows:
        names = sorted(i.name for i in existing_rows.values())
        raise HTTPException(409, f"Already in your stock list: {', '.join(names[:10])}" + (" ..." if len(names) > 10 else ""))

    # Replay: a previous run with this key already posted its opening stock.
    replay_ids = set(db.scalars(select(StockMovement.item_id).where(
        StockMovement.restaurant_id == p.restaurant_id, StockMovement.ref_id == data.idempotency_key,
        StockMovement.movement_type == MovementType.adjustment)))

    created, existing, movements = [], [], 0
    try:
        for n, name, base, reorder, opening, cost in prepared:
            have = existing_rows.get(name.lower())
            if have:
                (created if have.id in replay_ids else existing).append(have)
                continue
            item = InventoryItem(restaurant_id=p.restaurant_id, name=name, base_unit=base, reorder_level=reorder)
            db.add(item)
            db.flush()
            created.append(item)
            if opening:
                inv.post(db, p.restaurant_id, item.id, MovementType.adjustment, opening, ref_id=data.idempotency_key,
                         unit_cost=cost, note=OPENING_REASON, user_id=p.user_id)
                movements += 1
        audit.record(db, p, "inventory_item.bulk_create", "inventory", data.idempotency_key,
                     {"created": len(created), "existing": len(existing), "movements": movements})
        if movements:
            db.flush()
            alerts.evaluate(db, p.restaurant_id, [i.id for i in created])
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Some of these items were created at the same moment. Nothing was saved; try again.")
    return {"created": created, "existing": existing, "movements": movements, "replayed": bool(replay_ids)}
