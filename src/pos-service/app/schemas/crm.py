import re
import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, EmailStr, Field, computed_field, field_validator, model_validator

from app.models.core import ConsentChannel
from app.schemas.common import ORM


def normalize_phone(v: str) -> str:
    """Normalises to E.164 for India: a bare 10-digit mobile (98765 43210) or the national form with the trunk 0
    (098765 43210, 080 1234 5678) gets +91; a number that already starts with + or 00 keeps its own country code."""
    raw = re.sub(r"\(0\)", "", v.strip())  # "+91 (0)80 ..." -> "+91 80 ..."
    d = re.sub(r"[^\d+]", "", raw)
    if d.startswith("00"):
        d = "+" + d[2:]
    elif re.fullmatch(r"[6-9]\d{9}", d):  # bare Indian mobile, e.g. 98765 43210
        d = "+91" + d
    elif d.startswith("0"):
        d = "+91" + d[1:]
    elif not d.startswith("+"):
        d = "+" + d
    if not re.fullmatch(r"\+\d{8,15}", d):
        raise ValueError("Enter a valid phone number with country code")
    return d


class CustomerIn(BaseModel):
    """Name and phone are each optional (blank = not given), but at least one of them is required."""
    name: str | None = Field(default=None, max_length=200)
    phone: str | None = None
    email: EmailStr | None = None
    notes: str | None = Field(default=None, max_length=500)
    # India GST (B2B). Checked with the tax engine's validators; blank = not given.
    gstin: str | None = Field(default=None, max_length=15)
    state_code: str | None = Field(default=None, max_length=2)

    @field_validator("gstin", "state_code", mode="before")
    @classmethod
    def _gst_fields(cls, v, info):
        if isinstance(v, str):
            v = v.strip().upper() or None
        if v is None:
            return None
        from app.services import gst  # local import: the engine is only needed when a value is given
        try:
            return gst.check_gstin(v) if info.field_name == "gstin" else gst.check_state(v)
        except ValueError as e:
            raise ValueError(str(e))

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, v):
        if isinstance(v, str):
            v = " ".join(v.split())
            return v or None
        return v

    @field_validator("email", mode="before")
    @classmethod
    def _email(cls, v):
        return (v.strip() or None) if isinstance(v, str) else v

    @field_validator("phone")
    @classmethod
    def _phone(cls, v):
        # Final E.164 normalisation needs the restaurant's country, so it happens in the route/service.
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if not re.fullmatch(r"[\d\s()+\-.]{6,25}", v):
            raise ValueError("Enter a valid phone number")
        return v

    @model_validator(mode="after")
    def _name_or_phone(self):
        if self.name is None and self.phone is None:
            raise ValueError("Enter a name or a phone number (or both)")
        return self


class CustomerPatch(CustomerIn):
    """Edit: only the fields sent change (send null/blank to clear one). The result must still have a name or a phone,
    which the route checks against the stored values."""

    @model_validator(mode="after")
    def _name_or_phone(self):
        return self


class ConsentIn(BaseModel):
    channel: ConsentChannel
    granted: bool
    source: str = Field(min_length=3, max_length=100)


class ConsentState(BaseModel):
    channel: ConsentChannel
    granted: bool
    source: str
    recorded_at: datetime


class CustomerOut(ORM):
    id: uuid.UUID
    name: str | None
    phone: str | None
    email: str | None
    notes: str | None
    gstin: str | None = None
    state_code: str | None = None
    consents: list[ConsentState] = []
    orders: int = 0
    total_spent: Decimal = Decimal(0)
    last_visit: datetime | None = None

    @computed_field  # what every screen shows: the name, or the phone for a nameless customer
    @property
    def display_name(self) -> str:
        return self.name or self.phone or ""


class HistoryBill(BaseModel):
    invoice_number: str
    finalized_at: datetime
    total: Decimal
    items: list[str]


class HeartbeatIn(BaseModel):
    device_key: uuid.UUID
    pending_ops: int = Field(ge=0, le=100000)
    name: str | None = Field(default=None, max_length=100)


class AlertOut(ORM):
    id: uuid.UUID
    kind: str
    item_id: uuid.UUID
    status: str
    message: str
    balance: Decimal
    created_at: datetime
    resolved_at: datetime | None
