"""Server-side resolution of *where stock came from*: batched lookups, tenant-scoped, no N+1."""
import uuid
from datetime import datetime
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session, aliased

from app.models.core import (
    Bill, BillLine, InventoryItem, MovementType, PurchaseInvoice, PurchaseStatus, StockMovement, Supplier, User,
)
from app.schemas.inventory import LastReceived, MovementOut, MovementSource, PurchaseOut, StockAdded

_BIG = {"g": ("kg", Decimal(1000)), "ml": ("l", Decimal(1000))}


def fmt_qty(qty: Decimal, unit: str) -> str:
    """Human display of a base-unit quantity: 25000 g -> '25 kg'."""
    if unit in _BIG and abs(qty) >= _BIG[unit][1]:
        qty, unit = qty / _BIG[unit][1], _BIG[unit][0]
    s = f"{qty.quantize(Decimal('0.001')).normalize():f}"
    return f"{s} {unit}"


def ledger(db: Session, restaurant_id: uuid.UUID, item_id: uuid.UUID | None = None,
           movement_type: MovementType | None = None, limit: int = 500, location_id=None, batch_id=None, reason_code=None,
           before: str | None = None) -> list[MovementOut]:
    q = select(StockMovement, InventoryItem.base_unit).join(InventoryItem, InventoryItem.id == StockMovement.item_id) \
        .where(StockMovement.restaurant_id == restaurant_id)
    if item_id:
        q = q.where(StockMovement.item_id == item_id)
    if movement_type:
        q = q.where(StockMovement.movement_type == movement_type)
    if location_id:
        q = q.where(StockMovement.location_id == location_id)
    if batch_id:
        q = q.where(StockMovement.batch_id == batch_id)
    if reason_code:
        q = q.where(StockMovement.reason_code == reason_code)
    if before:
        try:
            q = q.where(StockMovement.created_at < datetime.fromisoformat(before))
        except ValueError:
            raise HTTPException(422, "before must be an ISO timestamp")
    rows = db.execute(q.order_by(StockMovement.created_at.desc(), StockMovement.id.desc()).limit(limit)).all()

    def refs(kind: MovementType) -> set[uuid.UUID]:
        return {m.ref_id for m, _ in rows if m.movement_type == kind and m.ref_id}

    invoices: dict[uuid.UUID, tuple[str | None, str | None]] = {}
    if ids := refs(MovementType.purchase):
        for inv_id, number, sname in db.execute(
                select(PurchaseInvoice.id, PurchaseInvoice.invoice_number, Supplier.name)
                .outerjoin(Supplier, Supplier.id == PurchaseInvoice.supplier_id)
                .where(PurchaseInvoice.restaurant_id == restaurant_id, PurchaseInvoice.id.in_(ids))):
            invoices[inv_id] = (number, sname)
    bills: dict[uuid.UUID, tuple[str, list[str]]] = {}
    corrects: dict[uuid.UUID, str] = {}  # replacement bill id -> invoice number of the bill it corrects
    if ids := refs(MovementType.sale) | refs(MovementType.adjustment):
        Orig = aliased(Bill)
        for bid, number, orig_number in db.execute(
                select(Bill.id, Bill.invoice_number, Orig.invoice_number)
                .outerjoin(Orig, Orig.id == Bill.amends_bill_id)
                .where(Bill.restaurant_id == restaurant_id, Bill.id.in_(ids))):
            bills[bid] = (number, [])
            if orig_number:
                corrects[bid] = orig_number
    if ids := refs(MovementType.sale):
        for bid, desc in db.execute(select(BillLine.bill_id, BillLine.description)
                                    .where(BillLine.bill_id.in_(ids & set(bills))).order_by(BillLine.position)):
            bills[bid][1].append(desc)
    uids = {m.created_by for m, _ in rows if m.created_by}
    users = {i: n for i, n in db.execute(select(User.id, User.full_name)
                                         .where(User.restaurant_id == restaurant_id, User.id.in_(uids)))} if uids else {}

    out = []
    for m, unit in rows:
        by = users.get(m.created_by) if m.created_by else None
        src = MovementSource(kind=m.movement_type.value, label="", user_name=by)
        t = m.movement_type
        if t == MovementType.purchase:
            number, sname = invoices.get(m.ref_id, (None, None))
            if m.ref_id in invoices:
                src.invoice_id, src.invoice_number, src.supplier_name = m.ref_id, number, sname
            src.label = " · ".join(["Purchase invoice" + (f" {number}" if number else "")] + ([sname] if sname else []))
        elif t == MovementType.sale:
            if m.ref_id in bills:
                number, dishes = bills[m.ref_id]
                src.bill_id, src.bill_invoice_number = m.ref_id, number
                dd = ", ".join(dishes[:2]) + (f" +{len(dishes) - 2} more" if len(dishes) > 2 else "")
                src.label = (f"Sold · bill {number}" + (f" (corrects {corrects[m.ref_id]})" if m.ref_id in corrects else "")
                             + (f" · {dd}" if dd else ""))
            else:
                src.label = "Sold"
        elif t == MovementType.count:
            d = m.detail or {}
            try:
                src.label = (f"Stock count · expected {fmt_qty(Decimal(d['expected']), unit)}, "
                             f"counted {fmt_qty(Decimal(d['counted']), unit)}")
            except (KeyError, ArithmeticError, TypeError):
                src.label = "Stock count"
        elif t == MovementType.adjustment and (m.detail or {}).get("amend_reversal") and m.ref_id in bills:
            number = bills[m.ref_id][0]
            src.bill_id, src.bill_invoice_number = m.ref_id, number
            src.label = f"Sale reversed · bill {number} superseded"
        else:
            src.reason = m.note
            name = "Wastage" if t == MovementType.wastage else "Adjustment"
            src.label = " · ".join([name] + ([m.note] if m.note else []) + ([f"by {by}"] if by else []))
        out.append(MovementOut(id=m.id, item_id=m.item_id, movement_type=t, quantity=m.quantity,
                               unit_cost=m.unit_cost, note=m.note, ref_id=m.ref_id,
                               created_at=m.created_at.isoformat(), source=src, location_id=m.location_id, batch_id=m.batch_id,
                               reason_code=m.reason_code, ref_type=m.ref_type))
    return out


def last_received(db: Session, restaurant_id: uuid.UUID, item_ids: list[uuid.UUID]) -> dict[uuid.UUID, LastReceived]:
    if not item_ids:
        return {}
    rows = db.execute(
        select(StockMovement.item_id, StockMovement.created_at, StockMovement.quantity, StockMovement.unit_cost,
               PurchaseInvoice.id, PurchaseInvoice.invoice_number, Supplier.name)
        .outerjoin(PurchaseInvoice, (PurchaseInvoice.id == StockMovement.ref_id)
                   & (PurchaseInvoice.restaurant_id == restaurant_id))
        .outerjoin(Supplier, Supplier.id == PurchaseInvoice.supplier_id)
        .where(StockMovement.restaurant_id == restaurant_id, StockMovement.item_id.in_(item_ids),
               StockMovement.movement_type == MovementType.purchase)
        .ext(distinct_on(StockMovement.item_id))
        .order_by(StockMovement.item_id, StockMovement.created_at.desc(), StockMovement.id.desc())).all()
    return {r[0]: LastReceived(at=r[1], quantity=r[2], unit_cost=r[3], invoice_id=r[4], invoice_number=r[5],
                               supplier_name=r[6]) for r in rows}


def purchases_out(db: Session, restaurant_id: uuid.UUID, invoices: list[PurchaseInvoice]) -> list[PurchaseOut]:
    """PurchaseOut for each invoice; confirmed ones carry `stock_added` (one batched pair of queries)."""
    outs = [PurchaseOut.model_validate(i) for i in invoices]
    confirmed = {o.id: o for o in outs if o.status == PurchaseStatus.confirmed}
    if not confirmed:
        return outs
    mv = db.execute(
        select(StockMovement.id, StockMovement.ref_id, StockMovement.item_id, StockMovement.quantity,
               InventoryItem.name, InventoryItem.base_unit)
        .join(InventoryItem, InventoryItem.id == StockMovement.item_id)
        .where(StockMovement.restaurant_id == restaurant_id, StockMovement.movement_type == MovementType.purchase,
               StockMovement.ref_id.in_(confirmed)).order_by(InventoryItem.name)).all()
    if not mv:
        return outs
    running = select(
        StockMovement.id.label("mid"),
        func.sum(StockMovement.quantity).over(partition_by=StockMovement.item_id,
                                              order_by=(StockMovement.created_at, StockMovement.id)).label("after"),
    ).where(StockMovement.restaurant_id == restaurant_id,
            StockMovement.item_id.in_({r.item_id for r in mv})).subquery()
    after = {a: b for a, b in db.execute(
        select(running.c.mid, running.c.after).where(running.c.mid.in_([r.id for r in mv])))}
    for r in mv:
        a = Decimal(after[r.id])
        confirmed[r.ref_id].stock_added.append(StockAdded(
            item_id=r.item_id, item_name=r.name, quantity=r.quantity, unit=r.base_unit,
            balance_before=a - r.quantity, balance_after=a))
    return outs
