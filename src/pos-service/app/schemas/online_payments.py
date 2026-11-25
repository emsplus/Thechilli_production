import uuid
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class OnlinePaymentIn(BaseModel):
    idempotency_key: uuid.UUID  # one per attempt; replaying it returns the same attempt
    method: Literal["upi_qr", "payment_link"]
    amount: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)  # default: everything still due
    description: str = Field(default="", max_length=200)


class OnlinePaymentOut(ORM):
    id: uuid.UUID
    bill_id: uuid.UUID
    method: str
    amount: Decimal
    currency: str
    # creating | pending | succeeded | failed | partially_refunded | refunded. "paid" is applied_amount > 0, set only
    # from payments-service's report, never from a client.
    status: str
    payment_url: str | None
    qr_payload: str | None
    captured_amount: Decimal
    applied_amount: Decimal
    unallocated_amount: Decimal  # received beyond what the bill still owed: needs a manual refund / decision
    last_error: str | None
    last_synced_at: datetime | None
    created_at: datetime


class RemoteUnallocatedOut(BaseModel):
    online_payment_id: str
    provider_payment_id: str
    amount: Decimal
    refunded: bool


class BillOnlineOut(BaseModel):
    bill_id: uuid.UUID
    total: Decimal
    paid: Decimal
    due: Decimal
    pending_online: Decimal
    unallocated_amount: Decimal
    remote_unallocated: list[RemoteUnallocatedOut]
    stale: list[str]  # attempts that could not be refreshed just now (payments-service unreachable)
    items: list[OnlinePaymentOut]


class ProviderAccountIn(BaseModel):
    provider: Literal["razorpay"]
    key_id_ref: str = Field(min_length=3, max_length=80, pattern=r"^[A-Z][A-Z0-9_]+$")
    key_secret_ref: str = Field(min_length=3, max_length=80, pattern=r"^[A-Z][A-Z0-9_]+$")
    webhook_secret_ref: str = Field(min_length=3, max_length=80, pattern=r"^[A-Z][A-Z0-9_]+$")


class ProviderAccountOut(ORM):
    provider: str
    remote_account_id: uuid.UUID
    key_id_ref: str
    key_secret_ref: str
    webhook_secret_ref: str
    secret_prefix: str
    webhook_path: str  # /api/v1/webhooks/razorpay/<id> on payments-service: configure it (public base + this) in the provider dashboard
    webhook_url: str | None = None
