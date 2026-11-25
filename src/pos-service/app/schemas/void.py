"""Request / response models of POST /bills/{id}/void (services/void.py)."""
import uuid
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import BillOut


class VoidIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)
    idempotency_key: uuid.UUID | None = None  # or the Idempotency-Key header

    @field_validator("reason")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = " ".join(v.split())
        if not 3 <= len(v) <= 300:
            raise ValueError("reason must be 3-300 characters")
        return v


class VoidCreditNoteOut(BaseModel):
    id: uuid.UUID
    credit_note_number: str
    amount: Decimal
    tax_amount: Decimal
    reason: str


class RefundDueOut(BaseModel):
    """Money the customer paid that must now be handed back BY HAND (no gateway refund is made)."""
    amount: Decimal
    by_method: dict[str, Decimal] = {}
    note: str


class VoidOut(BaseModel):
    bill: BillOut
    credit_note: VoidCreditNoteOut
    refund_due: RefundDueOut
