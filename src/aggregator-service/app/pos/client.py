"""Delivery contract to pos-service. pos-service is the source of truth for prices: it MUST re-validate every line's
unit price against its own menu and reject the order on any mismatch (PosResult.status == "rejected",
code "price_mismatch"). We send our prices only so it can compare; it never trusts them.
The real client is app/pos/http.py (HttpPosClient), speaking the delivery contract of
docs/DELIVERY_EXTRACTION_PLAN.md section 5; the pos-service endpoints are being built on another branch."""
from typing import Protocol

from pydantic import BaseModel


class PosLine(BaseModel):
    internal_item_id: str
    quantity: int
    unit_price_minor: int  # provider-quoted price; pos-service re-validates


class PosOrderRequest(BaseModel):
    idempotency_key: str  # "<provider>:<external_order_id>"; pos-service must dedupe on it
    tenant_id: str
    outlet_id: str
    source: str  # provider name
    external_order_id: str
    currency: str
    lines: list[PosLine]
    total_minor: int
    customer_name: str | None = None
    customer_phone: str | None = None
    notes: str | None = None
    fulfilment_type: str = "delivery"


class PosResult(BaseModel):
    status: str  # "accepted" | "rejected"
    pos_order_id: str | None = None
    code: str | None = None  # e.g. price_mismatch, item_unavailable, outlet_closed
    reason: str | None = None


class PosClient(Protocol):
    def submit_order(self, req: PosOrderRequest) -> PosResult:
        """Raise app.providers.base.TransientError for retryable failures (timeouts, 5xx). A business rejection is a
        returned PosResult(status="rejected"), never an exception."""
        ...
