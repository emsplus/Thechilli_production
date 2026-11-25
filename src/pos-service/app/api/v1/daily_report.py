"""End of day report email settings, opt-in, history and 'send now' (docs/EMAIL.md). Manage > Restaurant > Daily report email."""
import re
import uuid
import datetime as dt
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core.db import get_db
from app.models.core import Restaurant, User
from app.models.mail import DailyReportEmail
from app.services import audit, daily_report, mail

router = APIRouter(prefix="/restaurant/daily-report", tags=["daily report email"])
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class DailyReportSettingsIn(BaseModel):
    """Omitted fields stay unchanged."""
    daily_report_email: bool | None = None  # the switch (default on)
    daily_report_time: str | None = Field(default=None, description="HH:MM, each outlet's local time (default 23:00)")
    daily_report_on_close: bool | None = None  # also send when a Z report is closed (default on)

    @field_validator("daily_report_time")
    @classmethod
    def _hhmm(cls, v):
        if v is not None and not _HHMM.match(v):
            raise ValueError("daily_report_time must be HH:MM (24 h)")
        return v


class DailyReportSettingsOut(BaseModel):
    daily_report_email: bool
    daily_report_time: str
    daily_report_on_close: bool
    email_available: bool  # mail is set up on this server
    subscribed: bool  # the caller gets the email (owners always; others when opted in)
    recipients: list[str]  # who gets it now (owners + opted-in users)


class SubscriptionIn(BaseModel):
    subscribed: bool


class SendNowIn(BaseModel):
    outlet_id: uuid.UUID | None = None  # default: the request's outlet
    date: dt.date | None = None  # default: today in the outlet's time zone
    resend: bool = False  # send again even if this day was already sent


class DailyReportEmailOut(BaseModel):
    id: uuid.UUID
    outlet_id: uuid.UUID
    business_date: date
    trigger: str
    status: str
    attempts: int
    recipients: int
    error: str | None = None
    sent_at: datetime | None = None
    created_at: datetime
    model_config = {"from_attributes": True}


def _out(db: Session, p: Principal) -> DailyReportSettingsOut:
    r = db.get(Restaurant, p.restaurant_id)
    u = db.get(User, p.user_id) if not getattr(p, "support", None) else None
    rec = daily_report.recipients(db, p.restaurant_id)
    return DailyReportSettingsOut(
        daily_report_email=r.daily_report_email, daily_report_time=r.daily_report_time,
        daily_report_on_close=r.daily_report_on_close, email_available=mail.get_provider() is not None,
        subscribed=bool(u and u.email and u.email.lower() in {e.lower() for e, _ in rec}), recipients=[e for e, _ in rec])


@router.get("", response_model=DailyReportSettingsOut)
def get_settings(p: Principal = Depends(require_perm(P.REPORTS_VIEW)), db: Session = Depends(get_db)):
    return _out(db, p)


@router.put("", response_model=DailyReportSettingsOut)
def put_settings(data: DailyReportSettingsIn, p: Principal = Depends(require_perm(P.SETTINGS_OWNER)),
                 db: Session = Depends(get_db)):
    """Owner only. The switch, the local send time and whether a Z close also sends it."""
    r = db.get(Restaurant, p.restaurant_id)
    changes = data.model_dump(exclude_none=True)
    for k, v in changes.items():
        setattr(r, k, v)
    if changes:
        audit.record(db, p, "restaurant.daily_report", "restaurant", r.id, changes)
    db.commit()
    return _out(db, p)


@router.put("/subscription", response_model=DailyReportSettingsOut)
def put_subscription(data: SubscriptionIn, p: Principal = Depends(require_perm(P.REPORTS_VIEW)), db: Session = Depends(get_db)):
    """The caller opts in / out (managers and other report viewers). Owners always receive it while the switch is on."""
    if getattr(p, "support", None):
        raise HTTPException(403, "Support sessions are read-only")
    u = db.get(User, p.user_id)
    u.daily_report_opt_in = data.subscribed
    audit.record(db, p, "user.daily_report_opt_in", "user", u.id, {"subscribed": data.subscribed})
    db.commit()
    return _out(db, p)


@router.get("/history", response_model=list[DailyReportEmailOut])
def history(limit: int = Query(30, ge=1, le=200), p: Principal = Depends(require_perm(P.REPORTS_VIEW)),
            db: Session = Depends(get_db)):
    return db.scalars(select(DailyReportEmail).where(DailyReportEmail.restaurant_id == p.restaurant_id)
                      .order_by(DailyReportEmail.business_date.desc(), DailyReportEmail.created_at.desc()).limit(limit)).all()


@router.post("/send", response_model=DailyReportEmailOut)
def send_now(data: SendNowIn, p: Principal = Depends(require_perm(P.SETTINGS_OWNER)), db: Session = Depends(get_db)):
    """Owner only. Sends the report of one outlet and day now (idempotent per outlet and day unless resend=true)."""
    row = daily_report.send_now(db, p, data.outlet_id, data.date, data.resend)
    audit.record(db, p, "daily_report.send", "daily_report_email", row.id, {"status": row.status})
    db.commit()
    return row
