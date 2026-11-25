"""Per-key checklist payloads. extra="forbid" everywhere: unknown fields are rejected, so restaurant operational data
(staff names, salaries, menu items, prices, customer lists) cannot be smuggled into this service.
Staff = counts and planned roles only. Menu = item count and where it will come from. Documents = type, status and an
opaque reference to a file held elsewhere; never file contents."""
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


Kind = Literal["restaurant", "cafe", "bakery", "cloud_kitchen", "hotel_kitchen", "food_truck", "bar", "other"]


class BusinessTypeData(_M):
    # Descriptive kind (primary) plus optional further kinds (multi-select). Saving the item sets the application's platform
    # business_types to the mapped union (enums.platform_business_types: cafe/bakery/bar/... -> restaurant).
    business_type: Kind
    business_types: list[Kind] | None = Field(None, max_length=8)
    cuisine: str | None = Field(None, max_length=60)


class OutletData(_M):
    name: str = Field(min_length=1, max_length=120)
    city: str = Field(min_length=1, max_length=80)
    country: str = Field("IN", min_length=2, max_length=2)  # India first (docs/DECISIONS.md 2026-10-31)
    address_line: str | None = Field(None, max_length=200)
    timezone: str | None = Field(None, max_length=60)
    expected_tables: int | None = Field(None, ge=0, le=1000)


class MenuData(_M):
    source: Literal["manual", "upload", "pos_import"]
    item_count: int = Field(ge=0, le=100000)
    ready: bool = False


class StaffData(_M):
    staff_count: int = Field(ge=0, le=10000)
    planned_roles: list[Literal["owner", "manager", "cashier", "waiter", "kitchen"]] = []


class DocType(str, Enum):
    trade_licence = "trade_licence"
    owner_id = "owner_id"
    tax_certificate = "tax_certificate"
    other = "other"


class DocumentRef(_M):
    type: DocType
    status: Literal["received", "verified", "rejected"]
    reference: str = Field(min_length=1, max_length=120)  # opaque id in the document store, never content


class DocumentsData(_M):
    documents: list[DocumentRef] = []


REQUIRED_DOCS = {DocType.trade_licence, DocType.owner_id}
MODELS: dict[str, type[_M]] = {"business_type": BusinessTypeData, "outlet": OutletData, "menu": MenuData,
                               "staff": StaffData, "documents": DocumentsData}


def is_complete(key: str, data: _M) -> bool:
    """Deterministic completeness: whether the item counts as `done`."""
    if key == "menu":
        return data.ready and data.item_count > 0
    if key == "staff":
        return data.staff_count > 0
    if key == "documents":
        verified = {d.type for d in data.documents if d.status == "verified"}
        return REQUIRED_DOCS <= verified
    return True  # business_type / outlet: valid payload == complete
