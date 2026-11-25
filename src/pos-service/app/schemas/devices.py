"""Device sessions, counter devices, staff PINs (docs/STAFF_PIN_DEVICES_API.md). PINs and credentials are SecretStr so they never
appear in a validation error body or a log line."""
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, SecretStr


class LoginDeviceOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    user_name: str
    user_role: str
    device_id: str | None = None  # the client's X-Device-Id (null for an old client identified by its User-Agent)
    name: str | None = None
    model: str | None = None
    platform: str | None = None
    user_agent: str | None = None
    first_seen_at: datetime
    last_seen_at: datetime
    last_ip: str | None = None
    revoked_at: datetime | None = None
    active: bool  # has a live refresh token (can stay signed in)
    current: bool  # this is the device making the request (matched by X-Device-Id)


class SignOutAllIn(BaseModel):
    keep_current: bool = False  # keep the device making the request (X-Device-Id) signed in


class SignOutAllOut(BaseModel):
    devices_signed_out: int


class CounterDeviceIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    outlet_id: uuid.UUID | None = None  # default: the request's outlet (X-Outlet-Id or the default outlet)


class CounterDeviceOut(BaseModel):
    id: uuid.UUID
    name: str
    outlet_id: uuid.UUID
    outlet_name: str | None = None
    created_at: datetime
    created_by: uuid.UUID | None = None
    last_seen_at: datetime | None = None
    last_ip: str | None = None
    revoked_at: datetime | None = None
    active_sessions: int = 0


class CounterDeviceCreated(BaseModel):
    id: uuid.UUID
    name: str
    outlet_id: uuid.UUID
    created_at: datetime
    device_token: str  # shown ONCE; store it on the tablet (secure storage). Only its hash is kept.


class RosterDevice(BaseModel):
    id: uuid.UUID
    name: str
    outlet_id: uuid.UUID
    outlet_name: str | None = None
    restaurant_name: str | None = None


class RosterStaff(BaseModel):
    id: uuid.UUID
    name: str
    role: str
    initials: str


class RosterOut(BaseModel):
    device: RosterDevice
    staff: list[RosterStaff]


class PinStatusOut(BaseModel):
    is_set: bool
    set_at: datetime | None = None
    set_by_manager: bool = False


class OwnPinIn(BaseModel):
    pin: SecretStr
    current_password: SecretStr


class PinIn(BaseModel):
    pin: SecretStr


class PinLoginIn(BaseModel):
    device_token: SecretStr | None = None  # or the X-Counter-Token header
    user_id: uuid.UUID  # from GET /devices/counter/roster
    pin: SecretStr


class PinUser(BaseModel):
    id: uuid.UUID
    name: str
    role: str
    initials: str


class PinLoginOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int  # seconds until the hard maximum (PIN_SESSION_MAX_HOURS)
    idle_timeout_seconds: int
    session_id: uuid.UUID
    expires_at: datetime
    outlet_id: uuid.UUID
    counter_device_id: uuid.UUID
    user: PinUser
    permissions: list[str]
    pin_change_suggested: bool  # the PIN was set by a manager: suggest choosing their own (from a password session)


class PinLogoutIn(BaseModel):
    reason: Literal["logout", "idle_lock", "switch_user"] = "logout"


class StepUpIn(BaseModel):
    pin: SecretStr | None = None
    password: SecretStr | None = None


class StepUpOut(BaseModel):
    step_up_token: str
    expires_in: int
    expires_at: datetime
    method: Literal["pin", "password"]
