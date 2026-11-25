"""Cancelled vs merged orders, in ONE place (docs/testing/TESTER_BUGS_BACKEND_REPORT.md bugs 6 and 7).

A merge (POST /orders/{id}/merge) stores the joined order as status `cancelled` (it must leave the open orders) with
`merged_into_order_id` set and the reason "Merged into order #<number>". That is NOT a cancellation: nothing was lost, the lines and
tickets moved to the other order. Everything that counts cancelled orders (Reports > Payments, Leakage, staff sales, the Orders summary)
calls `cancelled_orders` below, so they cannot disagree again; the Z / X report (not touched here) already skips merged orders.

Merged orders written before `merged_into_order_id` was set, or with the old reason text "Merged into order e87c33d3" (8 characters of the
id), are recognised by that reason prefix: no data migration.

The order NUMBER the apps show is the first 6 characters of the order id in upper case (`#615056`): `order_number`.
"""
import re
import uuid
from datetime import datetime

from sqlalchemy import exists, func, or_, select

from app.models.core import Kot, Order, OrderLine, OrderStatus
from app.services.reports import Ctx

MERGED_PREFIX = "Merged into order"
_OLD_REASON = re.compile(r"^Merged into order #?([0-9a-fA-F]{6,8})\b")


def order_number(order_id: uuid.UUID | str) -> str:
    return str(order_id)[:6].upper()


def merged_reason(target_id: uuid.UUID) -> str:
    return f"{MERGED_PREFIX} #{order_number(target_id)}"


def merged_clause():
    """SQL: the order is a merged-away order (new rows by column, old rows by their reason text)."""
    return or_(Order.merged_into_order_id.is_not(None), Order.cancel_reason.like(f"{MERGED_PREFIX}%"))


def cancelled_clause():
    """SQL: a real cancellation = status cancelled and not a merge."""
    return (Order.status == OrderStatus.cancelled) & ~merged_clause()


def kind_of(o: Order) -> str | None:
    """'merged' | 'cancelled' | None (an order that is not cancelled)."""
    if o.status != OrderStatus.cancelled:
        return None
    if o.merged_into_order_id is not None or (o.cancel_reason or "").startswith(MERGED_PREFIX):
        return "merged"
    return "cancelled"


def merged_into_number(o: Order) -> str | None:
    if kind_of(o) != "merged":
        return None
    if o.merged_into_order_id is not None:
        return order_number(o.merged_into_order_id)
    m = _OLD_REASON.match(o.cancel_reason or "")
    return m.group(1)[:6].upper() if m else None


def display_reason(o: Order) -> str | None:
    """cancel_reason as shown: a merged order always reads 'Merged into order #<number>' (old rows had an id prefix)."""
    n = merged_into_number(o)
    return f"{MERGED_PREFIX} #{n}" if n else o.cancel_reason


def cancelled_orders(c: Ctx, start: datetime, end: datetime) -> list:
    """THE list of cancelled orders of a report window (cancelled_at in [start, end), the report's outlets), merged orders left out.
    Rows: id, cancel_reason, cancelled_by, created_by, was_sent (a kitchen ticket existed), value (lines x price), cancelled_at."""
    value = (select(func.coalesce(func.sum(OrderLine.unit_price * OrderLine.quantity), 0))
             .where(OrderLine.order_id == Order.id).scalar_subquery())
    sent = exists().where(Kot.order_id == Order.id).correlate(Order)
    return c.db.execute(select(Order.id, Order.cancel_reason, Order.cancelled_by, Order.created_by, sent.label("was_sent"),
                               value.label("value"), Order.cancelled_at)
                        .where(Order.restaurant_id == c.rid, c.sc(Order), cancelled_clause(),
                               Order.cancelled_at >= start, Order.cancelled_at < end)).all()


def merged_count(c: Ctx, start: datetime, end: datetime) -> int:
    return c.db.scalar(select(func.count(Order.id)).where(
        Order.restaurant_id == c.rid, c.sc(Order), Order.status == OrderStatus.cancelled, merged_clause(),
        Order.cancelled_at >= start, Order.cancelled_at < end)) or 0
