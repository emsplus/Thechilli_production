"""Staff attendance (docs/RESERVATIONS_ATTENDANCE_SETUP_API.md).

Clock in / out per user at the request's outlet (device label + time; location only when ATTENDANCE_GEO is on). Both are
offline-capable: `client_uuid` makes a replay return the same record, and `at` carries the time the device recorded (at most
24 hours old, never in the future). One OPEN record per user (partial unique index).

Managers (attendance.manage) correct records with a mandatory reason: the record keeps who / when / why of the last edit, and
the before / after of every edit is in audit_logs (entity 'attendance_record'), readable per record. A manager without
settings.owner cannot correct their own records.

Late and absent come from per-weekday schedules (attendance_schedules); a user without a schedule for a day is never late or
absent that day. Days are outlet-local (the outlet's timezone; India = Asia/Kolkata). The report links each day to the user's
cash sessions (docs/CASH_SESSIONS.md) at that outlet by reading them; cash sessions themselves are unchanged."""
import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.permissions import P
from app.models.core import AuditLog, CashSession, User
from app.models.frontdesk import AttendanceRecord, AttendanceSchedule
from app.schemas.frontdesk import (
    AttendanceDay, AttendanceHistoryItem, AttendanceOut, AttendanceReportOut, AttendanceUserSummary, CashSessionRef, ScheduleDay,
    ScheduleOut,
)
from app.services import audit, outlets as outlets_svc
from app.services.reservations import aware, coded, outlet_tz

MAX_BACKDATE = timedelta(hours=24)
SKEW = timedelta(minutes=2)
MAX_REPORT_DAYS = 62
ENTITY = "attendance_record"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _minutes(a: datetime, b: datetime) -> int:
    return max(0, int((b - a).total_seconds() // 60))


def out(r: AttendanceRecord, name: str | None = None, now: datetime | None = None) -> AttendanceOut:
    now = now or _now()
    end = r.clock_out_at or now
    return AttendanceOut(
        id=r.id, outlet_id=r.outlet_id, user_id=r.user_id, user_name=name, client_uuid=r.client_uuid, work_date=r.work_date,
        clock_in_at=r.clock_in_at, clock_out_at=r.clock_out_at, open=r.clock_out_at is None and r.voided_at is None,
        worked_minutes=0 if r.voided_at else _minutes(r.clock_in_at, end), clock_in_device=r.clock_in_device,
        clock_out_device=r.clock_out_device, geo=r.geo, source=r.source, edited_at=r.edited_at, edited_by=r.edited_by,
        edit_reason=r.edit_reason, voided=r.voided_at is not None)


def names(db: Session, ids) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict(db.execute(select(User.id, User.full_name).where(User.id.in_(ids))).all())


def out_many(db: Session, rows) -> list[AttendanceOut]:
    nm = names(db, [r.user_id for r in rows])
    now = _now()
    return [out(r, nm.get(r.user_id), now) for r in rows]


def _when(at: datetime | None, tz: ZoneInfo) -> datetime:
    now = _now()
    if at is None:
        return now
    t = aware(at, tz)
    if t > now + SKEW:
        raise HTTPException(422, "The time is in the future")
    if t < now - MAX_BACKDATE:
        raise HTTPException(422, "The time is more than 24 hours ago; ask a manager to add the record")
    return t


def _geo(prev: dict | None, key: str, g) -> dict | None:
    if g is None or not settings.attendance_geo:
        return prev
    return {**(prev or {}), key: g.model_dump(exclude_none=True)}


def _device(label: str | None, user_agent: str | None) -> str | None:
    v = (label or user_agent or "").strip()
    return v[:100] or None


def open_record(db: Session, restaurant_id, user_id) -> AttendanceRecord | None:
    return db.scalar(select(AttendanceRecord).where(
        AttendanceRecord.restaurant_id == restaurant_id, AttendanceRecord.user_id == user_id,
        AttendanceRecord.clock_out_at.is_(None), AttendanceRecord.voided_at.is_(None)))


def clock_in(db: Session, p, data, user_agent: str | None) -> tuple[AttendanceRecord, bool]:
    if data.client_uuid:
        dup = db.scalar(select(AttendanceRecord).where(AttendanceRecord.restaurant_id == p.restaurant_id,
                                                       AttendanceRecord.client_uuid == data.client_uuid))
        if dup:
            if dup.user_id != p.user_id:
                raise HTTPException(409, "This idempotency key was used by someone else")
            return dup, False
    oid = outlets_svc.outlet_of(db, p)
    tz = outlet_tz(db, oid)
    at = _when(data.at, tz)
    cur = open_record(db, p.restaurant_id, p.user_id)
    if cur:
        raise coded(409, "already_clocked_in", "You are already clocked in; clock out first", record_id=str(cur.id))
    r = AttendanceRecord(restaurant_id=p.restaurant_id, outlet_id=oid, user_id=p.user_id, client_uuid=data.client_uuid,
                         work_date=at.astimezone(tz).date(), clock_in_at=at, clock_in_device=_device(data.device, user_agent),
                         geo=_geo(None, "in", data.geo), source="self", created_by=p.user_id)
    db.add(r)
    try:
        db.flush()
    except IntegrityError:  # a concurrent clock-in (open-record index) or the same client_uuid
        db.rollback()
        if data.client_uuid:
            dup = db.scalar(select(AttendanceRecord).where(AttendanceRecord.restaurant_id == p.restaurant_id,
                                                           AttendanceRecord.client_uuid == data.client_uuid))
            if dup and dup.user_id == p.user_id:
                return dup, False
        raise coded(409, "already_clocked_in", "You are already clocked in; clock out first")
    audit.record(db, p, "attendance.clock_in", ENTITY, r.id, {"at": at.isoformat(), "outlet_id": str(oid)})
    db.commit()
    return r, True


def clock_out(db: Session, p, data, user_agent: str | None) -> AttendanceRecord:
    if data.client_uuid:
        r = db.scalar(select(AttendanceRecord).where(
            AttendanceRecord.restaurant_id == p.restaurant_id, AttendanceRecord.client_uuid == data.client_uuid,
            AttendanceRecord.user_id == p.user_id).with_for_update())
        if r is None:
            raise HTTPException(404, "Attendance record not found")
        if r.clock_out_at is not None or r.voided_at is not None:
            return r  # replay
    else:
        r = db.scalar(select(AttendanceRecord).where(
            AttendanceRecord.restaurant_id == p.restaurant_id, AttendanceRecord.user_id == p.user_id,
            AttendanceRecord.clock_out_at.is_(None), AttendanceRecord.voided_at.is_(None)).with_for_update())
        if r is None:
            raise coded(409, "not_clocked_in", "You are not clocked in")
    at = _when(data.at, outlet_tz(db, r.outlet_id))
    if at < r.clock_in_at:
        raise HTTPException(422, "Clock-out cannot be before clock-in")
    r.clock_out_at = at
    r.clock_out_device = _device(data.device, user_agent)
    r.geo = _geo(r.geo, "out", data.geo)
    audit.record(db, p, "attendance.clock_out", ENTITY, r.id, {"at": at.isoformat()})
    db.commit()
    return r


def _range(from_date: date | None, to_date: date | None, tz: ZoneInfo, default_days: int) -> tuple[date, date]:
    today = datetime.now(tz).date()
    to_date = to_date or today
    from_date = from_date or (to_date - timedelta(days=default_days - 1))
    if to_date < from_date:
        raise HTTPException(422, "to_date is before from_date")
    if (to_date - from_date).days + 1 > MAX_REPORT_DAYS:
        raise HTTPException(422, f"At most {MAX_REPORT_DAYS} days at a time")
    return from_date, to_date


def mine(db: Session, p, from_date: date | None, to_date: date | None):
    tz = outlet_tz(db, outlets_svc.outlet_of(db, p))
    lo, hi = _range(from_date, to_date, tz, 14)
    rows = db.scalars(select(AttendanceRecord).where(
        AttendanceRecord.restaurant_id == p.restaurant_id, AttendanceRecord.user_id == p.user_id,
        AttendanceRecord.work_date >= lo, AttendanceRecord.work_date <= hi, AttendanceRecord.voided_at.is_(None))
        .order_by(AttendanceRecord.clock_in_at.desc())).all()
    cur = open_record(db, p.restaurant_id, p.user_id)
    return (out_many(db, [cur])[0] if cur else None), out_many(db, rows)


def current(db: Session, p, outlet_id: uuid.UUID | None):
    ids = outlets_svc.scope(p, outlet_id, all_by_default=False)
    rows = db.scalars(select(AttendanceRecord).where(
        AttendanceRecord.restaurant_id == p.restaurant_id, AttendanceRecord.outlet_id.in_(ids),
        AttendanceRecord.clock_out_at.is_(None), AttendanceRecord.voided_at.is_(None))
        .order_by(AttendanceRecord.clock_in_at)).all()
    return out_many(db, rows)


def records(db: Session, p, from_date, to_date, user_id, outlet_id, include_voided: bool):
    ids = outlets_svc.scope(p, outlet_id, all_by_default=False)
    tz = outlet_tz(db, ids[0])
    lo, hi = _range(from_date, to_date, tz, 7)
    q = select(AttendanceRecord).where(AttendanceRecord.restaurant_id == p.restaurant_id, AttendanceRecord.outlet_id.in_(ids),
                                       AttendanceRecord.work_date >= lo, AttendanceRecord.work_date <= hi)
    if user_id:
        q = q.where(AttendanceRecord.user_id == user_id)
    if not include_voided:
        q = q.where(AttendanceRecord.voided_at.is_(None))
    return out_many(db, db.scalars(q.order_by(AttendanceRecord.clock_in_at.desc())).all())


def _user(db: Session, p, user_id: uuid.UUID) -> User:
    u = db.get(User, user_id)
    if u is None or u.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "User not found")
    return u


def _load(db: Session, p, record_id: uuid.UUID, lock: bool = False) -> AttendanceRecord:
    r = db.get(AttendanceRecord, record_id, with_for_update=lock or None)
    if r is None or r.restaurant_id != p.restaurant_id or not outlets_svc.visible(p, r):
        raise HTTPException(404, "Attendance record not found")
    return r


def _not_self(p, user_id) -> None:
    if user_id == p.user_id and not p.can(P.SETTINGS_OWNER):
        raise HTTPException(403, "Ask the owner to correct your own attendance")


def _check_overlap(db: Session, r: AttendanceRecord) -> None:
    now = _now()
    end = r.clock_out_at or now
    for o in db.scalars(select(AttendanceRecord).where(
            AttendanceRecord.restaurant_id == r.restaurant_id, AttendanceRecord.user_id == r.user_id,
            AttendanceRecord.voided_at.is_(None), AttendanceRecord.id != r.id,
            AttendanceRecord.clock_in_at < end)):
        if (o.clock_out_at or now) > r.clock_in_at:
            raise coded(409, "attendance_overlap", "This overlaps another attendance record of the same person",
                        record_id=str(o.id))


def _snap(r: AttendanceRecord) -> dict:
    return {"clock_in_at": r.clock_in_at.isoformat(), "clock_out_at": r.clock_out_at.isoformat() if r.clock_out_at else None}


def manager_create(db: Session, p, data) -> AttendanceRecord:
    u = _user(db, p, data.user_id)
    _not_self(p, u.id)
    oid = outlets_svc.outlet_of(db, p)
    tz = outlet_tz(db, oid)
    cin = aware(data.clock_in_at, tz)
    cout = aware(data.clock_out_at, tz) if data.clock_out_at else None
    now = _now()
    if cin > now + SKEW or (cout and cout > now + SKEW):
        raise HTTPException(422, "The time is in the future")
    if cout and cout < cin:
        raise HTTPException(422, "Clock-out cannot be before clock-in")
    r = AttendanceRecord(restaurant_id=p.restaurant_id, outlet_id=oid, user_id=u.id, work_date=cin.astimezone(tz).date(),
                         clock_in_at=cin, clock_out_at=cout, source="manager", created_by=p.user_id,
                         edited_at=now, edited_by=p.user_id, edit_reason=data.reason)
    _check_overlap(db, r)
    db.add(r)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise coded(409, "already_clocked_in", "This person already has an open record; close it first")
    audit.record(db, p, "attendance.create", ENTITY, r.id, {"user_id": str(u.id), "reason": data.reason, "after": _snap(r)})
    db.commit()
    return r


def edit(db: Session, p, record_id: uuid.UUID, data) -> AttendanceRecord:
    r = _load(db, p, record_id, lock=True)
    if r.voided_at:
        raise HTTPException(409, "A voided record cannot be changed")
    _not_self(p, r.user_id)
    sent = data.model_fields_set
    if not ({"clock_in_at", "clock_out_at"} & sent):
        raise HTTPException(422, "Send clock_in_at and / or clock_out_at")
    tz = outlet_tz(db, r.outlet_id)
    before = _snap(r)
    if "clock_in_at" in sent:
        if data.clock_in_at is None:
            raise HTTPException(422, "clock_in_at cannot be removed")
        r.clock_in_at = aware(data.clock_in_at, tz)
        r.work_date = r.clock_in_at.astimezone(tz).date()
    if "clock_out_at" in sent:
        r.clock_out_at = aware(data.clock_out_at, tz) if data.clock_out_at else None
    now = _now()
    if r.clock_in_at > now + SKEW or (r.clock_out_at and r.clock_out_at > now + SKEW):
        raise HTTPException(422, "The time is in the future")
    if r.clock_out_at and r.clock_out_at < r.clock_in_at:
        raise HTTPException(422, "Clock-out cannot be before clock-in")
    _check_overlap(db, r)
    r.edited_at, r.edited_by, r.edit_reason = now, p.user_id, data.reason
    audit.record(db, p, "attendance.edit", ENTITY, r.id, {"user_id": str(r.user_id), "reason": data.reason,
                                                         "before": before, "after": _snap(r)})
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise coded(409, "already_clocked_in", "This person already has an open record")
    return r


def void(db: Session, p, record_id: uuid.UUID, reason: str) -> AttendanceRecord:
    r = _load(db, p, record_id, lock=True)
    if r.voided_at:
        return r
    _not_self(p, r.user_id)
    now = _now()
    r.voided_at = now
    r.edited_at, r.edited_by, r.edit_reason = now, p.user_id, reason
    audit.record(db, p, "attendance.void", ENTITY, r.id, {"user_id": str(r.user_id), "reason": reason, "before": _snap(r)})
    db.commit()
    return r


def history(db: Session, p, record_id: uuid.UUID) -> list[AttendanceHistoryItem]:
    r = _load(db, p, record_id)
    rows = db.execute(select(AuditLog, User.full_name).join(User, User.id == AuditLog.user_id, isouter=True).where(
        AuditLog.restaurant_id == p.restaurant_id, AuditLog.entity == ENTITY, AuditLog.entity_id == str(r.id))
        .order_by(AuditLog.created_at, AuditLog.id)).all()
    return [AttendanceHistoryItem(at=a.created_at, action=a.action, user_id=a.user_id, user_name=n, detail=a.detail) for a, n in rows]


# ------------------------------------------------------------------------------------------------ schedules
def _schedule_out(user_id, outlet_id, rows) -> ScheduleOut:
    return ScheduleOut(user_id=user_id, outlet_id=outlet_id, days=[
        ScheduleDay(weekday=s.weekday, start_time=s.start_time, end_time=s.end_time, grace_minutes=s.grace_minutes)
        for s in sorted(rows, key=lambda s: s.weekday)])


def get_schedule(db: Session, p, user_id: uuid.UUID, outlet_id: uuid.UUID | None) -> ScheduleOut:
    _user(db, p, user_id)
    oid = outlets_svc.scope(p, outlet_id, all_by_default=False)[0]
    rows = db.scalars(select(AttendanceSchedule).where(AttendanceSchedule.restaurant_id == p.restaurant_id,
                                                       AttendanceSchedule.user_id == user_id, AttendanceSchedule.outlet_id == oid)).all()
    return _schedule_out(user_id, oid, rows)


def list_schedules(db: Session, p, outlet_id: uuid.UUID | None) -> list[ScheduleOut]:
    oid = outlets_svc.scope(p, outlet_id, all_by_default=False)[0]
    by_user: dict[uuid.UUID, list] = {}
    for s in db.scalars(select(AttendanceSchedule).where(AttendanceSchedule.restaurant_id == p.restaurant_id,
                                                         AttendanceSchedule.outlet_id == oid)):
        by_user.setdefault(s.user_id, []).append(s)
    return [_schedule_out(u, oid, rows) for u, rows in by_user.items()]


def put_schedule(db: Session, p, user_id: uuid.UUID, data) -> ScheduleOut:
    _user(db, p, user_id)
    oid = outlets_svc.scope(p, data.outlet_id, all_by_default=False)[0]
    days = [d.weekday for d in data.days]
    if len(days) != len(set(days)):
        raise HTTPException(422, "Each weekday at most once")
    for d in data.days:
        if d.start_time == d.end_time:
            raise HTTPException(422, "A shift cannot start and end at the same time")
    existing = db.scalars(select(AttendanceSchedule).where(
        AttendanceSchedule.restaurant_id == p.restaurant_id, AttendanceSchedule.user_id == user_id,
        AttendanceSchedule.outlet_id == oid).with_for_update()).all()
    before = [{"weekday": s.weekday, "start": s.start_time.isoformat(), "end": s.end_time.isoformat()} for s in existing]
    for s in existing:
        db.delete(s)
    db.flush()
    for d in data.days:
        db.add(AttendanceSchedule(restaurant_id=p.restaurant_id, outlet_id=oid, user_id=user_id, weekday=d.weekday,
                                  start_time=d.start_time, end_time=d.end_time, grace_minutes=d.grace_minutes))
    audit.record(db, p, "attendance.schedule", "user", user_id, {"outlet_id": str(oid), "before": before, "after": [
        {"weekday": d.weekday, "start": d.start_time.isoformat(), "end": d.end_time.isoformat()} for d in data.days]})
    db.commit()
    return get_schedule(db, p, user_id, oid)


# ------------------------------------------------------------------------------------------------ report
def _at(d: date, t: time, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, t, tzinfo=tz)


def report(db: Session, p, from_date: date | None, to_date: date | None, outlet_id: uuid.UUID | None,
           user_id: uuid.UUID | None) -> AttendanceReportOut:
    oid = outlets_svc.scope(p, outlet_id, all_by_default=False)[0]
    tz = outlet_tz(db, oid)
    lo, hi = _range(from_date, to_date, tz, 7)
    now = _now()
    today = now.astimezone(tz).date()

    sq = select(AttendanceSchedule).where(AttendanceSchedule.restaurant_id == p.restaurant_id, AttendanceSchedule.outlet_id == oid)
    rq = select(AttendanceRecord).where(AttendanceRecord.restaurant_id == p.restaurant_id, AttendanceRecord.outlet_id == oid,
                                        AttendanceRecord.work_date >= lo, AttendanceRecord.work_date <= hi,
                                        AttendanceRecord.voided_at.is_(None))
    lo_utc = _at(lo, time(0), tz).astimezone(timezone.utc)
    hi_utc = _at(hi + timedelta(days=1), time(0), tz).astimezone(timezone.utc)
    cq = select(CashSession).where(CashSession.restaurant_id == p.restaurant_id, CashSession.outlet_id == oid,
                                   CashSession.opened_at >= lo_utc, CashSession.opened_at < hi_utc)
    if user_id:
        sq, rq, cq = sq.where(AttendanceSchedule.user_id == user_id), rq.where(AttendanceRecord.user_id == user_id), \
            cq.where(CashSession.cashier_id == user_id)
    sched = {(s.user_id, s.weekday): s for s in db.scalars(sq)}
    recs: dict[tuple, list[AttendanceRecord]] = {}
    for r in db.scalars(rq.order_by(AttendanceRecord.clock_in_at)):
        recs.setdefault((r.user_id, r.work_date), []).append(r)
    cash: dict[tuple, list[CashSessionRef]] = {}
    for c in db.scalars(cq.order_by(CashSession.opened_at)):
        cash.setdefault((c.cashier_id, c.opened_at.astimezone(tz).date()), []).append(
            CashSessionRef(id=c.id, status=c.status, opened_at=c.opened_at, closed_at=c.closed_at))
    users = {u for u, _ in sched} | {u for u, _ in recs}
    nm = names(db, users)
    days: list[AttendanceDay] = []
    summary: dict[uuid.UUID, dict] = {}
    for u in sorted(users, key=lambda x: (nm.get(x) or "", str(x))):
        s_ = summary.setdefault(u, {"days_present": 0, "days_late": 0, "days_absent": 0, "worked_minutes": 0, "late_minutes": 0})
        d = lo
        while d <= hi:
            s = sched.get((u, d.weekday()))
            rows = recs.get((u, d), [])
            worked = late = 0
            first_in = last_out = None
            is_open = missing = False
            if rows:
                first_in = rows[0].clock_in_at
                outs = [r.clock_out_at for r in rows if r.clock_out_at]
                last_out = max(outs) if outs else None
                for r in rows:
                    if r.clock_out_at:
                        worked += _minutes(r.clock_in_at, r.clock_out_at)
                    elif d >= today:
                        worked += _minutes(r.clock_in_at, now)
                        is_open = True
                    else:
                        missing = True
                if s:
                    start = _at(d, s.start_time, tz)
                    mins = _minutes(start, first_in)
                    late = mins if mins > s.grace_minutes else 0
                status = "late" if late else "present"
            elif s:
                end = _at(d, s.end_time, tz)
                if s.end_time <= s.start_time:
                    end += timedelta(days=1)
                status = "absent" if now >= end else "pending"
            else:
                status = "off"
            if rows or s:
                days.append(AttendanceDay(
                    date=d, user_id=u, user_name=nm.get(u) or "", outlet_id=oid, status=status, scheduled=s is not None,
                    scheduled_start=s.start_time if s else None, scheduled_end=s.end_time if s else None, first_in=first_in,
                    last_out=last_out, worked_minutes=worked, late_minutes=late, open=is_open, missing_clock_out=missing,
                    records=len(rows), cash_sessions=cash.get((u, d), [])))
            s_["worked_minutes"] += worked
            s_["late_minutes"] += late
            s_["days_present"] += status in ("present", "late")
            s_["days_late"] += status == "late"
            s_["days_absent"] += status == "absent"
            d += timedelta(days=1)
    return AttendanceReportOut(
        outlet_id=oid, timezone=str(tz.key), from_date=lo, to_date=hi, days=days,
        users=[AttendanceUserSummary(user_id=u, user_name=nm.get(u) or "", **v) for u, v in summary.items()])


CSV_HEADERS = ["date", "staff", "status", "scheduled_start", "scheduled_end", "first_in", "last_out", "hours_worked",
               "late_minutes", "open", "missing_clock_out", "records", "cash_sessions"]


def report_csv(rep: AttendanceReportOut) -> bytes:
    from decimal import Decimal

    from app.services.report_csv import to_csv
    tz = ZoneInfo(rep.timezone)

    def hm(v):
        return v.astimezone(tz).strftime("%Y-%m-%d %H:%M") if v else None

    rows = [[d.date, d.user_name, d.status, d.scheduled_start.strftime("%H:%M") if d.scheduled_start else None,
             d.scheduled_end.strftime("%H:%M") if d.scheduled_end else None, hm(d.first_in), hm(d.last_out),
             (Decimal(d.worked_minutes) / 60).quantize(Decimal("0.01")), d.late_minutes, d.open, d.missing_clock_out, d.records,
             len(d.cash_sessions)] for d in rep.days]
    return to_csv(CSV_HEADERS, rows)
