"""Table reservations, staff attendance and the first-run setup checklist (docs/RESERVATIONS_ATTENDANCE_SETUP_API.md).

All four tables are tenant tables with their own restaurant_id (RLS: app/core/rls.py LATER_DIRECT_TABLES, revision
e2b7c9d4f6a1). The outlet-scoped ones get the composite FK (outlet_id, restaurant_id) -> outlets like core.OUTLET_TABLES.
Nothing here is read by the counter / waiter flows unless a reservation or an attendance record actually exists."""
import uuid
from datetime import date, datetime, time

from sqlalchemy import (
    CheckConstraint, Date, DateTime, ForeignKeyConstraint, Index, Integer, SmallInteger, String, Time, UniqueConstraint, func,
    text as text_,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import fk, outlet_col, uuid_pk

RESERVATION_STATUSES = ("booked", "seated", "cancelled", "no_show")


class Reservation(Base):
    """A table booking at one outlet. `table_id` is optional (assigned later or at seating). A booked / seated reservation
    holds its table for [starts_at, starts_at + duration_minutes). Seating attaches (or creates) the table's order."""
    __tablename__ = "reservations"
    __table_args__ = (
        UniqueConstraint("restaurant_id", "client_uuid"),  # offline / double-tap idempotency of create
        Index("ix_reservations_outlet_starts", "outlet_id", "starts_at"),
        CheckConstraint("party_size BETWEEN 1 AND 500", name="ck_reservations_party"),
        CheckConstraint("duration_minutes BETWEEN 15 AND 720", name="ck_reservations_duration"),
        CheckConstraint("status IN ('booked', 'seated', 'cancelled', 'no_show')", name="ck_reservations_status"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    client_uuid: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    guest_name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(30))
    party_size: Mapped[int] = mapped_column(Integer)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_minutes: Mapped[int] = mapped_column(Integer, default=90, server_default="90")
    table_id: Mapped[uuid.UUID | None] = fk("dining_tables", nullable=True)
    status: Mapped[str] = mapped_column(String(10), default="booked", server_default="booked")
    notes: Mapped[str | None] = mapped_column(String(500))
    order_id: Mapped[uuid.UUID | None] = fk("orders", nullable=True)
    seated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancel_reason: Mapped[str | None] = mapped_column(String(300))
    reminder_outbox_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)  # whatsapp_outbox row of the last reminder
    reminder_queued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID] = fk("users")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class AttendanceRecord(Base):
    """One clock-in .. clock-out of a user at an outlet. `work_date` = the outlet-local date of clock_in. At most one OPEN
    record per user (partial unique index). Manager corrections keep source / edit fields here and the before/after in
    audit_logs (entity 'attendance_record'). Voided records stay for the audit trail but are left out of every report."""
    __tablename__ = "attendance_records"
    __table_args__ = (
        UniqueConstraint("restaurant_id", "client_uuid"),
        Index("uq_attendance_one_open", "user_id", unique=True,
              postgresql_where=text_("clock_out_at IS NULL AND voided_at IS NULL")),
        Index("ix_attendance_rest_date", "restaurant_id", "work_date"),
        CheckConstraint("clock_out_at IS NULL OR clock_out_at >= clock_in_at", name="ck_attendance_order"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    user_id: Mapped[uuid.UUID] = fk("users")
    client_uuid: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    work_date: Mapped[date] = mapped_column(Date)
    clock_in_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    clock_out_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    clock_in_device: Mapped[str | None] = mapped_column(String(100))
    clock_out_device: Mapped[str | None] = mapped_column(String(100))
    geo: Mapped[dict | None] = mapped_column(JSONB)  # {"in": {lat, lng, accuracy_m}, "out": {...}}; only when ATTENDANCE_GEO is on
    source: Mapped[str] = mapped_column(String(10), default="self", server_default="self")  # self | manager
    created_by: Mapped[uuid.UUID] = fk("users")
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    edited_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    edit_reason: Mapped[str | None] = mapped_column(String(300))
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AttendanceSchedule(Base):
    """The expected working hours of a user at an outlet, per weekday (0 = Monday). Late / absent are derived from these;
    a user without a schedule is never late or absent. end_time < start_time = a shift past midnight."""
    __tablename__ = "attendance_schedules"
    __table_args__ = (
        UniqueConstraint("user_id", "outlet_id", "weekday"),
        CheckConstraint("weekday BETWEEN 0 AND 6", name="ck_attendance_schedules_weekday"),
        CheckConstraint("grace_minutes BETWEEN 0 AND 240", name="ck_attendance_schedules_grace"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    user_id: Mapped[uuid.UUID] = fk("users")
    weekday: Mapped[int] = mapped_column(SmallInteger)
    start_time: Mapped[time] = mapped_column(Time)
    end_time: Mapped[time] = mapped_column(Time)
    grace_minutes: Mapped[int] = mapped_column(Integer, default=10, server_default="10")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SetupStepSkip(Base):
    """A first-run checklist step the owner chose to skip. Completion itself is never stored: it is derived from real data
    (services/setup.py); this table holds only the 'skipped' choice."""
    __tablename__ = "setup_step_skips"
    __table_args__ = (UniqueConstraint("restaurant_id", "step"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    step: Mapped[str] = mapped_column(String(30))
    skipped_by: Mapped[uuid.UUID] = fk("users")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


FRONTDESK_OUTLET_TABLES: tuple[str, ...] = ("reservations", "attendance_records", "attendance_schedules")
for _t in FRONTDESK_OUTLET_TABLES:
    Base.metadata.tables[_t].append_constraint(ForeignKeyConstraint(
        ["outlet_id", "restaurant_id"], ["outlets.id", "outlets.restaurant_id"], name=f"fk_{_t}_outlet"))

FRONTDESK_TABLES: tuple[str, ...] = ("reservations", "attendance_records", "attendance_schedules", "setup_step_skips")

__all__ = ["Reservation", "AttendanceRecord", "AttendanceSchedule", "SetupStepSkip", "RESERVATION_STATUSES",
           "FRONTDESK_TABLES", "FRONTDESK_OUTLET_TABLES"]
