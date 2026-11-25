"""Purchase orders, goods receipts (GRN), purchase returns and the supplier ledger (docs/INVENTORY.md).

PO life cycle: draft -> sent -> partially_received -> closed, and cancelled (draft/sent only). A GRN is posted against a PO:
it adds stock (a `purchase` movement per line at the received location, batch + expiry when the item tracks batches), raises
the supplier's balance and moves the PO. Nothing is edited afterwards: mistakes are purchase returns (a `purchase_return`
movement, a debit note and a negative supplier ledger entry). Every document is outlet scoped (the request's outlet)."""
import uuid
from datetime import date, datetime, timezone
from decimal import ROUND_HALF_UP, Decimal

from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models.core import InventoryItem, MovementType, PurchaseInvoice, PurchaseStatus, Supplier
from app.models.inventory import (
    GoodsReceipt, GoodsReceiptLine, PurchaseOrder, PurchaseOrderLine, PurchaseReturn, PurchaseReturnLine, StockBatch,
    SupplierLedgerEntry,
)
from app.services import alerts, audit, inventory as inv, outlets, stock_locations
from app.services.units import item_factor

C2 = Decimal("0.01")
C4 = Decimal("0.0001")


def money(x: Decimal) -> Decimal:
    return Decimal(x).quantize(C2, ROUND_HALF_UP)


def next_number(db: Session, restaurant_id: uuid.UUID, prefix: str, model) -> str:
    """PO-000001 style, per tenant. A transaction-level advisory lock serialises concurrent creates of one kind."""
    db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"{prefix}:{restaurant_id}"})
    n = db.scalar(select(func.count()).select_from(model).where(model.restaurant_id == restaurant_id)) or 0
    return f"{prefix}-{n + 1:06d}"


def _supplier(db: Session, p, supplier_id: uuid.UUID) -> Supplier:
    s = db.get(Supplier, supplier_id)
    if s is None or s.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Supplier not found")
    return s


def _ledger(db: Session, p, supplier_id, etype: str, amount: Decimal, ref_type, ref_id, note=None, on: date | None = None) -> None:
    db.add(SupplierLedgerEntry(restaurant_id=p.restaurant_id, supplier_id=supplier_id, entry_type=etype, amount=amount,
                               entry_date=on or date.today(), ref_type=ref_type, ref_id=ref_id, note=note, created_by=p.user_id))


# ---------------------------------------------------------------- purchase orders
def _po(db: Session, p, po_id: uuid.UUID, lock: bool = False) -> PurchaseOrder:
    q = select(PurchaseOrder).where(PurchaseOrder.id == po_id, PurchaseOrder.restaurant_id == p.restaurant_id)
    if lock:
        q = q.with_for_update().execution_options(populate_existing=True)
    po = db.scalar(q)
    if po is None or (p.outlet_id is not None and po.outlet_id != p.outlet_id):  # another outlet's PO does not exist for us
        raise HTTPException(404, "Purchase order not found")
    return po


def get_po(db: Session, p, po_id: uuid.UUID) -> PurchaseOrder:
    return _po(db, p, po_id)


def _build_lines(db: Session, p, lines) -> tuple[list[PurchaseOrderLine], Decimal, Decimal]:
    if not lines:
        raise HTTPException(422, "A purchase order needs at least one line")
    items = {i.id: i for i in db.scalars(select(InventoryItem).where(
        InventoryItem.restaurant_id == p.restaurant_id, InventoryItem.id.in_({l.item_id for l in lines})))}
    out, sub, tax = [], Decimal(0), Decimal(0)
    for pos, l in enumerate(lines, 1):
        item = items.get(l.item_id)
        if item is None:
            raise HTTPException(404, "Inventory item not found")
        unit = l.unit or item.base_unit
        factor = item_factor(db, item, unit)
        out.append(PurchaseOrderLine(restaurant_id=p.restaurant_id, position=pos, item_id=item.id, unit_code=unit.strip().lower(),
                                     factor_to_base=factor, quantity=l.quantity, unit_price=l.unit_price, tax_rate=l.tax_rate))
        net = money(l.quantity * l.unit_price)
        sub += net
        tax += money(net * l.tax_rate / 100)
    return out, sub, tax


def create_po(db: Session, p, data) -> PurchaseOrder:
    _supplier(db, p, data.supplier_id)
    lines, sub, tax = _build_lines(db, p, data.lines)
    po = PurchaseOrder(restaurant_id=p.restaurant_id, outlet_id=outlets.outlet_of(db, p), supplier_id=data.supplier_id,
                       number=next_number(db, p.restaurant_id, "PO", PurchaseOrder), expected_date=data.expected_date,
                       notes=data.notes, subtotal=sub, tax_total=tax, total=sub + tax, created_by=p.user_id, lines=lines)
    db.add(po)
    db.flush()
    audit.record(db, p, "purchase_order.create", "purchase_order", po.id, {"number": po.number})
    db.commit()
    return po


def update_po(db: Session, p, po_id: uuid.UUID, data) -> PurchaseOrder:
    po = _po(db, p, po_id, lock=True)
    if po.status != "draft":
        raise HTTPException(409, "Only a draft purchase order can be edited")
    if data.supplier_id is not None:
        _supplier(db, p, data.supplier_id)
        po.supplier_id = data.supplier_id
    if "expected_date" in data.model_fields_set:
        po.expected_date = data.expected_date
    if "notes" in data.model_fields_set:
        po.notes = data.notes
    if data.lines is not None:
        lines, sub, tax = _build_lines(db, p, data.lines)
        po.lines.clear()
        db.flush()
        po.lines.extend(lines)
        po.subtotal, po.tax_total, po.total = sub, tax, sub + tax
    audit.record(db, p, "purchase_order.update", "purchase_order", po.id)
    db.commit()
    return po


def list_pos(db: Session, p, status: str | None, supplier_id: uuid.UUID | None, limit: int, offset: int) -> list[PurchaseOrder]:
    q = select(PurchaseOrder).where(PurchaseOrder.restaurant_id == p.restaurant_id, PurchaseOrder.outlet_id == outlets.outlet_of(db, p))
    if status:
        q = q.where(PurchaseOrder.status == status)
    if supplier_id:
        q = q.where(PurchaseOrder.supplier_id == supplier_id)
    return list(db.scalars(q.options(selectinload(PurchaseOrder.lines)).order_by(PurchaseOrder.created_at.desc(), PurchaseOrder.id)
                           .limit(limit).offset(offset)))


def send_po(db: Session, p, po_id: uuid.UUID) -> PurchaseOrder:
    po = _po(db, p, po_id, lock=True)
    if po.status == "sent":
        return po  # idempotent
    if po.status != "draft":
        raise HTTPException(409, f"A {po.status} purchase order cannot be sent")
    po.status, po.sent_at = "sent", datetime.now(timezone.utc)
    audit.record(db, p, "purchase_order.send", "purchase_order", po.id)
    db.commit()
    return po


def cancel_po(db: Session, p, po_id: uuid.UUID) -> PurchaseOrder:
    po = _po(db, p, po_id, lock=True)
    if po.status == "cancelled":
        return po
    if po.status not in ("draft", "sent"):
        raise HTTPException(409, f"A {po.status} purchase order cannot be cancelled (close it instead)")
    po.status, po.cancelled_at = "cancelled", datetime.now(timezone.utc)
    audit.record(db, p, "purchase_order.cancel", "purchase_order", po.id)
    db.commit()
    return po


def close_po(db: Session, p, po_id: uuid.UUID) -> PurchaseOrder:
    """Short-close: the supplier will not deliver the rest of a partially received order."""
    po = _po(db, p, po_id, lock=True)
    if po.status == "closed":
        return po
    if po.status != "partially_received":
        raise HTTPException(409, "Only a partially received purchase order can be closed")
    po.status, po.closed_at = "closed", datetime.now(timezone.utc)
    audit.record(db, p, "purchase_order.close", "purchase_order", po.id)
    db.commit()
    return po


# ---------------------------------------------------------------- goods receipts
def _grn_by_key(db: Session, p, key: uuid.UUID) -> GoodsReceipt | None:
    return db.scalar(select(GoodsReceipt).where(GoodsReceipt.restaurant_id == p.restaurant_id, GoodsReceipt.idempotency_key == key))


def receive(db: Session, p, po_id: uuid.UUID, data) -> tuple[GoodsReceipt, bool]:
    """Posts a delivery against a PO. (grn, replayed). Quantities are accepted units in each line's PO unit; over-receipt
    beyond the ordered quantity is refused. A batch-tracked item needs an expiry date."""
    po = _po(db, p, po_id, lock=True)
    existing = _grn_by_key(db, p, data.idempotency_key)
    if existing is not None:
        if existing.po_id != po.id:
            raise HTTPException(409, "idempotency_key was used for another purchase order")
        return existing, True
    if po.status not in ("sent", "partially_received"):
        raise HTTPException(409, f"A {po.status} purchase order cannot receive goods" + (" (send it first)" if po.status == "draft" else ""))
    bill_no, linked = data.supplier_invoice_no, None
    if bill_no or data.purchase_invoice_id:
        # The supplier's bill may already have been scanned and confirmed (purchases.confirm posted its stock): receiving it
        # again would add the same goods twice. Serialised with confirm / link by the supplier-bill lock.
        from app.services import purchases
        purchases.lock_supplier_bills(db, p.restaurant_id, po.supplier_id)
        if data.purchase_invoice_id:
            linked = _invoice_for_link(db, p, data.purchase_invoice_id, po.supplier_id)
            _same_bill_no(bill_no, linked)
            bill_no = bill_no or linked.invoice_number
        _refuse_if_bill_booked(db, p, po.supplier_id, bill_no, linked)
    loc = stock_locations.resolve(db, p, data.location_id)
    po_lines = {l.id: l for l in po.lines}
    seen = set()
    for l in data.lines:
        if l.po_line_id not in po_lines:
            raise HTTPException(404, "Purchase order line not found")
        if l.po_line_id in seen:
            raise HTTPException(422, "A line can appear once per receipt")
        seen.add(l.po_line_id)
    items = inv.lock_items(db, p.restaurant_id, [po_lines[l.po_line_id].item_id for l in data.lines])
    today = date.today()
    grn = GoodsReceipt(restaurant_id=p.restaurant_id, outlet_id=po.outlet_id, po_id=po.id, supplier_id=po.supplier_id,
                       location_id=loc.id, number=next_number(db, p.restaurant_id, "GRN", GoodsReceipt),
                       idempotency_key=data.idempotency_key, received_on=data.received_on or today,
                       supplier_invoice_no=bill_no, purchase_invoice_id=linked.id if linked else None, note=data.note,
                       created_by=p.user_id)
    if linked is not None and linked.supplier_id is None:
        linked.supplier_id = po.supplier_id  # a draft scanned before its supplier was chosen: the GRN says whose bill it is
    db.add(grn)
    db.flush()
    sub = tax = Decimal(0)
    for pos, l in enumerate(data.lines, 1):
        pl = po_lines[l.po_line_id]
        item = items[pl.item_id]
        left = Decimal(pl.quantity) - Decimal(pl.received_quantity)
        if l.quantity > left:
            raise HTTPException(409, f"{item.name}: {l.quantity.normalize():f} {pl.unit_code} received but only {left.normalize():f} still expected")
        price = l.unit_price if l.unit_price is not None else Decimal(pl.unit_price)
        rate = l.tax_rate if l.tax_rate is not None else Decimal(pl.tax_rate)
        qty_base = (l.quantity * Decimal(pl.factor_to_base)).quantize(Decimal("0.001"))
        if qty_base <= 0:
            raise HTTPException(422, "Quantity too small")
        net = money(l.quantity * price)
        vat = money(net * rate / 100)
        cost = (net / qty_base).quantize(C4, ROUND_HALF_UP)  # per base unit, tax excluded
        batch = None
        if item.tracks_batches:
            if l.expiry_date is None:
                raise HTTPException(422, f"{item.name} tracks batches: an expiry date is required")
            batch = _batch_for(db, p, item, loc.id, l.batch_no or f"{grn.number}-{pos}", l.expiry_date, cost, po.supplier_id)
            batch.qty_received = Decimal(batch.qty_received) + qty_base
        gl = GoodsReceiptLine(restaurant_id=p.restaurant_id, grn_id=grn.id, position=pos, po_line_id=pl.id, item_id=item.id,
                              unit_code=pl.unit_code, quantity=l.quantity, rejected_quantity=l.rejected_quantity or 0,
                              quantity_base=qty_base, unit_price=price, unit_cost=cost, tax_rate=rate, net=net, tax_amount=vat,
                              batch_id=batch.id if batch else None, batch_no=batch.batch_no if batch else l.batch_no,
                              expiry_date=l.expiry_date)
        db.add(gl)
        db.flush()
        inv.post(db, p.restaurant_id, item.id, MovementType.purchase, qty_base, ref_id=gl.id, ref_type="grn_line", unit_cost=cost,
                 location_id=loc.id, batch_id=batch.id if batch else None, user_id=p.user_id,
                 detail={"grn": grn.number, "po": po.number}, note=f"GRN {grn.number}")
        pl.received_quantity = Decimal(pl.received_quantity) + l.quantity
        sub += net
        tax += vat
    grn.subtotal, grn.tax_total, grn.total = sub, tax, sub + tax
    po.status = "closed" if all(Decimal(x.received_quantity) >= Decimal(x.quantity) for x in po.lines) else "partially_received"
    if po.status == "closed":
        po.closed_at = datetime.now(timezone.utc)
    _ledger(db, p, po.supplier_id, "grn", grn.total, "grn", grn.id, f"GRN {grn.number} / {po.number}", grn.received_on)
    detail = {"number": grn.number, "po": po.number, "total": str(grn.total)}
    if linked is not None:
        detail["purchase_invoice_id"] = str(linked.id)
    audit.record(db, p, "goods_receipt.post", "goods_receipt", grn.id, detail)
    alerts.evaluate(db, p.restaurant_id, list(items))
    try:
        db.commit()
    except IntegrityError:  # the same key racing in another request: that one won
        db.rollback()
        again = _grn_by_key(db, p, data.idempotency_key)
        if again is None:
            raise
        return again, True
    return grn, False


def _batch_for(db: Session, p, item, location_id, batch_no: str, expiry: date, cost: Decimal, supplier_id) -> StockBatch:
    b = db.scalar(select(StockBatch).where(StockBatch.item_id == item.id, StockBatch.location_id == location_id,
                                           StockBatch.batch_no == batch_no).with_for_update())
    if b is not None:
        if b.expiry_date != expiry:
            raise HTTPException(409, f"Batch {batch_no} of {item.name} already exists with a different expiry date")
        return b
    b = StockBatch(restaurant_id=p.restaurant_id, item_id=item.id, location_id=location_id, batch_no=batch_no, expiry_date=expiry,
                   unit_cost=cost, supplier_id=supplier_id, qty_received=0, remaining=0)
    db.add(b)
    db.flush()
    return b


def get_grn(db: Session, p, grn_id: uuid.UUID) -> GoodsReceipt:
    g = db.get(GoodsReceipt, grn_id)
    if g is None or g.restaurant_id != p.restaurant_id or (p.outlet_id is not None and g.outlet_id != p.outlet_id):
        raise HTTPException(404, "Goods receipt not found")
    return g


def list_grns(db: Session, p, po_id, supplier_id, limit: int, offset: int, purchase_invoice_id=None) -> list[GoodsReceipt]:
    q = select(GoodsReceipt).where(GoodsReceipt.restaurant_id == p.restaurant_id, GoodsReceipt.outlet_id == outlets.outlet_of(db, p))
    if po_id:
        q = q.where(GoodsReceipt.po_id == po_id)
    if purchase_invoice_id:
        q = q.where(GoodsReceipt.purchase_invoice_id == purchase_invoice_id)
    if supplier_id:
        q = q.where(GoodsReceipt.supplier_id == supplier_id)
    return list(db.scalars(q.options(selectinload(GoodsReceipt.lines)).order_by(GoodsReceipt.created_at.desc(), GoodsReceipt.id)
                           .limit(limit).offset(offset)))


# ---------------------------------------------------------------- GRN <-> supplier bill (purchase invoice) link
def _invoice_for_link(db: Session, p, invoice_id: uuid.UUID, supplier_id: uuid.UUID) -> PurchaseInvoice:
    """The scanned supplier bill a GRN may be linked to: same tenant, a stock purchase, same supplier (or none chosen yet)."""
    b = db.get(PurchaseInvoice, invoice_id, with_for_update=True)
    if b is None or b.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Purchase invoice not found")
    if b.document_type != "stock_purchase":
        raise HTTPException(422, "Only a stock purchase bill can be linked to a goods receipt")
    if b.supplier_id is not None and b.supplier_id != supplier_id:
        raise HTTPException(409, "That purchase bill is from another supplier")
    return b


def _same_bill_no(bill_no: str | None, b: PurchaseInvoice) -> None:
    from app.services import purchases
    if bill_no and b.invoice_number and purchases.bill_no_key(bill_no) != purchases.bill_no_key(b.invoice_number):
        raise HTTPException(422, f"Supplier bill number {bill_no} does not match the linked purchase ({b.invoice_number})")


def _refuse_if_bill_booked(db: Session, p, supplier_id: uuid.UUID, bill_no: str | None, linked: PurchaseInvoice | None) -> None:
    """409 when the supplier's bill (the linked purchase, or a confirmed purchase with the same bill number) already added
    its stock from a scan: the GRN stock would be the second posting of the same goods. Caller holds the supplier-bill lock."""
    from app.services import purchases
    msg = ("Supplier bill {no} was already confirmed from a scan (purchase {id}) and its stock added; receiving it on a GRN "
           "would add it twice")
    if linked is not None and linked.status == PurchaseStatus.confirmed and purchases.stock_posted_for(db, p.restaurant_id, linked.id):
        raise HTTPException(409, msg.format(no=linked.invoice_number or "(no number)", id=linked.id))
    key = purchases.bill_no_key(bill_no)
    if key is None:
        return
    booked = [b for b in db.scalars(select(PurchaseInvoice).where(
        PurchaseInvoice.restaurant_id == p.restaurant_id, PurchaseInvoice.supplier_id == supplier_id,
        PurchaseInvoice.status == PurchaseStatus.confirmed, PurchaseInvoice.invoice_number.is_not(None)))
        if purchases.bill_no_key(b.invoice_number) == key and purchases.stock_posted_for(db, p.restaurant_id, b.id)]
    if booked:
        raise HTTPException(409, msg.format(no=bill_no, id=booked[0].id))


def link_purchase(db: Session, p, grn_id: uuid.UUID, data) -> GoodsReceipt:
    """Records the supplier's bill number on a GRN saved without it and/or links the scanned purchase bill, so confirming
    that bill later does not add the goods again (purchases.confirm skips the stock posting for a bill received on a GRN).
    Idempotent. 409 when the bill's stock was already added from the scan (the goods are then counted twice: post a
    purchase return or a stock adjustment for one of them) or when the GRN already records a different bill."""
    from app.services import purchases
    g = get_grn(db, p, grn_id)
    purchases.lock_supplier_bills(db, p.restaurant_id, g.supplier_id)
    g = db.get(GoodsReceipt, g.id, with_for_update=True, populate_existing=True)
    bill_no, linked = data.supplier_invoice_number, None
    if bill_no and g.supplier_invoice_no and purchases.bill_no_key(bill_no) != purchases.bill_no_key(g.supplier_invoice_no):
        raise HTTPException(409, f"GRN {g.number} already records supplier bill {g.supplier_invoice_no}")
    if data.purchase_invoice_id:
        if g.purchase_invoice_id is not None and g.purchase_invoice_id != data.purchase_invoice_id:
            raise HTTPException(409, f"GRN {g.number} is already linked to another purchase bill ({g.purchase_invoice_id})")
        linked = _invoice_for_link(db, p, data.purchase_invoice_id, g.supplier_id)
        _same_bill_no(bill_no or g.supplier_invoice_no, linked)
        bill_no = bill_no or g.supplier_invoice_no or linked.invoice_number
    changes = {}
    if bill_no and not g.supplier_invoice_no:
        changes["supplier_invoice_no"] = bill_no
    if linked is not None and g.purchase_invoice_id != linked.id:
        changes["purchase_invoice_id"] = linked.id
    if not changes:
        return g  # idempotent: nothing new
    _refuse_if_bill_booked(db, p, g.supplier_id, changes.get("supplier_invoice_no"), linked)
    for k, v in changes.items():
        setattr(g, k, v)
    if linked is not None and linked.supplier_id is None:
        linked.supplier_id = g.supplier_id
    audit.record(db, p, "goods_receipt.link_purchase", "goods_receipt", g.id,
                 {k: str(v) for k, v in changes.items()} | {"number": g.number})
    db.commit()
    return g


def grn_candidates(db: Session, p, invoice_id: uuid.UUID, days: int = 30) -> list[GoodsReceipt]:
    """GRNs that may be the delivery of this scanned bill: same supplier, not linked to any bill, no bill number or the same
    one, received within `days` of the bill date. The UI offers them before confirm ("Already received on GRN ...?")."""
    from datetime import timedelta
    from app.services import purchases
    b = purchases.load(db, p, invoice_id)
    if b.supplier_id is None:
        return []
    key = purchases.bill_no_key(b.invoice_number)
    around = b.invoice_date or (b.created_at.date() if b.created_at else date.today())
    rows = db.scalars(select(GoodsReceipt).where(
        GoodsReceipt.restaurant_id == p.restaurant_id, GoodsReceipt.outlet_id == outlets.outlet_of(db, p),
        GoodsReceipt.supplier_id == b.supplier_id, GoodsReceipt.purchase_invoice_id.is_(None),
        GoodsReceipt.received_on >= around - timedelta(days=days), GoodsReceipt.received_on <= around + timedelta(days=days))
        .options(selectinload(GoodsReceipt.lines)).order_by(GoodsReceipt.received_on.desc(), GoodsReceipt.number.desc()).limit(50)).all()
    return [g for g in rows if g.supplier_invoice_no is None or purchases.bill_no_key(g.supplier_invoice_no) == key][:20]


# ---------------------------------------------------------------- purchase returns
def create_return(db: Session, p, data) -> tuple[PurchaseReturn, bool]:
    """Sends accepted goods of a GRN back. Cannot return more than was received minus what was already returned, nor more than
    the batch still holds. Posts `purchase_return` at the GRN's location / batch / cost, a debit note and a negative supplier
    ledger entry."""
    grn = get_grn(db, p, data.grn_id)
    existing = db.scalar(select(PurchaseReturn).where(PurchaseReturn.restaurant_id == p.restaurant_id,
                                                      PurchaseReturn.idempotency_key == data.idempotency_key))
    if existing is not None:
        return existing, True
    if not data.lines:
        raise HTTPException(422, "A return needs at least one line")
    gl_by = {l.id: l for l in db.scalars(select(GoodsReceiptLine).where(
        GoodsReceiptLine.grn_id == grn.id).order_by(GoodsReceiptLine.id).with_for_update().execution_options(populate_existing=True))}
    items = inv.lock_items(db, p.restaurant_id, [gl_by[l.grn_line_id].item_id for l in data.lines if l.grn_line_id in gl_by])
    ret = PurchaseReturn(restaurant_id=p.restaurant_id, outlet_id=grn.outlet_id, grn_id=grn.id, supplier_id=grn.supplier_id,
                         location_id=grn.location_id, number=next_number(db, p.restaurant_id, "DN", PurchaseReturn),
                         idempotency_key=data.idempotency_key, reason=data.reason, created_by=p.user_id)
    db.add(ret)
    db.flush()
    sub = tax = Decimal(0)
    seen = set()
    for pos, l in enumerate(data.lines, 1):
        gl = gl_by.get(l.grn_line_id)
        if gl is None:
            raise HTTPException(404, "Goods receipt line not found")
        if l.grn_line_id in seen:
            raise HTTPException(422, "A line can appear once per return")
        seen.add(l.grn_line_id)
        item = items[gl.item_id]
        qty = (l.quantity * item_factor(db, item, l.unit or item.base_unit)).quantize(Decimal("0.001"))
        avail = Decimal(gl.quantity_base) - Decimal(gl.returned_base)
        if qty <= 0:
            raise HTTPException(422, "Quantity must be positive")
        if qty > avail:
            raise HTTPException(409, f"{item.name}: only {avail.normalize():f} {item.base_unit} of this delivery can still be returned")
        # batch remaining / location balance are enforced by consume (batch: always; location: the negative-stock setting)
        inv.consume(db, p.restaurant_id, item, grn.location_id, qty, MovementType.purchase_return, ref_id=ret.id,
                    note=f"Return {ret.number}: {data.reason}"[:300], user_id=p.user_id, ref_type="return",
                    batch_id=gl.batch_id, enforce=None)
        net = money(qty * Decimal(gl.unit_cost))
        vat = money(net * Decimal(gl.tax_rate) / 100)
        db.add(PurchaseReturnLine(restaurant_id=p.restaurant_id, return_id=ret.id, position=pos, grn_line_id=gl.id, item_id=item.id,
                                  quantity_base=qty, unit_cost=gl.unit_cost, net=net, tax_amount=vat, batch_id=gl.batch_id))
        gl.returned_base = Decimal(gl.returned_base) + qty
        sub += net
        tax += vat
    ret.subtotal, ret.tax_total, ret.total = sub, tax, sub + tax
    _ledger(db, p, grn.supplier_id, "return", -ret.total, "return", ret.id, f"Debit note {ret.number}")
    audit.record(db, p, "purchase_return.create", "purchase_return", ret.id, {"number": ret.number, "total": str(ret.total)})
    alerts.evaluate(db, p.restaurant_id, list(items))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        again = db.scalar(select(PurchaseReturn).where(PurchaseReturn.restaurant_id == p.restaurant_id,
                                                       PurchaseReturn.idempotency_key == data.idempotency_key))
        if again is None:
            raise
        return again, True
    return ret, False


def get_return(db: Session, p, return_id: uuid.UUID) -> PurchaseReturn:
    r = db.get(PurchaseReturn, return_id)
    if r is None or r.restaurant_id != p.restaurant_id or (p.outlet_id is not None and r.outlet_id != p.outlet_id):
        raise HTTPException(404, "Purchase return not found")
    return r


def list_returns(db: Session, p, limit: int, offset: int) -> list[PurchaseReturn]:
    return list(db.scalars(select(PurchaseReturn).where(PurchaseReturn.restaurant_id == p.restaurant_id,
                                                        PurchaseReturn.outlet_id == outlets.outlet_of(db, p))
                           .options(selectinload(PurchaseReturn.lines)).order_by(PurchaseReturn.created_at.desc(), PurchaseReturn.id)
                           .limit(limit).offset(offset)))


# ---------------------------------------------------------------- supplier ledger
def supplier_ledger(db: Session, p, supplier_id: uuid.UUID, limit: int, offset: int) -> dict:
    s = _supplier(db, p, supplier_id)
    running = func.sum(SupplierLedgerEntry.amount).over(
        order_by=(SupplierLedgerEntry.created_at, SupplierLedgerEntry.id)).label("running")
    sub = select(SupplierLedgerEntry, running).where(SupplierLedgerEntry.restaurant_id == p.restaurant_id,
                                                     SupplierLedgerEntry.supplier_id == s.id).subquery()
    rows = db.execute(select(sub).order_by(sub.c.created_at.desc(), sub.c.id.desc()).limit(limit).offset(offset)).mappings().all()
    balance = db.scalar(select(func.coalesce(func.sum(SupplierLedgerEntry.amount), 0)).where(
        SupplierLedgerEntry.restaurant_id == p.restaurant_id, SupplierLedgerEntry.supplier_id == s.id))
    return {"supplier_id": s.id, "supplier_name": s.name, "balance": money(balance),
            "entries": [{k: r[k] for k in ("id", "entry_type", "amount", "entry_date", "ref_type", "ref_id", "note", "created_at")}
                        | {"running_balance": r["running"]} for r in rows]}


def record_supplier_entry(db: Session, p, supplier_id: uuid.UUID, key: uuid.UUID, etype: str, amount: Decimal, note: str | None,
                          on: date | None) -> tuple[SupplierLedgerEntry, bool]:
    """A payment (reduces what we owe) or a manual adjustment. Idempotent on `key`."""
    s = _supplier(db, p, supplier_id)
    ex = db.scalar(select(SupplierLedgerEntry).where(SupplierLedgerEntry.restaurant_id == p.restaurant_id,
                                                     SupplierLedgerEntry.entry_type == etype, SupplierLedgerEntry.ref_id == key))
    if ex is not None:
        return ex, True
    signed = -abs(amount) if etype == "payment" else amount
    if signed == 0:
        raise HTTPException(422, "Amount must not be zero")
    e = SupplierLedgerEntry(restaurant_id=p.restaurant_id, supplier_id=s.id, entry_type=etype, amount=money(signed),
                            entry_date=on or date.today(), ref_type="manual", ref_id=key, note=note, created_by=p.user_id)
    db.add(e)
    audit.record(db, p, f"supplier_ledger.{etype}", "supplier", s.id, {"amount": str(e.amount)})
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        ex = db.scalar(select(SupplierLedgerEntry).where(SupplierLedgerEntry.restaurant_id == p.restaurant_id,
                                                         SupplierLedgerEntry.entry_type == etype, SupplierLedgerEntry.ref_id == key))
        if ex is None:
            raise
        return ex, True
    return e, False
