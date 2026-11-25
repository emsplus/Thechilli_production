import uuid
from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, Field, TypeAdapter, field_validator

from app.models.core import PaymentMethod
from app.schemas.common import MAX_ORDER_LINES, DiscountIn, OrderIn, OrderLineIn


class CreateOrderOp(BaseModel):
    type: Literal["create_order"]
    order: OrderIn
    accept_price_changes: bool = False


class AddLinesOp(BaseModel):
    type: Literal["add_lines"]
    order_client_uuid: uuid.UUID
    batch_uuid: uuid.UUID  # idempotency key of this addition
    lines: list[OrderLineIn] = Field(min_length=1, max_length=MAX_ORDER_LINES)
    accept_price_changes: bool = False


class KotOp(BaseModel):
    type: Literal["send_kot"]
    order_client_uuid: uuid.UUID


class FinalizeOp(BaseModel):
    type: Literal["finalize_bill"]
    order_client_uuid: uuid.UUID
    discount: DiscountIn | None = None   # same meaning as the body of POST /orders/{id}/bill
    service_charge: bool = True          # false = remove the service charge from this bill
    apply_offers: bool = True            # false = no automatic offers on this bill (docs/MODIFIERS_OFFERS.md)


class PaymentOp(BaseModel):
    type: Literal["payment"]
    order_client_uuid: uuid.UUID
    method: PaymentMethod  # always settles the server-computed balance; amounts are never trusted


class OpenShiftOp(BaseModel):
    type: Literal["open_shift"]
    note: str | None = Field(default=None, max_length=300)


class CloseShiftOp(BaseModel):
    type: Literal["close_shift"]  # closes the caller's open shift at the request's outlet; none open = a no-op


class RequestBillOp(BaseModel):
    type: Literal["request_bill"]
    order_client_uuid: uuid.UUID


Op = Annotated[CreateOrderOp | AddLinesOp | KotOp | FinalizeOp | PaymentOp | OpenShiftOp | CloseShiftOp | RequestBillOp,
               Field(discriminator="type")]


class SyncOpIn(BaseModel):
    op_id: uuid.UUID
    device_id: str | None = Field(default=None, max_length=64)
    client_created_at: datetime | None = None
    op: Op

    @field_validator("client_created_at")
    @classmethod
    def _aware(cls, v: datetime | None) -> datetime | None:
        """A device stamp without a UTC offset is read as UTC (it used to be a 500 for the whole batch: naive minus aware)."""
        return v.replace(tzinfo=timezone.utc) if v is not None and v.tzinfo is None else v


class SyncBatchIn(BaseModel):
    operations: list[SyncOpIn] = Field(min_length=1, max_length=100)
    # The device's clock at the moment the batch is sent (ISO-8601, UTC). The server derives the device's clock error from it and
    # corrects every `client_created_at` (docs/OFFLINE_SALE_TIME.md). Missing or unreadable = all device times of the batch are ignored
    # (never a 422: an old app that does not send it keeps syncing, its sales are dated with the sync time).
    client_sent_at: datetime | None = None

    @field_validator("client_sent_at", mode="before")
    @classmethod
    def _lenient(cls, v):
        if v is None:
            return None
        try:
            t = TypeAdapter(datetime).validate_python(v)
        except ValueError:
            return None
        return t.replace(tzinfo=timezone.utc) if t.tzinfo is None else t


class SyncResult(BaseModel):
    op_id: uuid.UUID
    status: Literal["synced", "conflict", "failed"]
    # e.g. price_changed, forbidden, not_available_for_business_type (a queued dine-in op of a business without dine-in:
    # drop it or re-enter it as takeaway / delivery), or an order-rules code.
    code: str | None = None      # stable error code, the same as the online endpoint's error.code (docs/ORDER_RULES.md)
    detail: str | None = None
    details: dict | None = None  # machine-readable details of a rule refusal (e.g. existing_order_id)
    conflicts: list[dict] | None = None
    data: dict | None = None


class SyncBatchOut(BaseModel):
    results: list[SyncResult]
