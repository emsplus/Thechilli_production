"""Request / response models of the bill-amendment (correct a finalized bill) endpoints.
Clients never send tax figures: any extra fields (tax_code, vat, rate...) are ignored by validation."""
import uuid
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import BillOut, DiscountIn, PaymentMethod


class AmendLineIn(BaseModel):
    bill_line_id: uuid.UUID | None = None   # the line of the bill being corrected this row keeps / changes; null = new line
    item_id: uuid.UUID
    variant_id: uuid.UUID | None = None
    quantity: int = Field(ge=1, le=999)
    unit_price_override: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    override_reason: str | None = Field(default=None, max_length=200)


class AmendPreviewIn(BaseModel):
    """`discount` omitted = keep the original bill's discount (type/value/reason) re-applied to the new lines;
    explicit null = no discount. `service_charge` omitted = as on the original bill; true/false overrides.
    `table_id` omitted/null = keep the original table; a table moves a dine-in bill (indoor <-> outdoor follows the
    table's area)."""
    lines: list[AmendLineIn] = Field(min_length=1, max_length=100)
    discount: DiscountIn | None = None
    service_charge: bool | None = None
    table_id: uuid.UUID | None = None


class AmendIn(AmendPreviewIn):
    reason: str = Field(min_length=3, max_length=300)
    idempotency_key: uuid.UUID
    refund_method: Literal["cash", "card", "upi", "other"] | None = None

    @field_validator("reason")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = " ".join(v.split())
        if not 3 <= len(v) <= 300:
            raise ValueError("reason must be 3-300 characters")
        return v


class ChainLink(BaseModel):
    id: uuid.UUID
    invoice_number: str
    status: str
    total: Decimal
    sale_at: str
    posted_at: str


class AmendOptionsOut(BaseModel):
    amendable: bool
    reason_if_not: str | None = None
    window_ends_at: str | None = None
    amend_days: int
    current_version_id: uuid.UUID
    chain: list[ChainLink]
    refundable_by_method: dict[str, Decimal] = {}


class CreditNoteOut(BaseModel):
    id: uuid.UUID
    credit_note_number: str
    bill_id: uuid.UUID            # the superseded original it cancels
    invoice_number: str
    amount: Decimal
    tax_amount: Decimal
    reason: str
    replacement_bill_id: uuid.UUID
    replacement_invoice_number: str


class AmendRefundOut(BaseModel):
    amount: Decimal
    method: str
    credit_note_number: str


class AmendOut(BaseModel):
    replacement: BillOut
    credit_note: CreditNoteOut
    refund: AmendRefundOut | None = None
