import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.models.core import EXPENSE_CATEGORIES
from app.schemas.common import ORM

_CATS = "^(" + "|".join(EXPENSE_CATEGORIES) + ")$"


class ExpenseIn(BaseModel):
    supplier_id: uuid.UUID | None = None
    supplier_name: str = Field(min_length=1, max_length=200)
    invoice_number: str | None = Field(default=None, max_length=100)
    expense_date: date
    category: str = Field(pattern=_CATS)
    net: Decimal = Field(ge=0, lt=Decimal("10000000"))
    vat: Decimal = Field(default=Decimal(0), ge=0, lt=Decimal("10000000"))
    gross: Decimal | None = Field(default=None, ge=0, lt=Decimal("10000000"))  # must equal net + vat when given
    note: str | None = Field(default=None, max_length=300)
    invoice_id: uuid.UUID | None = None  # the scanned invoice this was recorded from


class ExpensePatch(BaseModel):
    supplier_id: uuid.UUID | None = None
    supplier_name: str | None = Field(default=None, min_length=1, max_length=200)
    invoice_number: str | None = Field(default=None, max_length=100)
    expense_date: date | None = None
    category: str | None = Field(default=None, pattern=_CATS)
    net: Decimal | None = Field(default=None, ge=0, lt=Decimal("10000000"))
    vat: Decimal | None = Field(default=None, ge=0, lt=Decimal("10000000"))
    note: str | None = Field(default=None, max_length=300)


class ExpenseOut(ORM):
    id: uuid.UUID
    supplier_id: uuid.UUID | None
    supplier_name: str
    invoice_number: str | None
    expense_date: date
    category: str
    net: Decimal
    vat: Decimal
    gross: Decimal
    note: str | None
    invoice_id: uuid.UUID | None
    created_at: datetime | None = None


class ExpenseBucket(BaseModel):
    key: str  # "2026-10" or a category
    count: int
    net: Decimal
    vat: Decimal
    gross: Decimal


class ExpenseSummary(BaseModel):
    months: list[ExpenseBucket]
    categories: list[ExpenseBucket]
    total: ExpenseBucket
