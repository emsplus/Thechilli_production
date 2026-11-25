"""Order rules that keep a first-time user from producing a wrong order (docs/ORDER_RULES.md, docs/ORDER_FLOW_AUDIT.md).

Every refusal is a RuleError: a stable `error.code`, a plain-English `error.message` that says what to do next, and
machine-readable `error.details` (ids the client needs to offer the next step). The same codes come back for queued
offline operations (POST /sync/operations results carry `code`).

* default option   - a dish with options (Half / Full) never reaches the kitchen without one (default_variant)
* sold out today   - menu_items.sold_out_on (restaurant-local date); resets itself the next day (is_sold_out)
* one order a table - a table with an unpaid order refuses a second one unless the client says so (open_order_on_table)
* kitchen first    - a dine-in bill needs every item sent to the kitchen first (unsent_items)
* print outcome    - what happened to the kitchen slip of a KOT (kot_print_status)
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.core import (
    Bill, DiningTable, Kot, MenuItem, MenuVariant, Order, OrderStatus, OrderType, Payment, Printer, PrintHub, PrintJob,
    Restaurant,
)

OPEN = (OrderStatus.open, OrderStatus.sent_to_kitchen)
DINE_IN = (OrderType.indoor, OrderType.outdoor)
# A billed order still waiting for its money keeps the table busy for this long after the bill was made; an older unpaid bill
# (forgotten in the system) must not block the table for ever.
UNPAID_BILL_HOLDS_TABLE = timedelta(hours=12)


class RuleError(HTTPException):
    """HTTP error with a stable code, a plain message and optional details (rendered by app.core.errors)."""

    def __init__(self, status: int, code: str, message: str, **details):
        super().__init__(status, message)
        self.code = code
        self.details = details or None


# ------------------------------------------------------------------------------------------------ dates
def local_today(db: Session, restaurant_id: uuid.UUID) -> date:
    tz = db.scalar(select(Restaurant.timezone).where(Restaurant.id == restaurant_id)) or "Asia/Kolkata"
    return datetime.now(ZoneInfo(tz)).date()


# ------------------------------------------------------------------------------------------------ menu
def is_sold_out(item: MenuItem, today: date) -> bool:
    return item.sold_out_on is not None and item.sold_out_on == today


def default_variant(item: MenuItem) -> MenuVariant | None:
    """The option an order line gets when it names none, or None when ordering the dish without an option is a real choice.

    * the active option marked `is_default`, else
    * the cheapest active option that costs nothing extra (price_delta <= 0: "Half" when Half is the base price and Full costs
      more), ties broken by name;
    * None when the dish has no options, or when EVERY option costs extra (an "Iced Latte" with only "Large +3": the plain
      latte at the base price is what the customer ordered, so it is never silently upgraded)."""
    active = [v for v in item.variants if v.is_active]
    if not active:
        return None
    marked = [v for v in active if v.is_default]
    if marked:
        return marked[0]
    base = [v for v in active if v.price_delta <= 0]
    if not base:
        return None
    return min(base, key=lambda v: (v.price_delta, v.name.lower(), str(v.id)))


def check_orderable(item: MenuItem, today: date) -> None:
    if not item.is_active:
        raise RuleError(409, "item_unavailable", f"{item.name} is no longer on the menu. Remove it from the order.",
                        item_id=str(item.id), reason="removed")
    if is_sold_out(item, today):
        raise RuleError(409, "item_unavailable", f"{item.name} is sold out today. Remove it from the order or pick another dish.",
                        item_id=str(item.id), reason="sold_out")


# ------------------------------------------------------------------------------------------------ tables
def _unpaid_billed(db: Session, table_ids: list[uuid.UUID], exclude: uuid.UUID | None = None) -> list[tuple[Order, Bill]]:
    """Billed orders on the tables whose current bill is not fully paid and was made recently."""
    if not table_ids:
        return []
    paid = select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.bill_id == Bill.id).scalar_subquery()
    q = (select(Order, Bill).join(Bill, Bill.order_id == Order.id)
         .where(Order.table_id.in_(table_ids), Order.status == OrderStatus.billed, Bill.status == "active",
                Bill.total > paid, Bill.finalized_at > func.now() - UNPAID_BILL_HOLDS_TABLE)
         .order_by(Order.created_at))
    if exclude is not None:
        q = q.where(Order.id != exclude)
    return [(o, b) for o, b in db.execute(q).all()]


def _minutes_since(ts: datetime | None) -> int | None:
    if ts is None:
        return None
    return max(0, int((datetime.now(ts.tzinfo) - ts).total_seconds() // 60))


def order_summary(o: Order, bill: Bill | None = None) -> dict:
    subtotal = sum((l.unit_price * l.quantity for l in o.lines), Decimal("0"))
    out = {"order_id": str(o.id), "token_number": o.token_number, "status": o.status.value,
           "items_count": sum(l.quantity for l in o.lines), "subtotal": str(subtotal),
           "total": str(bill.total if bill else subtotal), "minutes_open": _minutes_since(o.created_at)}
    if bill is not None:
        out.update(bill_id=str(bill.id), invoice_number=bill.invoice_number)
    return out


def open_order_on_table(db: Session, table_id: uuid.UUID, exclude: uuid.UUID | None = None) -> tuple[Order, Bill | None] | None:
    """The first unpaid, not cancelled order on the table: open / in the kitchen, or billed and waiting for payment."""
    q = select(Order).where(Order.table_id == table_id, Order.status.in_(OPEN)).order_by(Order.created_at).limit(1)
    if exclude is not None:
        q = q.where(Order.id != exclude)
    o = db.scalar(q)
    if o is not None:
        return o, None
    billed = _unpaid_billed(db, [table_id], exclude)
    return billed[0] if billed else None


def unpaid_billed_by_table(db: Session, table_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[tuple[Order, Bill]]]:
    out: dict[uuid.UUID, list[tuple[Order, Bill]]] = {}
    for o, b in _unpaid_billed(db, table_ids):
        out.setdefault(o.table_id, []).append((o, b))
    return out


def refuse_second_order(db: Session, table: DiningTable) -> None:
    found = open_order_on_table(db, table.id)
    if found is None:
        return
    o, bill = found
    msg = (f"Table {table.label} already has a bill waiting for payment. Take the payment first, or start a separate order."
           if bill else f"Table {table.label} already has an order. Add these items to it, or start a separate order.")
    raise RuleError(409, "table_has_open_order", msg, table_id=str(table.id), table_label=table.label,
                    existing_order_id=str(o.id), existing_order_client_uuid=str(o.client_uuid),
                    existing_order=order_summary(o, bill))


# ------------------------------------------------------------------------------------------------ kitchen first
def unsent_items(db: Session, order: Order) -> int:
    from app.services.orders import kots_sent_count  # local import: orders imports this module
    return max(0, len(order.lines) - kots_sent_count(db, order.id))


# ------------------------------------------------------------------------------------------------ print outcome
NO_PRINTER_MSG = "No kitchen printer is set up. The order shows on the kitchen screen only."


def kot_print_status(db: Session, kot: Kot) -> dict:
    """{status, message, error?, needs_reprint, unrouted_items, hub_online} for the kitchen slip of one KOT.

    status: no_printer (no printer prints KOTs automatically: not an error) | queued (waiting for the print helper) |
    sent (the print helper took it) | printed | failed (needs a reprint)."""
    from app.services import printing  # local import: printing pulls in the renderers
    printers = list(db.scalars(select(Printer).where(
        Printer.restaurant_id == kot.restaurant_id, Printer.outlet_id == kot.outlet_id, Printer.is_active.is_(True),
        Printer.auto_kot.is_(True)).order_by(Printer.created_at)))
    jobs = list(db.scalars(select(PrintJob).where(PrintJob.kind == "kot", PrintJob.ref_id == kot.id)
                           .order_by(PrintJob.reprint_no, PrintJob.copy_no)))
    hubs = db.scalars(select(PrintHub).where(PrintHub.restaurant_id == kot.restaurant_id, PrintHub.outlet_id == kot.outlet_id,
                                             PrintHub.revoked_at.is_(None))).all()
    hub_online = any(printing.is_online(h) for h in hubs)
    unrouted: list[str] = []
    if printers:
        cats = printing._line_categories(db, kot)
        covered = [False] * len(kot.payload)
        for pr in printers:
            wanted = set(pr.kot_category_ids or [])
            for i, c in enumerate(cats):
                if not wanted or c in wanted:
                    covered[i] = True
        unrouted = [str(ln.get("item")) for ln, ok in zip(kot.payload, covered) if not ok]
    if not jobs and not printers:
        return {"status": "no_printer", "message": NO_PRINTER_MSG, "needs_reprint": False, "unrouted_items": [],
                "hub_online": hub_online}
    latest: dict[uuid.UUID, list[PrintJob]] = {}
    for j in jobs:  # per printer, only its newest print (a reprint replaces an earlier failure)
        cur = latest.get(j.printer_id)
        if cur is None or j.reprint_no > cur[0].reprint_no:
            latest[j.printer_id] = [j]
        elif j.reprint_no == cur[0].reprint_no:
            cur.append(j)
    final = [j for js in latest.values() for j in js]
    states = {j.status for j in final}
    error = None
    if not final:
        status = "failed"
        error = "None of the kitchen printers is set up for these dishes."
    elif "failed" in states:
        status = "failed"
        error = next(j.last_error for j in final if j.status == "failed") or "The kitchen printer did not print."
    elif "queued" in states:
        status = "queued"
    elif "sent" in states:
        status = "sent"
    else:
        status = "printed"
    needs = status == "failed" or bool(unrouted)
    if status == "failed":
        msg = f"The kitchen printer did not print ticket {kot.number}. Tap Print again."
    elif unrouted:
        msg = "Some dishes are not set up for any kitchen printer: " + ", ".join(unrouted) + ". Tell the kitchen."
    elif status == "queued" and not hub_online:
        msg = "Waiting for the print helper on the counter computer. Check that it is switched on."
    elif status in ("queued", "sent"):
        msg = "Printing in the kitchen."
    else:
        msg = "Printed in the kitchen."
    out = {"status": status, "message": msg, "needs_reprint": needs, "unrouted_items": unrouted, "hub_online": hub_online}
    if error:
        out["error"] = error
    return out
