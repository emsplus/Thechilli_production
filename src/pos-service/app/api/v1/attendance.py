"""Staff attendance (docs/RESERVATIONS_ATTENDANCE_SETUP_API.md). Clocking needs attendance.clock (every system role);
everything about other people needs attendance.manage (owner, manager)."""
import uuid
from datetime import date

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core.db import get_db
from app.schemas.frontdesk import (
    AttendanceCreateIn, AttendanceHistoryItem, AttendanceOut, AttendancePatch, AttendanceReportOut, AttendanceVoidIn, ClockIn,
    ClockOutIn, MyAttendanceOut, ScheduleIn, ScheduleOut,
)
from app.services import attendance as svc

router = APIRouter(tags=["attendance"])
CLOCK = require_perm(P.ATTENDANCE_CLOCK)
MANAGE = require_perm(P.ATTENDANCE_MANAGE)


def _one(db: Session, r) -> AttendanceOut:
    return svc.out_many(db, [r])[0]


@router.post("/attendance/clock-in", response_model=AttendanceOut, status_code=201)
def clock_in(data: ClockIn, request: Request, response: Response, p: Principal = Depends(CLOCK), db: Session = Depends(get_db)):
    """Clock the caller in at the request's outlet. 409 already_clocked_in (detail.record_id); 200 on a client_uuid replay."""
    r, created = svc.clock_in(db, p, data, request.headers.get("user-agent"))
    if not created:
        response.status_code = 200
    return _one(db, r)


@router.post("/attendance/clock-out", response_model=AttendanceOut)
def clock_out(data: ClockOutIn, request: Request, p: Principal = Depends(CLOCK), db: Session = Depends(get_db)):
    """Close the caller's open record (or exactly the record of `client_uuid`; a replay returns it). 409 not_clocked_in."""
    return _one(db, svc.clock_out(db, p, data, request.headers.get("user-agent")))


@router.get("/attendance/me", response_model=MyAttendanceOut)
def my_attendance(from_date: date | None = None, to_date: date | None = None, p: Principal = Depends(CLOCK),
                  db: Session = Depends(get_db)):
    """The caller's open record and own records (default the last 14 days)."""
    cur, rows = svc.mine(db, p, from_date, to_date)
    return MyAttendanceOut(open=cur, records=rows)


@router.get("/attendance/current", response_model=list[AttendanceOut])
def clocked_in_now(outlet_id: uuid.UUID | None = None, p: Principal = Depends(MANAGE), db: Session = Depends(get_db)):
    """Who is clocked in right now at the outlet."""
    return svc.current(db, p, outlet_id)


@router.get("/attendance/records", response_model=list[AttendanceOut])
def list_records(from_date: date | None = None, to_date: date | None = None, user_id: uuid.UUID | None = None,
                 outlet_id: uuid.UUID | None = None, include_voided: bool = False, p: Principal = Depends(MANAGE),
                 db: Session = Depends(get_db)):
    """Records of the outlet by outlet-local work date (default the last 7 days, at most 62)."""
    return svc.records(db, p, from_date, to_date, user_id, outlet_id, include_voided)


@router.post("/attendance/records", response_model=AttendanceOut, status_code=201)
def add_record(data: AttendanceCreateIn, p: Principal = Depends(MANAGE), db: Session = Depends(get_db)):
    """Add a record for someone who forgot to clock in (reason required, audited). 409 attendance_overlap."""
    return _one(db, svc.manager_create(db, p, data))


@router.patch("/attendance/records/{record_id}", response_model=AttendanceOut)
def edit_record(record_id: uuid.UUID, data: AttendancePatch, p: Principal = Depends(MANAGE), db: Session = Depends(get_db)):
    """Correct clock-in / clock-out (reason required; before / after go to the audit log). `clock_out_at: null` re-opens."""
    return _one(db, svc.edit(db, p, record_id, data))


@router.post("/attendance/records/{record_id}/void", response_model=AttendanceOut)
def void_record(record_id: uuid.UUID, data: AttendanceVoidIn, p: Principal = Depends(MANAGE), db: Session = Depends(get_db)):
    """Void a wrong record (kept for the audit trail, left out of reports). Idempotent."""
    return _one(db, svc.void(db, p, record_id, data.reason))


@router.get("/attendance/records/{record_id}/history", response_model=list[AttendanceHistoryItem])
def record_history(record_id: uuid.UUID, p: Principal = Depends(MANAGE), db: Session = Depends(get_db)):
    """Clock-in, clock-out, every correction (with reason, before and after) and the void of one record, oldest first."""
    return svc.history(db, p, record_id)


@router.get("/attendance/schedules", response_model=list[ScheduleOut])
def list_schedules(outlet_id: uuid.UUID | None = None, p: Principal = Depends(MANAGE), db: Session = Depends(get_db)):
    return svc.list_schedules(db, p, outlet_id)


@router.get("/attendance/schedules/{user_id}", response_model=ScheduleOut)
def get_schedule(user_id: uuid.UUID, outlet_id: uuid.UUID | None = None, p: Principal = Depends(MANAGE),
                 db: Session = Depends(get_db)):
    return svc.get_schedule(db, p, user_id, outlet_id)


@router.put("/attendance/schedules/{user_id}", response_model=ScheduleOut)
def put_schedule(user_id: uuid.UUID, data: ScheduleIn, p: Principal = Depends(MANAGE), db: Session = Depends(get_db)):
    """Replace the user's weekly schedule at the outlet ([] clears it). Late / absent in the report come from it."""
    return svc.put_schedule(db, p, user_id, data)


@router.get("/attendance/report", response_model=AttendanceReportOut)
def attendance_report(from_date: date | None = None, to_date: date | None = None, outlet_id: uuid.UUID | None = None,
                      user_id: uuid.UUID | None = None, p: Principal = Depends(MANAGE), db: Session = Depends(get_db)):
    """Daily rows (present / late / absent / pending / off, hours, late minutes, linked cash sessions) and per-user totals.
    Default the last 7 days (a week); at most 62 days."""
    return svc.report(db, p, from_date, to_date, outlet_id, user_id)


@router.get("/attendance/report.csv")
def attendance_report_csv(from_date: date | None = None, to_date: date | None = None, outlet_id: uuid.UUID | None = None,
                          user_id: uuid.UUID | None = None, p: Principal = Depends(MANAGE), db: Session = Depends(get_db)):
    rep = svc.report(db, p, from_date, to_date, outlet_id, user_id)
    return Response(svc.report_csv(rep), media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="attendance_{rep.from_date}_{rep.to_date}.csv"'})
