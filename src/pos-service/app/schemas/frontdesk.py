"""Request / response shapes of reservations, attendance and the setup checklist (docs/RESERVATIONS_ATTENDANCE_SETUP_API.md)."""
import uuid
from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.common import OrderLineIn, WhatsAppOutboxOut


class _ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


def _strip(v):
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


# ------------------------------------------------------------------------------------------------ reservations
ReservationStatus = Literal["booked", "seated", "cancelled", "no_show"]


class ReservationIn(BaseModel):
    client_uuid: uuid.UUID | None = None  # idempotency key: a replay returns the first reservation (200)
    guest_name: str = Field(min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    party_size: int = Field(ge=1, le=500)
    starts_at: datetime  # with an offset; a naive value is read in the outlet's timezone
    duration_minutes: int = Field(default=90, ge=15, le=720)
    table_id: uuid.UUID | None = None
    notes: str | None = Field(default=None, max_length=500)

    _s = field_validator("guest_name", "phone", "notes", mode="before")(_strip)


class ReservationPatch(BaseModel):
    """Only the fields sent are changed; `table_id: null` un-assigns the table. Booked reservations only."""
    guest_name: str | None = Field(default=None, min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    party_size: int | None = Field(default=None, ge=1, le=500)
    starts_at: datetime | None = None
    duration_minutes: int | None = Field(default=None, ge=15, le=720)
    table_id: uuid.UUID | None = None
    notes: str | None = Field(default=None, max_length=500)

    _s = field_validator("guest_name", "phone", "notes", mode="before")(_strip)


class ReservationSeatIn(BaseModel):
    table_id: uuid.UUID | None = None  # required when the reservation has no table yet
    lines: list[OrderLineIn] | None = None  # optional first order lines; none = an empty order the waiter fills


class ReservationCancelIn(BaseModel):
    reason: str | None = Field(default=None, max_length=300)


class ReservationRemindIn(BaseModel):
    channel: Literal["whatsapp", "sms"] = "whatsapp"


class ReservationOut(_ORM):
    id: uuid.UUID
    outlet_id: uuid.UUID
    client_uuid: uuid.UUID | None = None
    guest_name: str
    phone: str | None = None
    party_size: int
    starts_at: datetime
    ends_at: datetime
    duration_minutes: int
    local_date: date  # the outlet-local day the reservation is listed under
    table_id: uuid.UUID | None = None
    table_label: str | None = None
    status: ReservationStatus
    notes: str | None = None
    order_id: uuid.UUID | None = None
    seated_at: datetime | None = None
    cancelled_at: datetime | None = None
    cancel_reason: str | None = None
    reminder_queued_at: datetime | None = None
    created_by: uuid.UUID
    created_at: datetime


class ReservationRemindOut(BaseModel):
    reservation: ReservationOut
    outbox: WhatsAppOutboxOut


class AvailabilityTable(BaseModel):
    id: uuid.UUID
    label: str
    seats: int
    area: str
    fits: bool  # seats >= party_size
    available: bool  # no overlapping booked / seated reservation, and not occupied now when the slot is now
    occupied_now: bool
    conflicts: list[uuid.UUID]  # overlapping reservation ids


class AvailabilityOut(BaseModel):
    outlet_id: uuid.UUID
    starts_at: datetime
    ends_at: datetime
    party_size: int
    available_count: int  # tables that fit and are available
    tables: list[AvailabilityTable]


# ------------------------------------------------------------------------------------------------ attendance
class GeoIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0, le=100000)


class ClockIn(BaseModel):
    client_uuid: uuid.UUID | None = None  # idempotency key of the clock-in (offline replay = 200 with the same record)
    at: datetime | None = None  # when it happened (offline devices); default now; at most 24 h old, never in the future
    device: str | None = Field(default=None, max_length=100)  # device label; default the User-Agent
    geo: GeoIn | None = None  # stored only when ATTENDANCE_GEO is on


class ClockOutIn(BaseModel):
    client_uuid: uuid.UUID | None = None  # the CLOCK-IN's client_uuid: closes exactly that record (replay = 200)
    at: datetime | None = None
    device: str | None = Field(default=None, max_length=100)
    geo: GeoIn | None = None


class AttendanceOut(_ORM):
    id: uuid.UUID
    outlet_id: uuid.UUID
    user_id: uuid.UUID
    user_name: str | None = None
    client_uuid: uuid.UUID | None = None
    work_date: date
    clock_in_at: datetime
    clock_out_at: datetime | None = None
    open: bool
    worked_minutes: int  # up to now while open
    clock_in_device: str | None = None
    clock_out_device: str | None = None
    geo: dict | None = None
    source: Literal["self", "manager"]
    edited_at: datetime | None = None
    edited_by: uuid.UUID | None = None
    edit_reason: str | None = None
    voided: bool = False


class MyAttendanceOut(BaseModel):
    open: AttendanceOut | None
    records: list[AttendanceOut]


class AttendanceCreateIn(BaseModel):
    """A manager adds a record for someone who forgot to clock in."""
    user_id: uuid.UUID
    clock_in_at: datetime
    clock_out_at: datetime | None = None
    reason: str = Field(min_length=3, max_length=300)


class AttendancePatch(BaseModel):
    clock_in_at: datetime | None = None
    clock_out_at: datetime | None = None
    reason: str = Field(min_length=3, max_length=300)


class AttendanceVoidIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


class AttendanceHistoryItem(BaseModel):
    at: datetime
    action: str
    user_id: uuid.UUID | None = None
    user_name: str | None = None
    detail: dict | None = None


class ScheduleDay(BaseModel):
    weekday: int = Field(ge=0, le=6)  # 0 = Monday
    start_time: time
    end_time: time  # earlier than start_time = ends after midnight
    grace_minutes: int = Field(default=10, ge=0, le=240)


class ScheduleIn(BaseModel):
    outlet_id: uuid.UUID | None = None  # default: the request's outlet
    days: list[ScheduleDay] = Field(max_length=7)  # replaces this user's schedule at the outlet; [] clears it


class ScheduleOut(BaseModel):
    user_id: uuid.UUID
    outlet_id: uuid.UUID
    days: list[ScheduleDay]


class CashSessionRef(BaseModel):
    id: uuid.UUID
    status: str
    opened_at: datetime
    closed_at: datetime | None = None


class AttendanceDay(BaseModel):
    date: date
    user_id: uuid.UUID
    user_name: str
    outlet_id: uuid.UUID
    status: Literal["present", "late", "absent", "pending", "off"]
    scheduled: bool
    scheduled_start: time | None = None
    scheduled_end: time | None = None
    first_in: datetime | None = None
    last_out: datetime | None = None
    worked_minutes: int
    late_minutes: int
    open: bool  # a record of this day is still open
    missing_clock_out: bool  # an open record from a past day
    records: int
    cash_sessions: list[CashSessionRef]


class AttendanceUserSummary(BaseModel):
    user_id: uuid.UUID
    user_name: str
    days_present: int  # present + late
    days_late: int
    days_absent: int
    worked_minutes: int
    late_minutes: int


class AttendanceReportOut(BaseModel):
    outlet_id: uuid.UUID
    timezone: str
    from_date: date
    to_date: date
    days: list[AttendanceDay]
    users: list[AttendanceUserSummary]


# ------------------------------------------------------------------------------------------------ setup checklist
class SetupAction(BaseModel):
    method: str
    path: str


class SetupStep(BaseModel):
    id: str
    title: str
    description: str
    status: Literal["done", "skipped", "todo"]
    done: bool  # from real data; a skipped step that later gets its data reports done
    skipped: bool
    skipped_at: datetime | None = None
    detail: dict
    actions: list[SetupAction]


class SetupStatusOut(BaseModel):
    steps: list[SetupStep]
    total: int
    done: int
    skipped: int
    remaining: int
    percent: int  # (done + skipped) / total
    complete: bool  # nothing left to do
    next_step: str | None = None


class UpiIn(BaseModel):
    upi_vpa: str | None = Field(default=None, max_length=100)  # null / "" clears it


class UpiOut(BaseModel):
    upi_vpa: str | None = None
