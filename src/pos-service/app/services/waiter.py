"""Waiter app backend (docs/WAITER_API.md): shifts, table assignment, table status, bill requests."""
import uuid
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models.core import Bill, DiningTable, Order, OrderStatus, Shift, TableAssignment, User
from app.schemas.waiter import (
    BillRequestOut, ShiftOpenOut, ShiftOut, StaffRef, TableOrderSummary, TableReservationRef, TableStatusOut,
)
from app.services import audit, outlets
from app.services.billing import db_now, paid_total

OPEN_STATUSES = (OrderStatus.open, OrderStatus.sent_to_kitchen)


def _names(db: Session, ids) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict(db.execute(select(User.id, User.full_name).where(User.id.in_(ids))).all())


def shift_out(s: Shift, names: dict | None = None) -> ShiftOut:
    return ShiftOut(id=s.id, outlet_id=s.outlet_id, user_id=s.user_id, user_name=(names or {}).get(s.user_id), role=s.role,
                    opened_at=s.opened_at, open_note=s.open_note, closed_at=s.closed_at, close_reason=s.close_reason,
                    table_ids=sorted((t.table_id for t in s.tables), key=str))


def _open_shift_of(db: Session, p, outlet_id: uuid.UUID, lock: bool = False) -> Shift | None:
    q = select(Shift).where(Shift.restaurant_id == p.restaurant_id, Shift.user_id == p.user_id, Shift.outlet_id == outlet_id,
                            Shift.closed_at.is_(None))
    return db.scalar(q.with_for_update() if lock else q)


def current_shift(db: Session, p) -> Shift | None:
    return _open_shift_of(db, p, outlets.outlet_of(db, p))


def open_shift(db: Session, p, note: str | None = None, client_created_at: datetime | None = None) -> tuple[Shift, bool]:
    """Opens the caller's shift at the request's outlet. Idempotent: an already open shift is returned (created False)."""
    oid = outlets.outlet_of(db, p)
    for _ in range(3):  # a concurrent close can undo the shift that blocked our insert; never loop for ever
        existing = _open_shift_of(db, p, oid)
        if existing:
            return existing, False
        user = db.get(User, p.user_id)
        s = Shift(restaurant_id=p.restaurant_id, outlet_id=oid, user_id=p.user_id, role=p.role.value,
                  open_note=(note or "").strip() or None, opened_at=db_now(db))
        db.add(s)
        try:
            db.flush()
        except IntegrityError:  # a concurrent open (double tap, two devices): one open shift per user and outlet
            db.rollback()
            found = _open_shift_of(db, p, oid)
            if found is not None:
                return found, False
            continue  # that shift was closed again in the meantime (open/close storm): try to open ours again
        audit.record(db, p, "shift.open", "shift", s.id, {
            "outlet_id": str(oid), "user": user.full_name if user else None,
            "client_created_at": client_created_at.isoformat() if client_created_at else None})
        db.commit()
        return s, True
    exc = HTTPException(503, "The shift is being changed on another device. Try again in a moment.")
    exc.code = "shift_busy"
    raise exc


def _close(db: Session, p, s: Shift, reason: str, at: datetime | None = None) -> None:
    s.closed_at, s.closed_by, s.close_reason = at or db_now(db), p.user_id, reason
    audit.record(db, p, "shift.close", "shift", s.id,
                 {"reason": reason, "user_id": str(s.user_id), "tables": len(s.tables)})


def close_own_shift(db: Session, p) -> Shift | None:
    """Closes the caller's open shift at the request's outlet; None when there is none (nothing to do)."""
    s = _open_shift_of(db, p, outlets.outlet_of(db, p), lock=True)
    if s is None:
        return None
    _close(db, p, s, "self")
    db.commit()
    return s


def close_shift(db: Session, p, shift_id: uuid.UUID) -> Shift:
    """Manager: closes anyone's shift (of an outlet the manager can reach). Idempotent on a closed shift."""
    s = db.get(Shift, shift_id, with_for_update=True)
    if not s or s.restaurant_id != p.restaurant_id or not outlets.visible(p, s):
        raise HTTPException(404, "Shift not found")
    if s.closed_at is None:
        _close(db, p, s, "self" if s.user_id == p.user_id else "manager")
    db.commit()
    return s


def close_shifts_for_day(db: Session, p, outlet_id: uuid.UUID, at: datetime) -> int:
    """End-of-day lock policy: closing the day (Z report) ends every open shift of the outlet, in the Z transaction. Waiters
    open a new shift the next day. Does not commit."""
    shifts = db.scalars(select(Shift).where(Shift.outlet_id == outlet_id, Shift.closed_at.is_(None)).with_for_update()).all()
    for s in shifts:
        _close(db, p, s, "day_close", at)
    return len(shifts)


def list_shifts(db: Session, p, outlet_id: uuid.UUID | None, status: str | None, limit: int = 100) -> list[ShiftOut]:
    q = select(Shift).where(Shift.restaurant_id == p.restaurant_id,
                            Shift.outlet_id.in_(outlets.scope(p, outlet_id, all_by_default=False)))
    if status == "open":
        q = q.where(Shift.closed_at.is_(None))
    elif status == "closed":
        q = q.where(Shift.closed_at.is_not(None))
    rows = db.scalars(q.order_by(Shift.opened_at.desc()).limit(limit)).all()
    names = _names(db, [s.user_id for s in rows])
    return [shift_out(s, names) for s in rows]


def assign_tables(db: Session, p, shift_id: uuid.UUID, table_ids: list[uuid.UUID]) -> ShiftOut:
    """Replaces the set of tables of an OPEN shift (manager). Tables must be active tables of the shift's outlet."""
    s = db.get(Shift, shift_id, with_for_update=True)
    if not s or s.restaurant_id != p.restaurant_id or not outlets.visible(p, s):
        raise HTTPException(404, "Shift not found")
    if s.closed_at is not None:
        raise HTTPException(409, "Shift is closed")
    tables = {t.id: t for t in db.scalars(select(DiningTable).where(
        DiningTable.id.in_(table_ids), DiningTable.restaurant_id == p.restaurant_id, DiningTable.outlet_id == s.outlet_id))}
    missing = [t for t in table_ids if t not in tables]
    if missing:
        raise HTTPException(404, f"Table not found: {missing[0]}")  # another tenant's / outlet's table looks like a missing one
    inactive = [t.label for t in tables.values() if not t.is_active]
    if inactive:
        raise HTTPException(409, f"Table {inactive[0]} is no longer in use")
    have = {a.table_id: a for a in s.tables}
    for tid, a in list(have.items()):
        if tid not in tables:
            s.tables.remove(a)
    for tid in table_ids:
        if tid not in have:
            s.tables.append(TableAssignment(restaurant_id=s.restaurant_id, outlet_id=s.outlet_id, table_id=tid,
                                            user_id=s.user_id, assigned_by=p.user_id))
    added, removed = sorted(str(t) for t in set(table_ids) - set(have)), sorted(str(t) for t in set(have) - set(table_ids))
    if added or removed:
        audit.record(db, p, "shift.assign_tables", "shift", s.id, {"user_id": str(s.user_id), "added": added, "removed": removed})
    db.commit()
    db.refresh(s)
    return shift_out(s, _names(db, [s.user_id]))


# ------------------------------------------------------------------------------------------------ table status
def _summaries(db: Session, rows: list[Order], bills: dict | None = None) -> list[TableOrderSummary]:
    names = _names(db, [o.created_by for o in rows])
    from app.models.core import Kot
    from app.services.order_rules import _minutes_since
    bills = bills or {}
    kot_orders = set(db.scalars(select(Kot.order_id).where(Kot.order_id.in_([o.id for o in rows])))) if rows else set()
    out = []
    for o in rows:
        subtotal = sum((l.unit_price * l.quantity for l in o.lines), 0)
        b = bills.get(o.id)
        out.append(TableOrderSummary(
            order_id=o.id, token_number=o.token_number, status=o.status, waiter_id=o.created_by, waiter_name=names.get(o.created_by),
            opened_at=o.created_at, item_count=sum(l.quantity for l in o.lines), subtotal=subtotal,
            kot_sent=o.id in kot_orders, note=o.note, bill_requested_at=o.bill_requested_at,
            minutes_open=_minutes_since(o.created_at), total=b.total if b else subtotal,
            bill_id=b.id if b else None, invoice_number=b.invoice_number if b else None))
    return out


def table_status(db: Session, p, outlet_ids: list[uuid.UUID], only: set[uuid.UUID] | None = None) -> list[TableStatusOut]:
    """Every ACTIVE table of the outlets with its live status, derived from the open orders (open / sent_to_kitchen):
    free (none), occupied (>= 1 open order), bill_requested (an open order whose waiter asked for the bill)."""
    q = select(DiningTable).where(DiningTable.restaurant_id == p.restaurant_id, DiningTable.outlet_id.in_(outlet_ids),
                                  DiningTable.is_active)
    if only is not None:
        q = q.where(DiningTable.id.in_(only))
    tables = db.scalars(q.order_by(DiningTable.label)).all()
    ids = [t.id for t in tables]
    orders = db.scalars(select(Order).options(selectinload(Order.lines)).where(
        Order.restaurant_id == p.restaurant_id, Order.table_id.in_(ids), Order.status.in_(OPEN_STATUSES))
        .order_by(Order.created_at)).all() if ids else []
    by_table: dict[uuid.UUID, list[Order]] = {}
    for o in orders:
        by_table.setdefault(o.table_id, []).append(o)
    from app.services.order_rules import unpaid_billed_by_table  # docs/ORDER_RULES.md: a bill waiting for payment keeps the table
    billed = unpaid_billed_by_table(db, ids)
    bills = {}
    for tid, pairs in billed.items():
        for o, b in pairs:
            by_table.setdefault(tid, []).append(o)
            bills[o.id] = b
    summaries = {s.order_id: s for s in _summaries(db, orders + [o for ps in billed.values() for o, _ in ps], bills)}
    assigned: dict[uuid.UUID, list[uuid.UUID]] = {}
    if ids:
        for tid, uid in db.execute(select(TableAssignment.table_id, TableAssignment.user_id).join(
                Shift, Shift.id == TableAssignment.shift_id).where(Shift.closed_at.is_(None), TableAssignment.table_id.in_(ids))):
            assigned.setdefault(tid, []).append(uid)
    names = _names(db, [u for us in assigned.values() for u in us])
    from app.services.reservations import due_by_table  # local import: reservations imports the order service
    due = due_by_table(db, p.restaurant_id, [t.id for t in tables if t.id not in by_table])
    out = []
    for t in tables:
        os_ = [summaries[o.id] for o in by_table.get(t.id, [])]
        status = ("free" if not os_ else "bill_printed" if any(o.bill_id for o in os_)
                  else "bill_requested" if any(o.bill_requested_at for o in os_) else "occupied")
        rsv = due.get(t.id)
        if rsv is not None:
            status = "reserved"
        out.append(TableStatusOut(table_id=t.id, label=t.label, seats=t.seats, area=t.area, status=status, orders=os_,
                                  assigned_to=[StaffRef(user_id=u, name=names.get(u)) for u in assigned.get(t.id, [])],
                                  reservation=TableReservationRef(id=rsv.id, guest_name=rsv.guest_name, party_size=rsv.party_size,
                                                                  starts_at=rsv.starts_at) if rsv else None))
    return out


def my_tables(db: Session, p) -> list[TableStatusOut]:
    """Tables assigned to the caller's open shift at the request's outlet (empty without a shift or an assignment)."""
    s = current_shift(db, p)
    if s is None or not s.tables:
        return []
    return table_status(db, p, [s.outlet_id], {t.table_id for t in s.tables})


def bill_requests(db: Session, p, outlet_id: uuid.UUID | None) -> list[BillRequestOut]:
    """The counter's queue, oldest first: open orders whose bill was requested and not finalized yet (kind bill_request), and
    billed orders whose waiter asked the counter to take the payment while a balance is still due (kind payment_reminder).
    Paid / voided bills and cancelled orders are not in it."""
    rows = db.scalars(select(Order).options(selectinload(Order.lines)).where(
        Order.restaurant_id == p.restaurant_id, Order.outlet_id.in_(outlets.scope(p, outlet_id, all_by_default=False)),
        Order.bill_requested_at.is_not(None), Order.status.in_(OPEN_STATUSES + (OrderStatus.billed,))).order_by(Order.bill_requested_at)).all()
    bills = {b.order_id: b for b in db.scalars(select(Bill).options(selectinload(Bill.payments)).where(
        Bill.order_id.in_([o.id for o in rows if o.status == OrderStatus.billed]), Bill.status == "active"))} if rows else {}
    rows = [o for o in rows if o.status != OrderStatus.billed or (o.id in bills and bills[o.id].total - paid_total(bills[o.id]) > 0)]
    names = _names(db, [u for o in rows for u in (o.created_by, o.bill_requested_by)])
    tables = {t.id: t for t in db.scalars(select(DiningTable).where(DiningTable.id.in_([o.table_id for o in rows if o.table_id])))} if rows else {}
    out = []
    for o in rows:
        b, t = bills.get(o.id), tables.get(o.table_id)
        out.append(BillRequestOut(
            kind="payment_reminder" if b else "bill_request",
            order_id=o.id, table_id=o.table_id, table_label=t.label if t else None, token_number=o.token_number,
            requested_at=o.bill_requested_at, requested_by=o.bill_requested_by, requested_by_name=names.get(o.bill_requested_by),
            waiter_id=o.created_by, waiter_name=names.get(o.created_by), item_count=sum(l.quantity for l in o.lines),
            subtotal=sum((l.unit_price * l.quantity for l in o.lines), 0), note=o.note,
            bill_id=b.id if b else None, invoice_number=b.invoice_number if b else None,
            balance_due=(b.total - paid_total(b)) if b else None, table_area=t.area if (b and t) else None))
    return out
