"""Request / response models of the cashier shift / cash reconciliation endpoints (docs/CASH_SESSIONS.md)."""
import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator


class CashOpenIn(BaseModel):
    opening_float: Decimal = Field(default=Decimal("0"), ge=0, max_digits=12, decimal_places=2)
    idempotency_key: uuid.UUID | None = None


class CashCloseIn(BaseModel):
    counted_cash: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    variance_reason: str | None = Field(default=None, max_length=300)

    @field_validator("variance_reason")
    @classmethod
    def _strip(cls, v):
        v = " ".join((v or "").split())
        return v or None


class CashBreakdown(BaseModel):
    cash_payments: Decimal           # cash taken by this cashier during the session
    cash_voids: Decimal              # cash handed back for bills voided by this user (bills.void)
    cash_refunds: Decimal            # refunds recorded by this user (assumed paid from the till in cash)
    cash_correction_payouts: Decimal  # cash handed back at bill corrections recorded by this user
    by_method: dict[str, Decimal] = {}  # every method taken by this cashier (net of voids), for information


class CashSessionOut(BaseModel):
    id: uuid.UUID
    outlet_id: uuid.UUID
    cashier_id: uuid.UUID
    cashier_name: str | None = None
    status: str
    opened_at: datetime
    opening_float: Decimal
    closed_at: datetime | None = None
    closed_by: uuid.UUID | None = None
    expected_cash: Decimal            # live while open, the closing snapshot once closed
    counted_cash: Decimal | None = None
    variance: Decimal | None = None   # counted - expected (negative = short)
    variance_reason: str | None = None
    breakdown: CashBreakdown
