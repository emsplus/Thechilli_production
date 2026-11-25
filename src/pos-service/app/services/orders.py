import uuid
from decimal import Decimal

from fastapi import HTTPException
from datetime import date, datetime, timedelta, timezone

from zoneinfo import ZoneInfo

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.core import (
    Bill, Customer, DiningTable, Kot, KotStatus, MenuItem, MenuVariant, Order, OrderLine,
    OrderStatus, OrderType,
)
from app.schemas.common import OrderIn
from app.services import audit, business_time, business_type, modifiers, order_kinds, order_rules, outlets, wallet
from app.services.order_rules import RuleError
from app.core.permissions import P
from app.models.core import Outlet
from app.services.billing import db_now, lock_activity, next_counter, paid_total
from app.services.billing import row_outlet as billing_outlet


def order_subtotal(order: Order) -> Decimal:
    return sum((l.unit_price * l.quantity for l in order.lines), Decimal("0"))


class NothingToSend(HTTPException):
    def __init__(self):
        super().__init__(409, "Everything on this order is already in the kitchen")


class PriceConflict(Exception):
    def __init__(self, conflicts: list[dict]):
        self.conflicts = conflicts


def build_lines(db: Session, p, lines, accept_price_changes: bool = False, start: int = 0,
                batch_uuid: uuid.UUID | None = None) -> list[OrderLine]:
    """OrderLines for `lines` with server prices, positions start..start+n-1. Raises PriceConflict (nothing is kept)."""
    out: list[OrderLine] = []
    conflicts: list[dict] = []
    today = order_rules.local_today(db, p.restaurant_id)
    for ln in lines:
        item = db.get(MenuItem, ln.item_id)
        if not item or item.restaurant_id != p.restaurant_id:
            raise RuleError(404, "item_not_found", "A dish on this order is not on the menu any more. Remove it and add it again.",
                            item_id=str(ln.item_id))
        # archived, or sold out today, after a (possibly offline) device cached the menu: 409 item_unavailable
        order_rules.check_orderable(item, today)
        price, name = item.price, item.name
        variant_id, defaulted = ln.variant_id, False
        if variant_id is None:  # Half/Full: never a line without an option (docs/ORDER_RULES.md)
            dv = order_rules.default_variant(item)
            if dv is not None:
                variant_id, defaulted = dv.id, True
        if variant_id:
            v = db.get(MenuVariant, variant_id)
            if not v or v.item_id != item.id:
                raise RuleError(404, "option_not_found", f"That choice is not available for {item.name}. Pick it again.",
                                item_id=str(item.id))
            if not v.is_active:  # removed from the menu after a (possibly offline) device cached it
                raise RuleError(409, "item_unavailable", f"'{v.name}' of {item.name} is no longer on the menu. Pick another choice.",
                                item_id=str(item.id), reason="option_removed")
            price += v.price_delta
            name = f"{item.name} ({v.name})"
            if price < 0:  # a negative option delta larger than the price (same rule as the modifiers below)
                raise HTTPException(422, f"The choices picked make {name} cost less than zero. Change them.")
        # Modifier groups / combos (docs/MODIFIERS_OFFERS.md): nothing changes for an item without them.
        delta, mods = modifiers.resolve(db, item, getattr(ln, "modifiers", None))
        if delta:
            price += modifiers.paise_to_money(delta)
            if price < 0:
                raise HTTPException(422, f"The choices picked make {name} cost less than zero. Change them.")
        components = modifiers.combo_snapshot(db, item)
        if ln.expected_unit_price is not None and ln.expected_unit_price != price and not accept_price_changes:
            conflicts.append({"item": name, "expected": str(ln.expected_unit_price), "current": str(price)})
        line = OrderLine(item_id=item.id, variant_id=variant_id, item_name=name, unit_price=price,
                         quantity=ln.quantity, note=_clean_note(ln.note), position=start + len(out), batch_uuid=batch_uuid,
                         modifiers=mods, components=components)
        line.variant_defaulted = defaulted  # response only (OrderLineOut.variant_defaulted)
        out.append(line)
    if conflicts:
        raise PriceConflict(conflicts)
    return out


def add_lines(db: Session, p, order_id: uuid.UUID, batch_uuid: uuid.UUID, lines,
              accept_price_changes: bool = False) -> Order:
    """Append lines to an order that is still open / in the kitchen (the customer ordered more later). Locks the
    order row like send_kot / finalize_bill, so an add racing a bill or a KOT is serialised and a billed order
    refuses it. Idempotent on batch_uuid: a replay changes nothing. The new lines go out with the next KOT."""
    order = db.get(Order, order_id, with_for_update=True)
    if not order or order.restaurant_id != p.restaurant_id or not outlets.visible(p, order):
        raise HTTPException(404, "Order not found")
    if any(l.batch_uuid == batch_uuid for l in order.lines):  # replay of a request that already landed
        db.commit()  # release the row lock
        return order
    if order.status == OrderStatus.cancelled:
        raise RuleError(409, "order_cancelled", "This order was cancelled. Start a new order.")
    if order.status == OrderStatus.billed or db.scalar(select(Bill.id).where(Bill.order_id == order.id).limit(1)):
        raise RuleError(409, "order_billed", "This order already has a bill. Start a new order for more items.")
    start = max((l.position for l in order.lines), default=-1) + 1
    order.lines.extend(build_lines(db, p, lines, accept_price_changes, start, batch_uuid))
    audit.record(db, p, "order.add_lines", "order", order.id, {"batch": str(batch_uuid), "lines": len(lines)})
    db.commit()
    return order


def _clean_note(note: str | None) -> str | None:
    note = (note or "").strip()
    return note or None


def token_day(db: Session, outlet_id: uuid.UUID) -> date:
    """Today's date at the outlet (its own timezone): the token counter restarts at 1 every local day."""
    tz = db.scalar(select(Outlet.timezone).where(Outlet.id == outlet_id)) or "UTC"
    return datetime.now(ZoneInfo(tz)).date()


def next_token(db: Session, restaurant_id: uuid.UUID, outlet_id: uuid.UUID) -> tuple[date, int]:
    """Gap-free token of the order, per outlet per local day: the same row-locked counter as invoice / KOT numbers (kind TOK,
    'year' = YYYYMMDD). Allocated in the order's own transaction, so a rolled-back order gives its token back."""
    day = token_day(db, outlet_id)
    return day, next_counter(db, restaurant_id, outlet_id, "TOK", day.year * 10000 + day.month * 100 + day.day)


def type_for_table(requested: OrderType, table: DiningTable) -> OrderType:
    """The order type of an order that has a table. A dine-in order follows the table's area (an Indoor table is a Dine-in order, an
    Outdoor table an Outdoor one) whatever the client sent, so the same table never reads Dine-in on one order and Outdoor on
    another. Takeaway / delivery orders (and a table whose area is neither indoor nor outdoor) keep the requested type."""
    if requested in (OrderType.indoor, OrderType.outdoor) and table.area in (OrderType.indoor, OrderType.outdoor):
        return table.area
    return requested


def create_order(db: Session, p, data: OrderIn, accept_price_changes: bool = False, client_at: business_time.ClientTime | None = None,
                 wallet_guard: bool = True) -> Order:
    """Idempotent on (restaurant, client_uuid). Prices always come from the server. client_at: the device's time of an order taken
    offline (sync replay only): when plausible it is the order's time (services/business_time.py), else the sync time.
    wallet_guard: a NEW order is refused with 402 chilli_empty when CHILLI_ENFORCE=on and the Chilli are used up
    (docs/CHILLI_WALLET.md); False for the offline sync replay (the order already exists on a device, never refused)."""
    existing = db.scalar(select(Order).where(
        Order.restaurant_id == p.restaurant_id, Order.client_uuid == data.client_uuid))
    if existing:
        return existing
    if wallet_guard:
        wallet.guard_new_order(db, p)

    # Business type (docs/BUSINESS_TYPES.md): indoor / outdoor orders need their capability, delivery needs the delivery module,
    # any table needs tables; takeaway and delivery orders never need a table, for every business type.
    order_type = data.order_type
    if not data.table_id:
        business_type.require_order_type(db, p.restaurant_id, order_type)  # indoor: dine_in, outdoor: outdoor, delivery: module
    if data.table_id:
        business_type.require(db, p.restaurant_id, "tables")
    if data.order_type == OrderType.indoor and data.table_id is None:
        raise RuleError(422, "table_required", "Pick a table for a dine-in order.")
    if data.table_id:
        # FOR NO KEY UPDATE on the table row: two waiters opening the same free table at once are serialised here, so the
        # one-order-per-table check below sees the other's committed order (BREAK_BACKEND_REPORT.md D2). NO KEY: inserting
        # orders that reference the table (their FK check takes KEY SHARE) is not blocked by it.
        table = db.get(DiningTable, data.table_id, with_for_update={"key_share": True})
        if not table or table.restaurant_id != p.restaurant_id or table.outlet_id != outlets.outlet_of(db, p):
            raise HTTPException(404, "Table not found")
        if not table.is_active:
            raise HTTPException(409, f"Table {table.label} is no longer in use. Pick another table.")
        order_type = type_for_table(order_type, table)  # the table's area decides indoor / outdoor, not the client
        business_type.require_order_type(db, p.restaurant_id, order_type)
        # a double-submit of THIS order waited on the lock above: it is a replay, not a second order on the table
        replay = db.scalar(select(Order).where(Order.restaurant_id == p.restaurant_id, Order.client_uuid == data.client_uuid))
        if replay:
            db.commit()  # release the table lock
            return replay
        if not data.allow_second_order:  # one unpaid order per table unless the client explicitly starts another
            order_rules.refuse_second_order(db, table)

    if data.customer_id:
        cust = db.get(Customer, data.customer_id)
        if not cust or cust.restaurant_id != p.restaurant_id:
            raise HTTPException(404, "Customer not found")
    server_now = db_now(db)
    created_at, ignored = business_time.resolve(client_at, server_now)
    order = Order(restaurant_id=p.restaurant_id, outlet_id=outlets.outlet_of(db, p), client_uuid=data.client_uuid, customer_id=data.customer_id,
                  order_type=order_type, table_id=data.table_id, created_by=p.user_id, note=_clean_note(data.note),
                  **({"created_at": created_at} if client_at is not None else {}))
    order.lines.extend(build_lines(db, p, data.lines, accept_price_changes))
    order.token_date, order.token_number = next_token(db, order.restaurant_id, order.outlet_id)
    db.add(order)
    try:
        db.flush()
    except IntegrityError:  # concurrent duplicate request
        db.rollback()
        return db.scalar(select(Order).where(
            Order.restaurant_id == p.restaurant_id, Order.client_uuid == data.client_uuid))
    audit.record(db, p, "order.create", "order", order.id,
                 {"second_order_on_table": True} if data.allow_second_order and data.table_id else None)
    business_time.record(db, p, "order", order.id, client_at, created_at, server_now, ignored)
    db.commit()
    return order


def send_kot(db: Session, p, order_id: uuid.UUID) -> Kot:
    order = db.get(Order, order_id, with_for_update=True)
    if not order or order.restaurant_id != p.restaurant_id or not outlets.visible(p, order):
        raise HTTPException(404, "Order not found")
    if order.status == OrderStatus.cancelled:
        raise RuleError(409, "order_cancelled", "This order was cancelled. Nothing was sent to the kitchen.")
    if order.status == OrderStatus.billed:
        raise RuleError(409, "order_billed", "This order already has a bill. Start a new order for more items.")
    sent = sum(len(k.payload) for k in db.scalars(select(Kot).where(Kot.order_id == order.id)))
    new_lines = order.lines[sent:]
    if not new_lines:
        raise NothingToSend()
    # Continuous per-OUTLET counter (year 0 = never resets; Kot.number is unique per outlet).
    number = next_counter(db, order.restaurant_id, order.outlet_id, "KOT", 0)
    kot = Kot(restaurant_id=p.restaurant_id, outlet_id=order.outlet_id, order_id=order.id, number=number,
              payload=[kot_entry(l) for l in new_lines])
    order.status = OrderStatus.sent_to_kitchen
    db.add(kot)
    audit.record(db, p, "kot.send", "order", order.id, {"kot": number})
    db.commit()
    try:  # kitchen printers: after the commit, own session, never raises (a print problem cannot fail the KOT)
        from app.services import printing
        printing.auto_print_kot(kot.restaurant_id, kot.id, p.user_id)
    except Exception:  # pragma: no cover - auto_print_kot already swallows
        import logging
        logging.getLogger("app.printing").exception("auto-print hook failed")
    return kot


def kot_entry(l: OrderLine) -> dict:
    """One KOT payload line. `modifiers` ('Spice level: Medium') and `components` (combo contents) only when present, so
    plain lines keep exactly the old shape."""
    e = {"item": l.item_name, "qty": l.quantity, "note": l.note, "item_id": str(l.item_id)}
    if l.modifiers:
        e["modifiers"] = modifiers.kot_lines(l.modifiers)
    if l.components:
        e["components"] = [{"item": c["item"], "qty": c["qty"] * l.quantity} for c in l.components]
    return e


def kots_sent_count(db: Session, order_id: uuid.UUID) -> int:
    """Lines of the order already on a KOT (send_kot slices order.lines by this many)."""
    return sum(len(k.payload) for k in db.scalars(select(Kot).where(Kot.order_id == order_id)))


def cancel_order(db: Session, p, order_id: uuid.UUID, reason: str, only_unsent: bool = False) -> Order:
    """Cancel an unbilled order. Locks the order row first, exactly like finalize_bill, so a cancel racing
    a finalize has exactly one winner. Idempotent: an already-cancelled order is returned unchanged
    (the first reason is kept). Cancelled orders never post stock (consumption happens only at billing)."""
    lock_activity(db, billing_outlet(db, Order, order_id, p.restaurant_id))  # a Z close counts cancellations ("voids")
    order = db.get(Order, order_id, with_for_update=True)
    if not order or order.restaurant_id != p.restaurant_id or not outlets.visible(p, order):
        raise HTTPException(404, "Order not found")
    if order.status == OrderStatus.cancelled:
        return order
    if order.status == OrderStatus.billed or db.scalar(select(Bill.id).where(Bill.order_id == order.id)):
        raise RuleError(409, "order_billed", "This order already has a bill. Ask a manager to cancel the bill instead.")
    in_kitchen = db.scalar(select(Kot.id).where(Kot.order_id == order.id, Kot.status != KotStatus.cancelled).limit(1))
    if only_unsent and in_kitchen:
        raise RuleError(409, "manager_required", "The kitchen already has this order. Ask a manager to cancel it.")
    if in_kitchen and not p.can(P.ORDERS_CANCEL_AFTER_KITCHEN):  # food may already be cooking: manager decision
        raise RuleError(403, "manager_required", "The kitchen already has this order. Ask a manager to cancel it.")
    order.status = OrderStatus.cancelled
    order.bill_requested_at = None
    order.cancel_reason, order.cancelled_by = reason, p.user_id
    order.cancelled_at = db_now(db)
    # Tickets the kitchen already finished (ready/served) stay as they are.
    open_kots = db.scalars(select(Kot).where(
        Kot.order_id == order.id, Kot.status.in_((KotStatus.pending, KotStatus.preparing))).with_for_update()).all()
    for k in open_kots:
        k.status = KotStatus.cancelled
    from app.services import delivery  # local import: delivery builds on this module
    delivery.after_cancel(db, order, reason)  # delivery orders: state + webhook in this same transaction (no-op otherwise)
    audit.record(db, p, "order.cancel", "order", order.id,
                 {"reason": reason, "kots_cancelled": [k.number for k in open_kots]})
    db.commit()
    return order


def set_customer(db: Session, p, order_id: uuid.UUID, customer_id: uuid.UUID | None) -> Order:
    """Attach / change / clear the customer of an order that is not billed yet. Locks the order row like
    finalize_bill does, so a change racing a finalize either lands before the bill snapshots the customer or
    gets a 409. Idempotent: setting the current value again changes nothing and writes no audit row."""
    order = db.get(Order, order_id, with_for_update=True)
    if not order or order.restaurant_id != p.restaurant_id or not outlets.visible(p, order):
        raise HTTPException(404, "Order not found")
    if customer_id is not None:
        cust = db.get(Customer, customer_id)
        if not cust or cust.restaurant_id != p.restaurant_id:
            raise HTTPException(404, "Customer not found")
    if order.status == OrderStatus.cancelled:
        raise RuleError(409, "order_cancelled", "This order was cancelled.")
    if order.status == OrderStatus.billed or db.scalar(select(Bill.id).where(Bill.order_id == order.id).limit(1)):
        raise RuleError(409, "order_billed", "This order already has a bill. The bill keeps the customer it was made with.")
    if order.customer_id == customer_id:
        db.commit()  # release the row lock
        return order
    before = order.customer_id
    order.customer_id = customer_id
    audit.record(db, p, "order.customer", "order", order.id,
                 {"from": str(before) if before else None, "to": str(customer_id) if customer_id else None})
    db.commit()
    return order


def _lock_open_order(db: Session, p, order_id: uuid.UUID) -> Order:
    order = db.get(Order, order_id, with_for_update=True)
    if not order or order.restaurant_id != p.restaurant_id or not outlets.visible(p, order):
        raise HTTPException(404, "Order not found")
    if order.status == OrderStatus.cancelled:
        raise RuleError(409, "order_cancelled", "This order was cancelled.")
    if order.status == OrderStatus.billed or db.scalar(select(Bill.id).where(Bill.order_id == order.id).limit(1)):
        raise RuleError(409, "order_billed", "This order already has a bill, so it cannot be changed.")
    return order


def remove_line(db: Session, p, order_id: uuid.UUID, line_id: uuid.UUID) -> Order:
    """Remove a line the kitchen has NOT been sent yet (the lines after the ones already on a KOT). The last remaining line
    cannot be removed (cancel the order instead). Audited."""
    order = _lock_open_order(db, p, order_id)
    line = _unsent_line(db, order, line_id)
    if len(order.lines) == 1:
        raise RuleError(409, "last_item", "It is the only item. Cancel the order instead.")
    order.lines.remove(line)
    audit.record(db, p, "order.remove_line", "order", order.id,
                 {"line": str(line_id), "item": line.item_name, "quantity": line.quantity})
    db.commit()
    return order


def _unsent_line(db: Session, order: Order, line_id: uuid.UUID) -> OrderLine:
    line = next((l for l in order.lines if l.id == line_id), None)
    if line is None:
        raise HTTPException(404, "That item is not on this order")
    if order.lines.index(line) < kots_sent_count(db, order.id):
        raise RuleError(409, "already_in_kitchen", "That item is already in the kitchen, so it cannot be changed here. "
                                                   "Ask a manager.")
    return line


def edit_line(db: Session, p, order_id: uuid.UUID, line_id: uuid.UUID, data) -> Order:
    """Change the quantity / note of a line the kitchen has NOT been sent yet (docs/ORDER_RULES.md). Audited; a request that
    changes nothing writes nothing."""
    order = _lock_open_order(db, p, order_id)
    line = _unsent_line(db, order, line_id)
    before = {"quantity": line.quantity, "note": line.note}
    if data.quantity is not None:
        line.quantity = data.quantity
    if "note" in data.model_fields_set:
        line.note = _clean_note(data.note)
    after = {"quantity": line.quantity, "note": line.note}
    if after != before:
        audit.record(db, p, "order.edit_line", "order", order.id,
                     {"line": str(line.id), "item": line.item_name, "from": before, "to": after})
    db.commit()
    return order


def _table_in_outlet(db: Session, p, table_id: uuid.UUID, outlet_id: uuid.UUID, lock: bool = False) -> DiningTable:
    t = db.get(DiningTable, table_id, with_for_update=lock)
    if not t or t.restaurant_id != p.restaurant_id or t.outlet_id != outlet_id:
        raise HTTPException(404, "Table not found")  # another tenant's / another outlet's table looks like a missing one
    if not t.is_active:
        raise HTTPException(409, f"Table {t.label} is no longer in use")
    return t


def transfer_order(db: Session, p, order_id: uuid.UUID, table_id: uuid.UUID) -> Order:
    """Move an unbilled dine-in order to another FREE table of the same outlet. Idempotent (same table again = no change).
    A table with an open order is a 409: merge the two orders instead."""
    business_type.require(db, p.restaurant_id, "tables")
    order = _lock_open_order(db, p, order_id)
    if order.order_type not in (OrderType.indoor, OrderType.outdoor):
        raise RuleError(409, "not_dine_in", "Only dine-in orders have a table.")
    if order.table_id == table_id:
        db.commit()
        return order
    target = _table_in_outlet(db, p, table_id, order.outlet_id)
    db.get(DiningTable, target.id, with_for_update={"key_share": True})  # serialise with orders opened on it (D2)
    busy = db.scalar(select(Order.id).where(
        Order.table_id == target.id, Order.status.in_((OrderStatus.open, OrderStatus.sent_to_kitchen)),
        Order.id != order.id).limit(1))
    if busy:
        raise RuleError(409, "table_has_open_order",
                        f"Table {target.label} already has an order. Join the two orders instead.",
                        table_id=str(target.id), table_label=target.label, existing_order_id=str(busy))
    before = order.table_id
    order.table_id = target.id
    order.order_type = type_for_table(order.order_type, target)  # an Indoor <-> Outdoor move changes the type with it
    audit.record(db, p, "order.transfer", "order", order.id,
                 {"from_table": str(before) if before else None, "to_table": str(target.id), "to_label": target.label,
                  "order_type": order.order_type.value})
    db.commit()
    return order


def merge_orders(db: Session, p, source_id: uuid.UUID, target_id: uuid.UUID) -> Order:
    """Merge order `source` into order `target` (same outlet, both unbilled): the source's lines and KOT tickets move to the
    target, the source is stored as cancelled with reason 'Merged into order #<number>' and merged_into_order_id (kind 'merged': never counted as a cancellation, see order_kinds). Lines the kitchen already
    has stay ahead of the unsent ones, so the next KOT still carries only the unsent lines of both. Idempotent: merging an
    already merged order into the same target returns the target. Returns the target."""
    if source_id == target_id:
        raise HTTPException(422, "Pick a different order to join this one with.")
    oid = billing_outlet(db, Order, source_id, p.restaurant_id)
    oid2 = billing_outlet(db, Order, target_id, p.restaurant_id)
    allowed = getattr(p, "outlet_ids", None)
    if allowed is not None and (oid not in allowed or oid2 not in allowed):
        raise HTTPException(404, "Order not found")
    if oid2 != oid:
        raise HTTPException(409, "These orders are in different branches and cannot be joined.")
    lock_activity(db, oid)  # the cancelled source counts as a void in the day's report
    first, second = sorted((source_id, target_id), key=str)  # fixed lock order: two merges cannot deadlock
    rows = {i: db.get(Order, i, with_for_update=True) for i in (first, second)}
    src, tgt = rows[source_id], rows[target_id]
    if src.merged_into_order_id == tgt.id:
        db.commit()
        return tgt
    for o in (src, tgt):
        if o.status in (OrderStatus.billed, OrderStatus.cancelled) or db.scalar(select(Bill.id).where(Bill.order_id == o.id).limit(1)):
            if o.status == OrderStatus.cancelled:
                raise RuleError(409, "order_cancelled", "One of these orders was cancelled.")
            raise RuleError(409, "order_billed", "One of these orders already has a bill, so they cannot be joined.")
    sent_t, sent_s = kots_sent_count(db, tgt.id), kots_sent_count(db, src.id)
    t_lines, s_lines = list(tgt.lines), list(src.lines)
    merged = t_lines[:sent_t] + s_lines[:sent_s] + t_lines[sent_t:] + s_lines[sent_s:]
    moved = [l.id for l in s_lines]
    db.flush()
    for i, l in enumerate(merged):  # plain UPDATEs: the delete-orphan cascade must not see a line leave its order
        db.execute(update(OrderLine).where(OrderLine.id == l.id).values(order_id=tgt.id, position=i))
    for l in merged:
        db.expire(l)
    db.expire(tgt, ["lines"])
    db.expire(src, ["lines"])
    kots = db.scalars(select(Kot).where(Kot.order_id == src.id).with_for_update()).all()
    for k in kots:
        k.order_id = tgt.id
    if src.bill_requested_at and (tgt.bill_requested_at is None or src.bill_requested_at < tgt.bill_requested_at):
        tgt.bill_requested_at, tgt.bill_requested_by = src.bill_requested_at, src.bill_requested_by
    if src.note and src.note != tgt.note:
        tgt.note = f"{tgt.note} | {src.note}"[:300] if tgt.note else src.note
    src.status, src.bill_requested_at = OrderStatus.cancelled, None
    src.cancel_reason, src.cancelled_by, src.cancelled_at = order_kinds.merged_reason(tgt.id), p.user_id, db_now(db)
    src.merged_into_order_id = tgt.id
    audit.record(db, p, "order.merge", "order", tgt.id,
                 {"source": str(src.id), "source_token": src.token_number, "lines_moved": len(moved), "kots_moved": [k.number for k in kots]})
    db.commit()
    return tgt


def request_bill(db: Session, p, order_id: uuid.UUID) -> Order:
    """The waiter asks the cashier to bring the bill. Idempotent: the first request's time / user are kept, nothing is audited
    again. Cleared when the bill is finalized (billing.finalize_bill) or the order is cancelled."""
    order = db.get(Order, order_id, with_for_update=True)
    if not order or order.restaurant_id != p.restaurant_id or not outlets.visible(p, order):
        raise HTTPException(404, "Order not found")
    if order.status == OrderStatus.cancelled:
        raise RuleError(409, "order_cancelled", "This order was cancelled.")
    if order.status == OrderStatus.billed or db.scalar(select(Bill.id).where(Bill.order_id == order.id).limit(1)):
        raise RuleError(409, "order_billed", "This order already has a bill.")
    if order.bill_requested_at is None:
        order.bill_requested_at, order.bill_requested_by = db_now(db), p.user_id
        audit.record(db, p, "order.request_bill", "order", order.id, {"token": order.token_number})
    db.commit()
    return order


REMINDER_REPEAT = timedelta(seconds=60)  # one "remind the counter" per order per minute (a second tap inside it sends nothing)


def _billed_order(db: Session, p, order_id: uuid.UUID) -> tuple[Order, Bill | None]:
    """The order (row-locked, tenant + outlet checked) and its current unpaid-able bill: the active one, None if voided."""
    order = db.get(Order, order_id, with_for_update=True)
    if not order or order.restaurant_id != p.restaurant_id or not outlets.visible(p, order):
        raise HTTPException(404, "Order not found")
    if order.status == OrderStatus.cancelled:
        raise RuleError(409, "order_cancelled", "This order was cancelled.")
    if order.status != OrderStatus.billed:
        raise RuleError(409, "order_not_billed", "The bill has not been made yet. Use Request bill first.")
    bill = db.scalar(select(Bill).where(Bill.order_id == order.id, Bill.status == "active"))
    return order, bill


def remind_payment(db: Session, p, order_id: uuid.UUID) -> tuple[Order, Bill, bool]:
    """The waiter asks the counter to take the payment of a BILLED, unpaid or part-paid order. It becomes an entry of kind
    payment_reminder in the counter's queue (GET /bill-requests, services/waiter.bill_requests), carried by the order's own
    bill_requested_at / bill_requested_by (no new table: the `alerts` table is inventory-only). Idempotent per order per minute:
    inside REMINDER_REPEAT nothing changes and `already_sent` is True. Returns (order, bill, already_sent)."""
    order, bill = _billed_order(db, p, order_id)
    if bill is None:
        raise RuleError(409, "bill_not_payable", "This bill was cancelled. There is nothing to pay.")
    db.expire(bill, ["payments"])
    if bill.total - paid_total(bill) <= 0:
        raise RuleError(409, "already_paid", "This bill is already paid.")
    now = db_now(db)
    if order.bill_requested_at is not None and now - order.bill_requested_at < REMINDER_REPEAT:
        db.rollback()  # release the row lock; nothing was changed
        return order, bill, True
    order.bill_requested_at, order.bill_requested_by = now, p.user_id
    audit.record(db, p, "order.remind_payment", "order", order.id,
                 {"bill": bill.invoice_number, "balance_due": str(bill.total - paid_total(bill)), "token": order.token_number})
    db.commit()
    return order, bill, False


def dismiss_payment_reminder(db: Session, p, order_id: uuid.UUID) -> bool:
    """The counter clears a payment reminder it has seen (without taking payment). Idempotent: False when none was open."""
    order, _ = _billed_order(db, p, order_id)
    if order.bill_requested_at is None:
        db.rollback()
        return False
    order.bill_requested_at = order.bill_requested_by = None
    audit.record(db, p, "order.dismiss_payment_reminder", "order", order.id, {"token": order.token_number})
    db.commit()
    return True


def set_note(db: Session, p, order_id: uuid.UUID, note: str | None) -> Order:
    order = _lock_open_order(db, p, order_id)
    note = _clean_note(note)
    if order.note != note:
        audit.record(db, p, "order.note", "order", order.id, {"from": order.note, "to": note})
        order.note = note
    db.commit()
    return order
