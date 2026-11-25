import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator

from app.core.config import settings


class Strict(BaseModel):
    # extra=forbid: a caller cannot smuggle card numbers / CVV fields into the API; they are rejected with 422.
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class ProviderAccountIn(Strict):
    provider: Literal["razorpay"]
    key_id_ref: str
    key_secret_ref: str
    webhook_secret_ref: str


class ProviderAccountOut(Strict):
    id: uuid.UUID
    provider: str
    key_id_ref: str
    key_secret_ref: str
    webhook_secret_ref: str
    active: bool


class IntentIn(Strict):
    amount: StrictInt = Field(ge=settings.min_intent_amount, le=settings.max_intent_amount)  # integer paise only
    currency: str = Field(default="INR", pattern=r"^[A-Z]{3}$")
    method: Literal["upi_qr", "payment_link"]
    reference: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=200)
    provider_account_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _inr_only(self):
        # Owner decision 2026-10-31 (docs/DECISIONS.md): online payments (UPI QR and payment links) are INR only.
        if self.currency != "INR":
            raise ValueError("only INR is supported")
        return self

    @field_validator("amount", mode="before")
    @classmethod
    def _no_bool(cls, v):
        if isinstance(v, bool):
            raise ValueError("amount must be an integer")  # noqa: TRY004 (pydantic only maps ValueError)
        return v


class IntentOut(Strict):
    id: uuid.UUID
    tenant_id: str
    reference: str
    method: str
    amount: int
    currency: str
    status: str
    captured_amount: int
    refunded_amount: int
    payment_url: str | None
    qr_payload: str | None
    provider_ref: str | None
    provider_payment_id: str | None
    created_at: datetime


class RefundIn(Strict):
    amount: StrictInt = Field(gt=0)
    reason: str = Field(default="", max_length=200)


class UnallocatedRefundIn(Strict):
    reason: str = Field(default="", max_length=200)


class UnallocatedOut(Strict):
    intent_id: uuid.UUID
    provider_payment_id: str
    amount: int
    currency: str
    refunded: bool
    created_at: datetime


class RefundOut(Strict):
    id: uuid.UUID
    intent_id: uuid.UUID
    amount: int
    status: str
    provider_refund_id: str | None
    reason: str


class SettlementItem(Strict):
    type: Literal["payment", "refund"]
    provider_txn_id: str = Field(min_length=1, max_length=64)
    amount: StrictInt = Field(gt=0)
    fee: StrictInt = Field(default=0, ge=0)
    tax: StrictInt = Field(default=0, ge=0)


class SettlementIn(Strict):
    provider: Literal["razorpay"]
    settlement_ref: str = Field(min_length=1, max_length=64)
    settled_at: datetime
    items: list[SettlementItem] = Field(min_length=1, max_length=5000)


class ReconRecordOut(Strict):
    id: uuid.UUID
    settlement_id: uuid.UUID
    item_type: str
    provider_txn_id: str
    amount: int
    fee: int
    tax: int
    status: str
    intent_id: uuid.UUID | None
    expected_amount: int | None
