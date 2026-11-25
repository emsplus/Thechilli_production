import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Role = Literal["counter", "kitchen", "other"]
Connection = Literal["lan", "system"]
Codepage = Literal["pc858", "cp1252", "cp437", "none"]
Status = Literal["online", "offline", "unknown"]
HOST_RE = re.compile(r"^[A-Za-z0-9.\-:\[\]_]{1,255}$")


class PrinterIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    role: Role = "counter"
    connection: Connection = "lan"
    host: str | None = Field(default=None, max_length=255)
    port: int = Field(default=9100, ge=1, le=65535)
    system_name: str | None = Field(default=None, max_length=255)
    columns: int = Field(default=42, ge=24, le=64)
    codepage: Codepage = "pc858"
    copies: int = Field(default=1, ge=1, le=5)
    cut: bool = True
    is_active: bool = True
    auto_bill: bool = False
    auto_kot: bool = False
    kot_category_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)

    @field_validator("name", "host", "system_name")
    @classmethod
    def _strip(cls, v):
        if v is None:
            return None
        v = v.strip()
        return v or None

    @field_validator("host")
    @classmethod
    def _host(cls, v):
        if v is not None and not HOST_RE.match(v):
            raise ValueError("Host must be an IP address or host name")
        return v


class PrinterPatch(BaseModel):
    """Every field optional; the merged result is validated like a new printer."""
    name: str | None = Field(default=None, min_length=1, max_length=100)
    role: Role | None = None
    connection: Connection | None = None
    host: str | None = Field(default=None, max_length=255)
    port: int | None = Field(default=None, ge=1, le=65535)
    system_name: str | None = Field(default=None, max_length=255)
    columns: int | None = Field(default=None, ge=24, le=64)
    codepage: Codepage | None = None
    copies: int | None = Field(default=None, ge=1, le=5)
    cut: bool | None = None
    is_active: bool | None = None
    auto_bill: bool | None = None
    auto_kot: bool | None = None
    kot_category_ids: list[uuid.UUID] | None = Field(default=None, max_length=200)


class PrinterOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    role: str
    connection: str
    host: str | None
    port: int
    system_name: str | None
    columns: int
    codepage: str
    copies: int
    cut: bool
    is_active: bool
    auto_bill: bool
    auto_kot: bool
    kot_category_ids: list[uuid.UUID]
    created_at: datetime
    status: Status = "unknown"  # reported by a hub seen in the last 45 s, else unknown


class PrinterBrief(BaseModel):
    id: uuid.UUID
    name: str
    role: str
    auto_bill: bool
    auto_kot: bool  # the POS sends the kitchen slip by itself when an order is placed


class PairingOut(BaseModel):
    code: str
    expires_at: datetime


class HubOut(BaseModel):
    id: uuid.UUID
    name: str
    last_seen_at: datetime | None
    version: str | None
    os: str | None
    system_printers: list[str]
    printer_status: dict[str, str]
    created_at: datetime
    online: bool


class JobOut(BaseModel):
    id: uuid.UUID
    printer_id: uuid.UUID
    printer_name: str | None
    kind: str
    ref_id: uuid.UUID | None
    copy_no: int
    reprint_no: int
    status: str
    attempts: int
    last_error: str | None
    created_by: uuid.UUID | None
    created_at: datetime
    sent_at: datetime | None
    printed_at: datetime | None


class ReprintIn(BaseModel):
    printer_id: uuid.UUID | None = None


class JobsOut(BaseModel):
    jobs: list[JobOut]


# ---- hub side ----
class PairIn(BaseModel):
    # at least 10 alphanumerics (what pairing issues: 10 upper-case characters); dashes/spaces typed for readability are ignored
    code: str = Field(min_length=10, max_length=32, pattern=r"^[A-Za-z0-9 -]+$")
    name: str = Field(default="Print hub", min_length=1, max_length=100)
    os: str | None = Field(default=None, max_length=40)
    version: str | None = Field(default=None, max_length=40)


class PairOut(BaseModel):
    token: str
    hub_id: uuid.UUID


class HeartbeatIn(BaseModel):
    version: str | None = Field(default=None, max_length=40)
    os: str | None = Field(default=None, max_length=40)
    system_printers: list[str] = Field(default_factory=list, max_length=200)
    printer_status: dict[str, str] = Field(default_factory=dict)


class HubPrinterOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    connection: str
    host: str | None
    port: int
    system_name: str | None


class HeartbeatOut(BaseModel):
    printers: list[HubPrinterOut]


class HubJobPrinter(BaseModel):
    id: uuid.UUID
    connection: str
    host: str | None
    port: int
    system_name: str | None


class HubJob(BaseModel):
    id: uuid.UUID
    printer: HubJobPrinter
    payload_b64: str
    attempts: int


class HubJobsOut(BaseModel):
    jobs: list[HubJob]


class ResultIn(BaseModel):
    ok: bool
    error: str | None = Field(default=None, max_length=2000)


class TestIn(BaseModel):
    __test__ = False  # not a pytest class
    codepage: Codepage | None = None  # override the printer's code page for this one test page
