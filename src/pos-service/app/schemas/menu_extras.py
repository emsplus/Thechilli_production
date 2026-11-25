"""Request / response shapes of modifier groups, combos and offers (docs/MODIFIERS_OFFERS.md)."""
import uuid
from datetime import date, time
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.core import OrderType

PAISE_LIMIT = 10_000_000  # +-1 lakh rupees per option is far beyond any real modifier


class ModifierOptionIn(BaseModel):
    id: uuid.UUID | None = None  # on PUT: an existing option of this group; omitted = new option
    name: str = Field(min_length=1, max_length=100)
    price_delta_paise: int = Field(default=0, ge=-PAISE_LIMIT, le=PAISE_LIMIT)
    is_default: bool = False
    sort_order: int | None = None  # default: position in the list


class ModifierGroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    min_select: int = Field(default=0, ge=0, le=50)
    max_select: int | None = Field(default=1, ge=1, le=50)  # null = no upper limit
    sort_order: int = 0
    options: list[ModifierOptionIn] = Field(min_length=1, max_length=50)


class ModifierOptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    price_delta_paise: int
    is_default: bool
    is_active: bool
    sort_order: int


class ModifierGroupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    min_select: int
    max_select: int | None
    sort_order: int
    is_active: bool
    options: list[ModifierOptionOut]  # active options only, unless include_inactive
    item_ids: list[uuid.UUID] = []    # items that offer this group


class ActiveIn(BaseModel):
    is_active: bool


class ItemGroupsIn(BaseModel):
    group_ids: list[uuid.UUID] = Field(max_length=20)  # in display order; [] removes every group


class ItemGroupsOut(BaseModel):
    item_id: uuid.UUID
    group_ids: list[uuid.UUID]


class ComboComponentIn(BaseModel):
    item_id: uuid.UUID
    variant_id: uuid.UUID | None = None
    quantity: int = Field(default=1, ge=1, le=99)


class ComboIn(BaseModel):
    components: list[ComboComponentIn] = Field(max_length=30)  # [] = not a combo any more


class ComboComponentOut(BaseModel):
    item_id: uuid.UUID
    name: str
    variant_id: uuid.UUID | None = None
    quantity: int


class ComboOut(BaseModel):
    item_id: uuid.UUID
    name: str
    price: Decimal
    is_active: bool
    components: list[ComboComponentOut]


class OfferIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["percent", "amount"]
    value: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    scope: Literal["bill", "item", "category"] = "bill"
    target_ids: list[uuid.UUID] | None = Field(default=None, max_length=200)  # item ids / category ids for scope item / category
    min_order_value: Decimal = Field(default=Decimal("0"), ge=0, max_digits=12, decimal_places=2)
    max_discount: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    days_of_week: list[int] | None = Field(default=None, max_length=7)  # 0 = Monday ... 6 = Sunday; null = every day
    start_time: time | None = None  # outlet-local "HH:MM"; both null = all day; start > end spans midnight
    end_time: time | None = None
    valid_from: date | None = None
    valid_to: date | None = None
    order_types: list[OrderType] | None = None  # null = every order type
    stackable: bool = False
    priority: int = Field(default=0, ge=-1000, le=1000)
    outlet_id: uuid.UUID | None = None  # null = every outlet
    is_active: bool = True

    @field_validator("days_of_week")
    @classmethod
    def _days(cls, v):
        if v and any(d < 0 or d > 6 for d in v):
            raise ValueError("days_of_week are 0 (Monday) to 6 (Sunday)")
        return v


class OfferOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    label: str = ""  # 'Offer: <name>', as printed on the bill
    kind: str
    value: Decimal
    scope: str
    target_ids: list[uuid.UUID] | None = None
    min_order_value: Decimal
    max_discount: Decimal | None = None
    days_of_week: list[int] | None = None
    start_time: time | None = None
    end_time: time | None = None
    valid_from: date | None = None
    valid_to: date | None = None
    order_types: list[str] | None = None
    stackable: bool
    priority: int
    outlet_id: uuid.UUID | None = None
    is_active: bool
