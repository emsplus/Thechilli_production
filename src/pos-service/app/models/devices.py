"""Device sessions, counter devices and staff PINs (docs/STAFF_PIN_DEVICES_API.md, revision f1a3c5e7b9d2).

* login_devices: one row per (user, client device) that signed in with a password. Refresh tokens point at it
  (refresh_tokens.login_device_id), so revoking a device revokes exactly that device's refresh tokens.
* counter_devices: a shared tablet registered by an owner / manager for ONE outlet. Its credential (opaque, only the sha256
  is stored) can only read the roster / menu / tables of that outlet and call POST /auth/pin-login.
* staff_pins: a user's 4-6 digit PIN, stored only as an argon2 hash (per-hash random salt, optional server-side pepper).
* staff_pin_sessions: a staff session started on a counter device with a PIN (short idle timeout, hard maximum).
* pin_lockouts: wrong-PIN counters per (user, counter device), with an escalating lockout.

Every table is a tenant table with its own restaurant_id (RLS: app/core/rls.py STAFF_DEVICE_TABLES). None of them is read
by the offline sync path (the sync `devices` table is unrelated and unchanged)."""
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, ForeignKeyConstraint, Index, Integer, String, UniqueConstraint, func, text as text_,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import fk, outlet_col, uuid_pk

NEW_TABLES: tuple[str, ...] = ("login_devices", "counter_devices", "staff_pins", "staff_pin_sessions", "pin_lockouts")


def _user_fk(nullable: bool = False, index: bool = True) -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=nullable, index=index)


class LoginDevice(Base):
    """A device a user signed in on with a password. `device_key` is the client's X-Device-Id header (a random id the app
    generates once per install), or `ua:<sha256 of the User-Agent>` for clients that do not send one yet."""
    __tablename__ = "login_devices"
    __table_args__ = (
        UniqueConstraint("user_id", "device_key", name="uq_login_devices_user_key"),
        Index("ix_login_devices_rest_seen", "restaurant_id", "last_seen_at"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    user_id: Mapped[uuid.UUID] = _user_fk()
    device_key: Mapped[str] = mapped_column(String(100))
    name: Mapped[str | None] = mapped_column(String(100))       # X-Device-Name / login device_label, e.g. "Asha's phone"
    model: Mapped[str | None] = mapped_column(String(100))      # X-Device-Model, e.g. "Pixel 7"
    platform: Mapped[str | None] = mapped_column(String(30))    # X-Device-Platform: android | ios | web | windows | ...
    user_agent: Mapped[str | None] = mapped_column(String(300))
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_ip: Mapped[str | None] = mapped_column(String(64))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # cleared by a new sign-in on the device
    revoked_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))


class CounterDevice(Base):
    """A shared counter tablet of one outlet. The credential is returned once at registration; only its sha256 is stored."""
    __tablename__ = "counter_devices"
    __table_args__ = (
        ForeignKeyConstraint(["outlet_id", "restaurant_id"], ["outlets.id", "outlets.restaurant_id"], name="fk_counter_devices_outlet"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    name: Mapped[str] = mapped_column(String(100))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_ip: Mapped[str | None] = mapped_column(String(64))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))


class StaffPin(Base):
    """The PIN of one user: argon2 hash only (`scheme` 'argon2' or 'argon2+pepper' when PIN_PEPPER was set at hashing time)."""
    __tablename__ = "staff_pins"
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    pin_hash: Mapped[str] = mapped_column(String(255))
    scheme: Mapped[str] = mapped_column(String(20), default="argon2")
    set_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    set_by_manager: Mapped[bool] = mapped_column(Boolean, default=False)  # the user should choose their own PIN
    set_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StaffPinSession(Base):
    """A staff session on a counter device. Valid while ended_at IS NULL, last_activity_at + idle timeout > now and
    expires_at (hard maximum) > now. Checked on every request, so ending it is immediate."""
    __tablename__ = "staff_pin_sessions"
    __table_args__ = (
        ForeignKeyConstraint(["outlet_id", "restaurant_id"], ["outlets.id", "outlets.restaurant_id"],
                             name="fk_staff_pin_sessions_outlet"),
        Index("ix_staff_pin_sessions_device_open", "counter_device_id", postgresql_where=text_("ended_at IS NULL")),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    counter_device_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("counter_devices.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = _user_fk()
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_activity_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # logout | idle_lock | replaced | device_revoked | sign_out_all | pin_changed | password_change | password_reset | ...
    end_reason: Mapped[str | None] = mapped_column(String(30))
    ip: Mapped[str | None] = mapped_column(String(64))


class PinLockout(Base):
    """Wrong-PIN counter of one user in one scope: a counter device id, or 'personal' (step-up from the user's own session).
    `failures` counts wrong PINs since the last success / lockout; reaching the limit locks for
    PIN_LOCKOUT_MINUTES * 2^(lock_level-1), capped at PIN_LOCKOUT_MAX_MINUTES. A correct PIN deletes the row."""
    __tablename__ = "pin_lockouts"
    __table_args__ = (UniqueConstraint("user_id", "scope_key", name="uq_pin_lockouts_user_scope"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    user_id: Mapped[uuid.UUID] = _user_fk()
    scope_key: Mapped[str] = mapped_column(String(64))
    failures: Mapped[int] = mapped_column(Integer, default=0)
    lock_level: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_failure_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


__all__ = ["LoginDevice", "CounterDevice", "StaffPin", "StaffPinSession", "PinLockout", "NEW_TABLES"]
