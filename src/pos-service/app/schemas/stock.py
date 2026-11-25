import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import AliasChoices, BaseModel, Field, computed_field, model_validator

from app.schemas.common import ORM

Q = dict(gt=0, max_digits=14, decimal_places=3)


class LocationIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: str = Field(default="store", pattern="^(store|kitchen|bar|cold_room|prep)$")


class LocationPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    kind: str | None = Field(default=None, pattern="^(store|kitchen|bar|cold_room|prep)$")
    is_active: bool | None = None


class LocationOut(ORM):
    id: uuid.UUID
    outlet_id: uuid.UUID
    name: str
    kind: str
    is_default: bool
    is_active: bool


class ConversionIn(BaseModel):
    unit_code: str = Field(min_length=1, max_length=20)
    factor_to_base: Decimal = Field(gt=0, max_digits=14, decimal_places=6)


class ConversionsIn(BaseModel):
    conversions: list[ConversionIn] = Field(max_length=30)


class ConversionOut(ORM):
    unit_code: str
    factor_to_base: Decimal


class WastageIn(BaseModel):
    idempotency_key: uuid.UUID
    item_id: uuid.UUID
    quantity: Decimal = Field(**Q)
    unit: str = Field(max_length=20)
    reason_code: str
    note: str | None = Field(default=None, max_length=300)
    location_id: uuid.UUID | None = None
    batch_id: uuid.UUID | None = None


class MovementBrief(ORM):
    id: uuid.UUID
    item_id: uuid.UUID
    location_id: uuid.UUID
    batch_id: uuid.UUID | None = None
    quantity: Decimal
    movement_type: str
    reason_code: str | None = None


class WastageOut(BaseModel):
    replayed: bool
    movements: list[MovementBrief]


class WriteOffIn(BaseModel):
    idempotency_key: uuid.UUID
    note: str | None = Field(default=None, max_length=300)


class BatchOut(BaseModel):
    id: uuid.UUID
    item_id: uuid.UUID
    item_name: str
    unit: str
    location_id: uuid.UUID
    batch_no: str
    expiry_date: date | None
    received_at: datetime
    unit_cost: Decimal | None
    qty_received: Decimal
    remaining: Decimal
    expired: bool


class CountOpenIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    location_id: uuid.UUID | None = None


class CountLineIn(BaseModel):
    item_id: uuid.UUID
    counted: Decimal = Field(ge=0, max_digits=14, decimal_places=3)
    unit: str = Field(max_length=20)


class CountLinesIn(BaseModel):
    lines: list[CountLineIn] = Field(min_length=1, max_length=500)


class CountLineOut(ORM):
    item_id: uuid.UUID
    counted_base: Decimal
    expected_base: Decimal | None = None
    variance: Decimal | None = None


class CountOut(ORM):
    id: uuid.UUID
    outlet_id: uuid.UUID
    location_id: uuid.UUID
    name: str | None = None
    status: str
    posted_at: datetime | None = None
    lines: list[CountLineOut] = []


# ---- purchasing
class POLineIn(BaseModel):
    item_id: uuid.UUID
    quantity: Decimal = Field(**Q)
    unit: str | None = Field(default=None, max_length=20)  # default: the item's base unit
    unit_price: Decimal = Field(ge=0, max_digits=12, decimal_places=4)  # per `unit`, tax excluded
    tax_rate: Decimal = Field(default=Decimal(0), ge=0, le=100, max_digits=5, decimal_places=2)


class POIn(BaseModel):
    supplier_id: uuid.UUID
    expected_date: date | None = None
    notes: str | None = Field(default=None, max_length=500)
    lines: list[POLineIn] = Field(min_length=1, max_length=200)


class POPatch(BaseModel):
    supplier_id: uuid.UUID | None = None
    expected_date: date | None = None
    notes: str | None = Field(default=None, max_length=500)
    lines: list[POLineIn] | None = Field(default=None, min_length=1, max_length=200)


class POLineOut(ORM):
    id: uuid.UUID
    position: int
    item_id: uuid.UUID
    unit_code: str
    factor_to_base: Decimal
    quantity: Decimal
    unit_price: Decimal
    tax_rate: Decimal
    received_quantity: Decimal


class POOut(ORM):
    id: uuid.UUID
    outlet_id: uuid.UUID
    supplier_id: uuid.UUID
    number: str
    status: str
    expected_date: date | None = None
    notes: str | None = None
    subtotal: Decimal
    tax_total: Decimal
    total: Decimal
    sent_at: datetime | None = None
    closed_at: datetime | None = None
    cancelled_at: datetime | None = None
    lines: list[POLineOut] = []


class GRNLineIn(BaseModel):
    po_line_id: uuid.UUID
    quantity: Decimal = Field(**Q)  # accepted, in the PO line's unit
    rejected_quantity: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=3)
    unit_price: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=4)  # actual rate; default: the PO's
    tax_rate: Decimal | None = Field(default=None, ge=0, le=100, max_digits=5, decimal_places=2)
    batch_no: str | None = Field(default=None, max_length=60)
    expiry_date: date | None = None


class GRNIn(BaseModel):
    idempotency_key: uuid.UUID
    location_id: uuid.UUID | None = None
    received_on: date | None = None
    # The supplier's bill number (optional). Accepted as `supplier_invoice_no` or `supplier_invoice_number`.
    supplier_invoice_no: str | None = Field(default=None, max_length=100,
                                            validation_alias=AliasChoices("supplier_invoice_no", "supplier_invoice_number"))
    # The supplier's bill already scanned under Purchases (optional): links the GRN to it (docs/INVENTORY.md).
    purchase_invoice_id: uuid.UUID | None = None
    note: str | None = Field(default=None, max_length=300)
    lines: list[GRNLineIn] = Field(min_length=1, max_length=200)


class GRNLinkIn(BaseModel):
    """POST /goods-receipts/{id}/link-purchase: record the supplier's bill number and/or link the scanned purchase bill
    after the goods were received. At least one of the two."""
    supplier_invoice_number: str | None = Field(default=None, max_length=100,
                                                validation_alias=AliasChoices("supplier_invoice_number", "supplier_invoice_no"))
    purchase_invoice_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _one(self):
        self.supplier_invoice_number = (self.supplier_invoice_number or "").strip() or None
        if self.supplier_invoice_number is None and self.purchase_invoice_id is None:
            raise ValueError("Give supplier_invoice_number or purchase_invoice_id")
        return self


class GRNLineOut(ORM):
    id: uuid.UUID
    po_line_id: uuid.UUID
    item_id: uuid.UUID
    unit_code: str
    quantity: Decimal
    rejected_quantity: Decimal
    quantity_base: Decimal
    unit_price: Decimal
    unit_cost: Decimal
    tax_rate: Decimal
    net: Decimal
    tax_amount: Decimal
    batch_id: uuid.UUID | None = None
    batch_no: str | None = None
    expiry_date: date | None = None
    returned_base: Decimal


class GRNOut(ORM):
    id: uuid.UUID
    outlet_id: uuid.UUID
    po_id: uuid.UUID
    supplier_id: uuid.UUID
    location_id: uuid.UUID
    number: str
    received_on: date
    supplier_invoice_no: str | None = None
    purchase_invoice_id: uuid.UUID | None = None  # the linked scanned supplier bill (Purchases), if any
    note: str | None = None
    subtotal: Decimal
    tax_total: Decimal
    total: Decimal
    lines: list[GRNLineOut] = []
    created_at: datetime | None = None

    @computed_field
    @property
    def supplier_invoice_number(self) -> str | None:  # same value as supplier_invoice_no (both names are accepted on input)
        return self.supplier_invoice_no


class ReturnLineIn(BaseModel):
    grn_line_id: uuid.UUID
    quantity: Decimal = Field(**Q)
    unit: str | None = Field(default=None, max_length=20)  # default: the item's base unit


class ReturnIn(BaseModel):
    idempotency_key: uuid.UUID
    grn_id: uuid.UUID
    reason: str = Field(min_length=1, max_length=300)
    lines: list[ReturnLineIn] = Field(min_length=1, max_length=200)


class ReturnLineOut(ORM):
    grn_line_id: uuid.UUID
    item_id: uuid.UUID
    quantity_base: Decimal
    unit_cost: Decimal
    net: Decimal
    tax_amount: Decimal
    batch_id: uuid.UUID | None = None


class ReturnOut(ORM):
    id: uuid.UUID
    grn_id: uuid.UUID
    supplier_id: uuid.UUID
    number: str
    reason: str
    subtotal: Decimal
    tax_total: Decimal
    total: Decimal
    lines: list[ReturnLineOut] = []


class SupplierEntryIn(BaseModel):
    idempotency_key: uuid.UUID
    amount: Decimal = Field(max_digits=12, decimal_places=2)  # payment: positive amount paid; adjustment: signed
    note: str | None = Field(default=None, max_length=300)
    entry_date: date | None = None
    kind: str = Field(default="payment", pattern="^(payment|adjustment)$")


class LedgerEntryOut(BaseModel):
    id: uuid.UUID
    entry_type: str
    amount: Decimal
    entry_date: date
    ref_type: str | None
    ref_id: uuid.UUID | None
    note: str | None
    created_at: datetime
    running_balance: Decimal


class SupplierLedgerOut(BaseModel):
    supplier_id: uuid.UUID
    supplier_name: str
    balance: Decimal
    entries: list[LedgerEntryOut]


class NegativeStockOut(BaseModel):
    item_id: uuid.UUID
    item_name: str
    unit: str
    location_id: uuid.UUID
    location_name: str
    balance: Decimal


class RecipeCostLine(BaseModel):
    item_id: uuid.UUID
    name: str
    quantity: Decimal
    unit: str
    unit_cost: Decimal | None
    cost: Decimal | None


class RecipeCostOut(BaseModel):
    menu_item_id: uuid.UUID
    recipe_version: int
    food_cost: Decimal
    price: Decimal | None
    food_cost_percent: Decimal | None
    complete: bool
    uncosted: list[str]
    lines: list[RecipeCostLine]
