"""Table reservations (docs/RESERVATIONS_ATTENDANCE_SETUP_API.md).

A reservation belongs to the request's outlet. booked -> seated | cancelled | no_show (terminal). A booked or seated
reservation with a table holds that table for [starts_at, starts_at + duration_minutes): another reservation overlapping it on
the same table is a 409 (checked under a row lock on the table, so two devices cannot book the same slot at once).

Seating attaches the table's open order when there is one, else creates the order through the normal order service (its
client_uuid is derived from the reservation id, so a retried seat finds the same order). Nothing in the counter or waiter
flows changes when no reservations exist; the waiter table list shows `reserved` only for a free table with a booking due.

Reminders go through the WhatsApp outbox (services/whatsapp.py) as the English template TEMPLATE_RESERVATION, only when the
restaurant switched WhatsApp on (PUT /restaurant/communications). There is no SMS provider in pos-service: channel 'sms' is a
409 until one exists."""
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.core import DiningTable, Order, OrderStatus, OrderType, Outlet, Restaurant
from app.models.frontdesk import Reservation
from app.schemas.common import OrderIn
from app.schemas.frontdesk import AvailabilityOut, AvailabilityTable, ReservationOut
from app.services import audit, outlets as outlets_svc, whatsapp

ACTIVE = ("booked", "seated")  # statuses that hold a table
OPEN_ORDER = (OrderStatus.open, OrderStatus.sent_to_kitchen)
MAX_DURATION = timedelta(minutes=720)
TEMPLATE_RESERVATION = "pos_reservation_reminder_v1"  # {{1}} guest, {{2}} restaurant, {{3}} date and time, {{4}} party size
DEFAULT_TZ = "Asia/Kolkata"
DUE_SOON = timedelta(minutes=60)  # the waiter table list shows `reserved` this long before a booking starts


def outlet_tz(db: Session, outlet_id: uuid.UUID) -> ZoneInfo:
    name = db.scalar(select(Outlet.timezone).where(Outlet.id == outlet_id)) or DEFAULT_TZ
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 - an unknown zone name must not break bookings
        return ZoneInfo(DEFAULT_TZ)


def aware(dt: datetime, tz: ZoneInfo) -> datetime:
    """A naive datetime is outlet-local wall time; an aware one is kept (normalised to UTC)."""
    return (dt.replace(tzinfo=tz) if dt.tzinfo is None else dt).astimezone(timezone.utc)


def day_window(d: date, tz: ZoneInfo) -> tuple[datetime, datetime]:
    start = datetime(d.year, d.month, d.day, tzinfo=tz)
    return start.astimezone(timezone.utc), (start + timedelta(days=1)).astimezone(timezone.utc)


def coded(status: int, code: str, message: str, **extra) -> HTTPException:
    """An HTTPException with a stable `error.code` (app/core/errors.py) and `detail = {message, ...extra}`."""
    exc = HTTPException(status, {"message": message, **extra})
    exc.code = code
    return exc


def _now() -> datetime:
    return datetime.now(timezone.utc)


def end_of(r: Reservation) -> datetime:
    return r.starts_at + timedelta(minutes=r.duration_minutes)


def out(db: Session, r: Reservation, labels: dict | None = None) -> ReservationOut:
    tz = outlet_tz(db, r.outlet_id)
    label = None
    if r.table_id:
        label = labels.get(r.table_id) if labels is not None else db.scalar(
            select(DiningTable.label).where(DiningTable.id == r.table_id))
    return ReservationOut(
        id=r.id, outlet_id=r.outlet_id, client_uuid=r.client_uuid, guest_name=r.guest_name, phone=r.phone,
        party_size=r.party_size, starts_at=r.starts_at, ends_at=end_of(r), duration_minutes=r.duration_minutes,
        local_date=r.starts_at.astimezone(tz).date(), table_id=r.table_id, table_label=label, status=r.status, notes=r.notes,
        order_id=r.order_id, seated_at=r.seated_at, cancelled_at=r.cancelled_at, cancel_reason=r.cancel_reason,
        reminder_queued_at=r.reminder_queued_at, created_by=r.created_by, created_at=r.created_at)


def load(db: Session, p, reservation_id: uuid.UUID, lock: bool = False) -> Reservation:
    r = db.get(Reservation, reservation_id, with_for_update=lock or None)
    if r is None or r.restaurant_id != p.restaurant_id or (p.outlet_ids is not None and r.outlet_id not in p.outlet_ids):
        raise HTTPException(404, "Reservation not found")
    return r


def _table(db: Session, p, table_id: uuid.UUID, outlet_id: uuid.UUID, lock: bool = True) -> DiningTable:
    t = db.get(DiningTable, table_id, with_for_update=lock or None)
    if t is None or t.restaurant_id != p.restaurant_id or t.outlet_id != outlet_id:
        raise HTTPException(404, "Table not found")
    if not t.is_active:
        raise HTTPException(409, f"Table {t.label} is no longer in use")
    return t


def _phone(raw: str | None) -> str | None:
    if not raw:
        return None
    return whatsapp.normalize_phone(raw) or raw.strip()  # keep what was typed when it is not a mobile number


def conflicts(db: Session, restaurant_id, table_id, start: datetime, end: datetime, exclude: uuid.UUID | None = None) -> list[Reservation]:
    """Booked / seated reservations on the table overlapping [start, end)."""
    q = select(Reservation).where(
        Reservation.restaurant_id == restaurant_id, Reservation.table_id == table_id, Reservation.status.in_(ACTIVE),
        Reservation.starts_at < end, Reservation.starts_at > start - MAX_DURATION)
    if exclude is not None:
        q = q.where(Reservation.id != exclude)
    return [r for r in db.scalars(q) if end_of(r) > start]


def _check_free(db: Session, r: Reservation) -> None:
    if r.table_id is None:
        return
    hit = conflicts(db, r.restaurant_id, r.table_id, r.starts_at, end_of(r), exclude=r.id)
    if hit:
        raise coded(409, "table_already_reserved", "The table is already reserved for an overlapping time",
                    conflicts=[str(x.id) for x in hit])


def create(db: Session, p, data) -> tuple[Reservation, bool]:
    if data.client_uuid:
        dup = db.scalar(select(Reservation).where(Reservation.restaurant_id == p.restaurant_id,
                                                  Reservation.client_uuid == data.client_uuid))
        if dup:
            return dup, False
    oid = outlets_svc.outlet_of(db, p)
    tz = outlet_tz(db, oid)
    r = Reservation(restaurant_id=p.restaurant_id, outlet_id=oid, client_uuid=data.client_uuid, guest_name=data.guest_name,
                    phone=_phone(data.phone), party_size=data.party_size, starts_at=aware(data.starts_at, tz),
                    duration_minutes=data.duration_minutes, notes=data.notes, status="booked", created_by=p.user_id)
    if data.table_id:
        _table(db, p, data.table_id, oid)  # row lock: serialises bookings of this table
        r.table_id = data.table_id
    _check_free(db, r)
    db.add(r)
    try:
        db.flush()
    except IntegrityError:  # the same client_uuid raced in
        db.rollback()
        dup = db.scalar(select(Reservation).where(Reservation.restaurant_id == p.restaurant_id,
                                                  Reservation.client_uuid == data.client_uuid))
        if dup is None:
            raise
        return dup, False
    audit.record(db, p, "reservation.create", "reservation", r.id,
                 {"party_size": r.party_size, "starts_at": r.starts_at.isoformat(), "table_id": str(r.table_id) if r.table_id else None})
    db.commit()
    return r, True


def update(db: Session, p, reservation_id: uuid.UUID, data) -> Reservation:
    r = load(db, p, reservation_id, lock=True)
    if r.status != "booked":
        raise HTTPException(409, f"A {r.status.replace('_', '-')} reservation cannot be changed")
    sent = data.model_fields_set
    tz = outlet_tz(db, r.outlet_id)
    changes = {}
    for f in ("guest_name", "party_size", "duration_minutes", "notes"):
        v = getattr(data, f)
        if f in sent and (v is not None or f == "notes"):  # null clears only the notes
            setattr(r, f, v)
            changes[f] = v
    if "phone" in sent:
        r.phone = _phone(data.phone)
        changes["phone"] = r.phone
    if "starts_at" in sent and data.starts_at is not None:
        r.starts_at = aware(data.starts_at, tz)
        changes["starts_at"] = r.starts_at.isoformat()
    if "table_id" in sent:
        if data.table_id is not None:
            _table(db, p, data.table_id, r.outlet_id)
        r.table_id = data.table_id
        changes["table_id"] = str(data.table_id) if data.table_id else None
    _check_free(db, r)
    audit.record(db, p, "reservation.update", "reservation", r.id, {k: (v if isinstance(v, (int, str)) or v is None else str(v))
                                                                    for k, v in changes.items()})
    db.commit()
    return r


def _transition(db: Session, p, reservation_id: uuid.UUID, to: str, reason: str | None = None) -> Reservation:
    r = load(db, p, reservation_id, lock=True)
    if r.status == to:
        return r  # idempotent replay
    if r.status != "booked":
        raise HTTPException(409, f"A {r.status.replace('_', '-')} reservation cannot be marked {to.replace('_', '-')}")
    r.status = to
    if to == "cancelled":
        r.cancelled_at = _now()
        r.cancel_reason = reason
    audit.record(db, p, f"reservation.{to}", "reservation", r.id, {"reason": reason} if reason else None)
    db.commit()
    return r


def cancel(db: Session, p, reservation_id: uuid.UUID, reason: str | None) -> Reservation:
    return _transition(db, p, reservation_id, "cancelled", reason)


def no_show(db: Session, p, reservation_id: uuid.UUID) -> Reservation:
    return _transition(db, p, reservation_id, "no_show")


def seat_order_uuid(reservation_id: uuid.UUID) -> uuid.UUID:
    return uuid.uuid5(reservation_id, "seat")


def seat(db: Session, p, reservation_id: uuid.UUID, data) -> Reservation:
    """booked -> seated on a table: attaches the table's open order, else creates one (with `lines`, or empty for the waiter
    to fill). Idempotent: seating a seated reservation again returns it unchanged."""
    from app.core.permissions import P
    from app.models.core import OrderLine  # noqa: F401 - mapper configured by the import of models
    from app.services import orders as orders_svc

    r = load(db, p, reservation_id, lock=True)
    if r.status == "seated":
        return r
    if r.status != "booked":
        raise HTTPException(409, f"A {r.status.replace('_', '-')} reservation cannot be seated")
    table_id = data.table_id or r.table_id
    if table_id is None:
        raise HTTPException(422, "Choose a table to seat the guests at")
    if p.outlet_id is not None and r.outlet_id != p.outlet_id:
        raise HTTPException(409, "Switch to the reservation's outlet to seat it")
    _table(db, p, table_id, r.outlet_id)
    if table_id != r.table_id:
        r.table_id = table_id
        _check_free(db, r)
    order = db.scalar(select(Order).where(
        Order.restaurant_id == p.restaurant_id, Order.table_id == table_id, Order.status.in_(OPEN_ORDER),
        Order.merged_into_order_id.is_(None)).order_by(Order.created_at).limit(1))
    created = False
    if order is None:
        if not p.can(P.ORDERS_CREATE):
            raise HTTPException(403, "Insufficient permissions")
        rid, guest, party, lines = r.id, r.guest_name, r.party_size, list(data.lines or [])
        db.commit()  # release the reservation lock; create_order runs (and commits) on its own
        body = OrderIn.model_construct(client_uuid=seat_order_uuid(rid), order_type=OrderType.indoor, table_id=table_id,
                                       customer_id=None, note=f"Reservation: {guest} ({party})"[:300], lines=lines)
        order = orders_svc.create_order(db, p, body)
        created = True
        r = load(db, p, rid, lock=True)
        if r.status == "seated":  # a concurrent seat finished first
            return r
        if r.status != "booked":
            raise HTTPException(409, f"A {r.status.replace('_', '-')} reservation cannot be seated")
    r.order_id = order.id
    r.table_id = table_id
    r.status = "seated"
    r.seated_at = _now()
    audit.record(db, p, "reservation.seat", "reservation", r.id,
                 {"table_id": str(table_id), "order_id": str(order.id), "order_created": created})
    db.commit()
    return r


def listing(db: Session, p, day: date | None, status: str | None, outlet_id: uuid.UUID | None) -> list[Reservation]:
    oid = outlet_id or outlets_svc.outlet_of(db, p)
    if p.outlet_ids is not None and oid not in p.outlet_ids:
        raise HTTPException(404, "Outlet not found")
    tz = outlet_tz(db, oid)
    d = day or datetime.now(tz).date()
    lo, hi = day_window(d, tz)
    q = select(Reservation).where(Reservation.restaurant_id == p.restaurant_id, Reservation.outlet_id == oid,
                                  Reservation.starts_at >= lo, Reservation.starts_at < hi)
    if status:
        q = q.where(Reservation.status == status)
    return list(db.scalars(q.order_by(Reservation.starts_at, Reservation.created_at)))


def table_labels(db: Session, rows: list[Reservation]) -> dict:
    ids = {r.table_id for r in rows if r.table_id}
    if not ids:
        return {}
    return dict(db.execute(select(DiningTable.id, DiningTable.label).where(DiningTable.id.in_(ids))).all())


def availability(db: Session, p, starts_at: datetime, party_size: int, duration_minutes: int,
                 exclude: uuid.UUID | None = None) -> AvailabilityOut:
    oid = outlets_svc.outlet_of(db, p)
    tz = outlet_tz(db, oid)
    start = aware(starts_at, tz)
    end = start + timedelta(minutes=duration_minutes)
    tables = db.scalars(select(DiningTable).where(DiningTable.restaurant_id == p.restaurant_id, DiningTable.outlet_id == oid,
                                                  DiningTable.is_active).order_by(DiningTable.label)).all()
    ids = [t.id for t in tables]
    busy: dict[uuid.UUID, list[uuid.UUID]] = {}
    if ids:
        for r in db.scalars(select(Reservation).where(
                Reservation.restaurant_id == p.restaurant_id, Reservation.table_id.in_(ids), Reservation.status.in_(ACTIVE),
                Reservation.starts_at < end, Reservation.starts_at > start - MAX_DURATION)):
            if end_of(r) > start and r.id != exclude:
                busy.setdefault(r.table_id, []).append(r.id)
    occupied = set(db.scalars(select(Order.table_id).where(
        Order.restaurant_id == p.restaurant_id, Order.table_id.in_(ids), Order.status.in_(OPEN_ORDER)))) if ids else set()
    now = _now()
    slot_is_now = start <= now + timedelta(minutes=15) and end > now
    rows = []
    for t in tables:
        occ = t.id in occupied
        rows.append(AvailabilityTable(
            id=t.id, label=t.label, seats=t.seats, area=t.area.value if hasattr(t.area, "value") else str(t.area),
            fits=t.seats >= party_size, available=not busy.get(t.id) and not (occ and slot_is_now),
            occupied_now=occ, conflicts=busy.get(t.id, [])))
    return AvailabilityOut(outlet_id=oid, starts_at=start, ends_at=end, party_size=party_size,
                           available_count=sum(1 for x in rows if x.available and x.fits), tables=rows)


def due_by_table(db: Session, restaurant_id, table_ids: list[uuid.UUID], now: datetime | None = None) -> dict[uuid.UUID, Reservation]:
    """Booked reservations per table that start within DUE_SOON or are running now (for the waiter table list)."""
    if not table_ids:
        return {}
    now = now or _now()
    out_: dict[uuid.UUID, Reservation] = {}
    for r in db.scalars(select(Reservation).where(
            Reservation.restaurant_id == restaurant_id, Reservation.table_id.in_(table_ids), Reservation.status == "booked",
            Reservation.starts_at <= now + DUE_SOON, Reservation.starts_at > now - MAX_DURATION).order_by(Reservation.starts_at)):
        if end_of(r) > now and r.table_id not in out_:
            out_[r.table_id] = r
    return out_


def reminder_text_parts(db: Session, r: Reservation) -> list[str]:
    """English only (owner decision): {{1}} guest, {{2}} restaurant, {{3}} '31 Oct 2026, 7:30 PM', {{4}} party size."""
    tz = outlet_tz(db, r.outlet_id)
    rest = db.get(Restaurant, r.restaurant_id)
    outlet = db.get(Outlet, r.outlet_id)
    name = rest.name if outlet is None or outlet.is_default else f"{rest.name} - {outlet.name}"
    local = r.starts_at.astimezone(tz)
    when = local.strftime("%d %b %Y, %I:%M %p").lstrip("0")
    return [r.guest_name, name, when, str(r.party_size)]


def remind(db: Session, p, reservation_id: uuid.UUID, channel: str):
    r = load(db, p, reservation_id)  # first: another tenant's reservation is a 404 whatever the settings are
    if r.status != "booked":
        raise HTTPException(409, f"A {r.status.replace('_', '-')} reservation gets no reminder")
    if channel == "sms":
        raise coded(409, "sms_unavailable", "SMS is not set up on this server; use WhatsApp")
    rest = db.get(Restaurant, p.restaurant_id)
    if not rest.whatsapp_enabled:
        raise coded(409, "whatsapp_disabled", "WhatsApp messages are switched off for this restaurant")
    phone = whatsapp.normalize_phone(r.phone)
    if not phone:
        raise HTTPException(422, "The reservation needs a valid mobile number for a reminder")
    row = whatsapp.enqueue_template(
        db, p.restaurant_id, "reservation_reminder", phone, TEMPLATE_RESERVATION, "en", reminder_text_parts(db, r),
        created_by=p.user_id, dedupe_key=f"rsv:{r.id}:{int(r.starts_at.timestamp())}"[:100])
    r.reminder_outbox_id = row.id
    r.reminder_queued_at = _now()
    audit.record(db, p, "reservation.remind", "reservation", r.id, {"outbox_id": str(row.id), "channel": channel})
    db.commit()
    if row.status == "queued":
        whatsapp.submit(whatsapp.deliver, p.restaurant_id, row.id)  # after the commit; a failure only affects the outbox row
    return r, row
