import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.schemas.common import ORM


class EmailSettingsOut(BaseModel):
    configured: bool  # false = "Email is not set up" (nothing is sent)
    auto_enabled: bool
    window_hours: int


class EmailSettingsIn(BaseModel):
    auto_reorder_emails: bool | None = None
    reorder_email_window_hours: int | None = Field(default=None, ge=0, le=168)  # 0 = no gap between automatic emails


class ReorderLineIn(BaseModel):
    item_id: uuid.UUID
    quantity: Decimal = Field(gt=0)
    unit: str = Field(max_length=20)


class ReorderEmailIn(BaseModel):
    items: list[ReorderLineIn] = Field(min_length=1, max_length=60)
    note: str | None = Field(default=None, max_length=500)


class ReorderLineOut(BaseModel):
    item_id: uuid.UUID
    name: str
    unit: str
    balance: Decimal
    quantity: Decimal


class ReorderPreviewOut(BaseModel):
    to: str | None
    subject: str
    body_text: str
    items: list[ReorderLineOut]
    can_send: bool
    reason: str | None = None


class SupplierEmailOut(ORM):
    id: uuid.UUID
    supplier_id: uuid.UUID
    supplier_name: str | None = None
    to_email: str
    subject: str
    body_text: str
    items: list[ReorderLineOut]
    note: str | None = None
    kind: str
    status: str
    error: str | None = None
    attempts: int
    created_at: datetime
    sent_at: datetime | None = None
    created_by: uuid.UUID | None = None
