import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models.core import MovementType, PurchaseStatus
from app.services import gemini
from app.schemas.common import ORM


def _blank_none(v):
    return (v.strip() or None) if isinstance(v, str) else v


def check_email(v: str | None) -> str | None:
    """Syntax check (no DNS lookup); blank = not given. Control characters (CR/LF header injection) are refused."""
    from email_validator import EmailNotValidError, validate_email
    v = _blank_none(v)
    if v is None:
        return None
    if not isinstance(v, str):  # a number / list / object sent as the email used to be a 500 (BREAK_BACKEND_REPORT.md)
        raise ValueError("Enter a valid email address")
    try:
        out = validate_email(v, check_deliverability=False).normalized
    except EmailNotValidError:
        raise ValueError("Enter a valid email address")
    if len(out) > 254 or any(ord(c) < 32 or ord(c) == 127 for c in out):
        raise ValueError("Enter a valid email address")
    return out


def _contact(v: str | None) -> str | None:
    if v is None:
        return None
    if not isinstance(v, str):  # a number / list / object used to be a 500 (mode="before" runs ahead of the str check)
        raise ValueError("Enter the contact's name as text")
    return " ".join(v.split())[:120] or None


class InventoryItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    base_unit: str = Field(pattern="^(g|ml|pcs)$")
    reorder_level: Decimal = Field(default=Decimal(0), ge=0)
    supplier_id: uuid.UUID | None = None  # "usual supplier" (gets the re-order email)
    reorder_quantity: Decimal | None = Field(default=None, gt=0)  # how much to ask for ...
    reorder_unit: str | None = Field(default=None, max_length=20)  # ... in this unit (default: the item's base unit)
    sku: str | None = Field(default=None, max_length=60)
    category: str | None = Field(default=None, max_length=60)
    tracks_batches: bool = False  # batch + expiry on receipt, FEFO consumption
    shelf_life_days: int | None = Field(default=None, ge=1, le=3650)


class BulkItemIn(BaseModel):
    """One row of a stock import. Only shape is checked here; per-row rules (units, duplicates) are checked in the
    service so every error can name its row."""
    name: str = Field(max_length=200)
    base_unit: str
    reorder_level: Decimal = Field(default=Decimal(0))  # in base units
    opening_quantity: Decimal | None = None
    opening_unit: str | None = Field(default=None, max_length=20)  # defaults to base_unit
    unit_cost: Decimal | None = None  # price per opening_unit (per base unit when there is no opening_unit)


class BulkItemsIn(BaseModel):
    items: list[BulkItemIn] = Field(min_length=1, max_length=500)
    idempotency_key: uuid.UUID
    strict: bool = False  # true: an already-existing name is a 409 instead of being reported in `existing`


class LastReceived(BaseModel):
    at: datetime
    quantity: Decimal  # base unit
    unit_cost: Decimal | None = None
    invoice_id: uuid.UUID | None = None
    invoice_number: str | None = None
    supplier_name: str | None = None


class ReorderEmailInfo(BaseModel):
    """The re-order email that covers this item's open low-stock alert."""
    id: uuid.UUID
    status: str  # queued | sent | failed
    kind: str  # auto | manual
    at: datetime


class InventoryItemOut(ORM):
    id: uuid.UUID
    name: str
    base_unit: str
    reorder_level: Decimal
    is_active: bool = True
    balance: Decimal = Decimal(0)
    low_stock: bool = False
    last_received: LastReceived | None = None
    supplier_id: uuid.UUID | None = None
    supplier_name: str | None = None
    supplier_manual: bool = False
    reorder_quantity: Decimal | None = None  # base unit
    suggested_quantity: Decimal = Decimal(0)  # what the re-order email would ask for now (base unit)
    reorder_email: ReorderEmailInfo | None = None
    sku: str | None = None
    category: str | None = None
    tracks_batches: bool = False
    shelf_life_days: int | None = None
    last_cost: Decimal | None = None  # latest purchase cost per base unit


class InventoryItemPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    base_unit: str | None = Field(default=None, pattern="^(g|ml|pcs)$")
    reorder_level: Decimal | None = Field(default=None, ge=0)
    is_active: bool | None = None
    supplier_id: uuid.UUID | None = None  # null = no usual supplier (a later confirmed invoice may set one again)
    reorder_quantity: Decimal | None = Field(default=None, gt=0)  # null = use the suggested quantity
    reorder_unit: str | None = Field(default=None, max_length=20)
    sku: str | None = Field(default=None, max_length=60)
    category: str | None = Field(default=None, max_length=60)
    tracks_batches: bool | None = None
    shelf_life_days: int | None = Field(default=None, ge=1, le=3650)


class BulkItemsOut(BaseModel):
    created: list[InventoryItemOut]
    existing: list[InventoryItemOut]
    movements: int
    replayed: bool = False


class MovementSource(BaseModel):
    kind: str  # purchase | sale | adjustment | wastage | count
    label: str
    invoice_id: uuid.UUID | None = None
    invoice_number: str | None = None
    supplier_name: str | None = None
    bill_id: uuid.UUID | None = None
    bill_invoice_number: str | None = None
    user_name: str | None = None
    reason: str | None = None


class MovementOut(ORM):
    id: uuid.UUID
    item_id: uuid.UUID
    movement_type: MovementType
    quantity: Decimal
    unit_cost: Decimal | None
    note: str | None
    ref_id: uuid.UUID | None
    created_at: str | None = None
    source: MovementSource | None = None
    location_id: uuid.UUID | None = None
    batch_id: uuid.UUID | None = None
    reason_code: str | None = None
    ref_type: str | None = None


class AdjustIn(BaseModel):
    idempotency_key: uuid.UUID
    item_id: uuid.UUID
    kind: MovementType
    quantity: Decimal  # signed for adjustment; magnitude for wastage
    unit: str
    reason: str = Field(min_length=3, max_length=300)


class CountLine(BaseModel):
    item_id: uuid.UUID
    counted: Decimal = Field(ge=0)
    unit: str


class CountIn(BaseModel):
    idempotency_key: uuid.UUID
    lines: list[CountLine] = Field(min_length=1)


class CountResultOut(BaseModel):
    item_id: uuid.UUID
    expected: Decimal
    counted: Decimal
    difference: Decimal


class IngredientIn(BaseModel):
    item_id: uuid.UUID
    quantity: Decimal = Field(gt=0)
    unit: str


class RecipeIn(BaseModel):
    menu_item_id: uuid.UUID
    ingredients: list[IngredientIn] = Field(min_length=1)


class IngredientOut(ORM):
    item_id: uuid.UUID
    quantity: Decimal


class RecipeOut(ORM):
    id: uuid.UUID
    menu_item_id: uuid.UUID
    version: int
    ingredients: list[IngredientOut]


class SupplierIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    trn: str | None = Field(default=None, max_length=30)  # the GSTIN, validated in the service
    phone: str | None = Field(default=None, max_length=30)  # normalised to +44... / +971... in the service
    email: str | None = Field(default=None, max_length=254)
    contact_name: str | None = Field(default=None, max_length=120)
    auto_reorder: bool = True  # automatic re-order emails to this supplier (only sent when it has an email)

    @field_validator("email", mode="before")
    @classmethod
    def _check_email(cls, v):
        return check_email(v)

    @field_validator("contact_name", mode="before")
    @classmethod
    def _check_contact(cls, v):
        return _contact(v)


class SupplierOut(ORM):
    id: uuid.UUID
    name: str
    trn: str | None
    phone: str | None
    email: str | None = None
    contact_name: str | None = None
    auto_reorder: bool = True
    is_active: bool = True


class SupplierPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    trn: str | None = Field(default=None, max_length=30)  # the GSTIN, validated in the service
    phone: str | None = Field(default=None, max_length=30)
    email: str | None = Field(default=None, max_length=254)
    contact_name: str | None = Field(default=None, max_length=120)
    auto_reorder: bool | None = None
    is_active: bool | None = None

    @field_validator("email", mode="before")
    @classmethod
    def _check_email(cls, v):
        return check_email(v)

    @field_validator("contact_name", mode="before")
    @classmethod
    def _check_contact(cls, v):
        return _contact(v)


class RecipeVersionIngredientOut(BaseModel):
    item_id: uuid.UUID
    name: str
    unit: str
    quantity: Decimal


class RecipeVersionOut(BaseModel):
    id: uuid.UUID
    version: int
    effective_from: datetime
    effective_to: datetime | None
    is_current: bool
    ingredients: list[RecipeVersionIngredientOut]


class PurchaseLineIn(BaseModel):
    description: str = Field(min_length=1, max_length=300)
    item_id: uuid.UUID | None = None
    quantity: Decimal = Field(gt=0)
    unit: str
    unit_price: Decimal = Field(ge=0)
    pack: dict | None = None  # derivation record from the OCR step; kept so the review screen can show/undo it
    needs_check: bool = False  # true until a human has confirmed the stock quantity
    check_reason: str | None = Field(default=None, max_length=300)
    exclude_from_stock: bool = False  # consumables / packaging: kept on the invoice, never posted to stock
    item_code: str | None = Field(default=None, max_length=50)
    vat_code: str | None = Field(default=None, max_length=10)
    vat_rate: Decimal | None = Field(default=None, ge=0, le=100)
    # Optional exact total. Accepted only when it equals quantity x unit_price up to the rounding of unit_price
    # (4 decimals); lets "2 bags @ 38.00" converted to "50 kg" keep its 76.00 total exactly.
    line_total: Decimal | None = Field(default=None, ge=0)


class PurchaseDraftIn(BaseModel):
    supplier_id: uuid.UUID | None = None
    invoice_number: str | None = Field(default=None, max_length=100)
    invoice_date: date | None = None
    document_type: str | None = Field(default=None, pattern="^(stock_purchase|expense|other)$")
    lines: list[PurchaseLineIn]
    # true: the lines now carry rupee amounts. Clears the 'not INR: needs manual conversion' flag of a bill read in another
    # currency (the invoice total becomes the sum of the lines; the tax read from the bill is dropped).
    amounts_in_inr: bool = False


class PurchaseLineOut(ORM):
    id: uuid.UUID
    description: str
    item_id: uuid.UUID | None
    quantity: Decimal
    unit: str
    unit_price: Decimal
    line_total: Decimal
    confidence: Decimal | None
    pack: dict | None = None
    needs_check: bool = False
    check_reason: str | None = None
    exclude_from_stock: bool = False
    item_code: str | None = None
    vat_code: str | None = None
    vat_rate: Decimal | None = None


class StockAdded(BaseModel):
    item_id: uuid.UUID
    item_name: str
    quantity: Decimal  # base unit
    unit: str  # base unit
    balance_before: Decimal
    balance_after: Decimal


class PurchaseOut(ORM):
    id: uuid.UUID
    supplier_id: uuid.UUID | None
    status: PurchaseStatus
    invoice_number: str | None
    invoice_date: date | None
    total: Decimal | None
    net: Decimal | None = None
    vat: Decimal | None = None
    supplier_name_raw: str | None = None
    supplier_vat_number: str | None = None
    document_type: str = "stock_purchase"
    confidence: Decimal | None
    error: str | None  # why reading the invoice failed, in plain words (never an exception text or a variable name)
    error_code: str | None = None  # ai_not_configured | ai_unavailable (null when there is no error)
    lines: list[PurchaseLineOut]
    created_at: datetime | None = None
    updated_at: datetime | None = None
    retry_extraction_allowed: bool = False
    bill: dict | None = None  # printed header details / tax rows / currency (INR or null), as read (display only)
    # {"code": "not_inr", "message": "not INR: needs manual conversion"} for a bill printed in another currency; null otherwise.
    currency_warning: dict | None = None
    stock_added: list[StockAdded] = []

    @model_validator(mode="after")
    def _plain_error(self):
        self.error_code = gemini.scan_error_code(self.error)
        self.error = gemini.public_scan_error(self.error)  # rows stored with raw exception text read as a plain sentence
        return self


class RecipeDraftIn(BaseModel):
    menu_item_ids: list[uuid.UUID] = Field(min_length=1, max_length=10)


class DraftIngredientOut(BaseModel):
    item_id: uuid.UUID
    name: str
    unit: str
    quantity: Decimal


class DraftMissingOut(BaseModel):
    name: str
    base_unit: str
    quantity: Decimal


class RecipeDraftOut(BaseModel):
    menu_item_id: uuid.UUID
    menu_item_name: str
    ingredients: list[DraftIngredientOut]
    missing: list[DraftMissingOut]
    warnings: list[str] = []


class RecipeDraftsOut(BaseModel):
    drafts: list[RecipeDraftOut]
    stock_items: int
