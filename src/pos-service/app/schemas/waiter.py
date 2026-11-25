"""Waiter app schemas (docs/WAITER_API.md)."""
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.models.core import OrderStatus, OrderType


class ShiftOpenIn(BaseModel):
    note: str | None = Field(default=None, max_length=300)


class ShiftCloseIn(BaseModel):
    note: str | None = Field(default=None, max_length=300)


class ShiftOut(BaseModel):
    id: uuid.UUID
    outlet_id: uuid.UUID
    user_id: uuid.UUID
    user_name: str | None = None
    role: str
    opened_at: datetime
    open_note: str | None = None
    closed_at: datetime | None = None
    close_reason: Literal["self", "manager", "day_close"] | None = None
    table_ids: list[uuid.UUID] = []


class ShiftOpenOut(ShiftOut):
    created: bool = True  # false when the user already had an open shift here (idempotent re-open)


class TablesAssignIn(BaseModel):
    table_ids: list[uuid.UUID] = Field(max_length=200)  # the complete set; [] clears

    @field_validator("table_ids")
    @classmethod
    def _unique(cls, v):
        return list(dict.fromkeys(v))


class StaffRef(BaseModel):
    user_id: uuid.UUID
    name: str | None = None


class TableOrderSummary(BaseModel):
    order_id: uuid.UUID
    token_number: int | None = None
    status: OrderStatus
    waiter_id: uuid.UUID
    waiter_name: str | None = None
    opened_at: datetime | None = None
    item_count: int
    subtotal: Decimal
    kot_sent: bool
    note: str | None = None
    bill_requested_at: datetime | None = None
    # docs/ORDER_RULES.md: minutes since the order was opened; for a billed order waiting for payment, its bill.
    minutes_open: int | None = None
    total: Decimal | None = None  # the bill total when billed, else the subtotal
    bill_id: uuid.UUID | None = None
    invoice_number: str | None = None


class TableReservationRef(BaseModel):
    id: uuid.UUID
    guest_name: str
    party_size: int
    starts_at: datetime


class TableStatusOut(BaseModel):
    table_id: uuid.UUID
    label: str
    seats: int
    area: OrderType
    # free | occupied | bill_requested | bill_printed (a bill was made and is waiting for payment) | reserved (a FREE table
    # with a booked reservation starting within the next hour or running now; only when the restaurant uses reservations).
    status: Literal["free", "occupied", "bill_requested", "bill_printed", "reserved"]
    orders: list[TableOrderSummary] = []
    assigned_to: list[StaffRef] = []
    reservation: TableReservationRef | None = None  # the due booking of a `reserved` table


class BillRequestOut(BaseModel):
    """One entry of the counter's queue (GET /bill-requests, the business app's bell). `kind`: bill_request = a waiter asked for
    the bill of an OPEN order; payment_reminder = the order is billed and unpaid, the waiter asks the counter to take the payment
    (bill_id / invoice_number / balance_due / table_area are filled for that kind only; requested_by_name is the waiter who asked)."""
    kind: Literal["bill_request", "payment_reminder"] = "bill_request"
    order_id: uuid.UUID
    table_id: uuid.UUID | None = None
    table_label: str | None = None
    token_number: int | None = None
    requested_at: datetime
    requested_by: uuid.UUID | None = None
    requested_by_name: str | None = None
    waiter_id: uuid.UUID
    waiter_name: str | None = None
    item_count: int
    subtotal: Decimal
    note: str | None = None
    bill_id: uuid.UUID | None = None
    invoice_number: str | None = None
    balance_due: Decimal | None = None
    table_area: OrderType | None = None


class PaymentReminderOut(BaseModel):
    """POST /orders/{id}/remind-payment: already_sent = a reminder for this order went out less than a minute ago (nothing new)."""
    order_id: uuid.UUID
    already_sent: bool
    sent_at: datetime
    balance_due: Decimal
    invoice_number: str


class PaymentReminderDismissOut(BaseModel):
    order_id: uuid.UUID
    dismissed: bool  # False = there was nothing to dismiss (already dismissed, or paid)


class OrderTransferIn(BaseModel):
    table_id: uuid.UUID


class OrderMergeIn(BaseModel):
    into_order_id: uuid.UUID


class OrderNoteIn(BaseModel):
    note: str | None = Field(default=None, max_length=300)
