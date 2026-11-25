"""Provider adapter interface. Real providers (Zomato, Swiggy, ONDC, own website) implement this; none are included
because we hold no partner credentials or verified API specs (see docs/DESIGN.md). Adapters raise TransientError for
retryable failures (network, 5xx, 429) and PermanentError for ones that will never succeed (4xx validation)."""
import hashlib
import hmac
from abc import ABC, abstractmethod
from collections.abc import Mapping
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field, model_validator

Money = Annotated[int, Field(ge=0, le=10**12)]  # minor units; never negative, bounded so BigInteger cannot overflow


class TransientError(Exception):
    pass


class PermanentError(Exception):
    pass


class ParseError(Exception):
    """Payload is signed/authentic but cannot be turned into a canonical order."""


class CanonicalItem(BaseModel):
    external_item_id: str = Field(min_length=1)
    name: str
    quantity: int = Field(gt=0, le=10_000)
    unit_price_minor: Money


class CanonicalOrder(BaseModel):
    external_order_id: str = Field(min_length=1)
    external_store_id: str = Field(min_length=1)
    placed_at: datetime
    fulfilment_type: str = "delivery"
    customer_name: str | None = None
    customer_phone: str | None = None
    notes: str | None = None
    currency: str = Field(min_length=3, max_length=3)
    items: list[CanonicalItem] = Field(min_length=1)
    subtotal_minor: Money
    tax_minor: Money = 0
    delivery_fee_minor: Money = 0
    discount_minor: Money = 0
    total_minor: Money

    @model_validator(mode="after")
    def _arithmetic(self):
        if sum(i.quantity * i.unit_price_minor for i in self.items) != self.subtotal_minor:
            raise ValueError("items do not add up to subtotal")
        if self.subtotal_minor + self.tax_minor + self.delivery_fee_minor - self.discount_minor != self.total_minor:
            raise ValueError("totals do not add up")
        if self.discount_minor > self.subtotal_minor + self.tax_minor + self.delivery_fee_minor:
            raise ValueError("discount exceeds the order value")
        return self


class MenuEntry(BaseModel):
    external_item_id: str
    name: str
    price_minor: Money
    available: bool = True


def hmac_sha256_hex(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


class ProviderAdapter(ABC):
    name: str

    @abstractmethod
    def verify_signature(self, headers: Mapping[str, str], body: bytes, secret: str) -> bool:
        """Authenticate an inbound webhook. MUST be constant-time and return False (never raise) on any problem."""

    @abstractmethod
    def webhook_timestamp(self, headers: Mapping[str, str]) -> float | None:
        """The signed send time (epoch seconds) of an inbound webhook, or None if absent/malformed. The signature
        scheme MUST cover this value, otherwise it cannot defend against replay."""

    @abstractmethod
    def parse_store_verification(self, payload: dict) -> tuple[str, str] | None:
        """If this authentic payload is the provider's store-ownership confirmation, return (external_store_id, code);
        else None. The code is the one we issued when the tenant claimed the store."""

    @abstractmethod
    def parse_order_webhook(self, payload: dict) -> CanonicalOrder:
        """Raise ParseError if the payload cannot be normalized."""

    @abstractmethod
    def push_status(self, external_order_id: str, status: str, reason: str | None = None) -> None:
        """status in: accepted | rejected | ready | dispatched | delivered | cancelled."""

    @abstractmethod
    def sync_menu(self, external_store_id: str, items: list[MenuEntry]) -> None: ...

    @abstractmethod
    def set_item_availability(self, external_store_id: str, external_item_id: str, available: bool) -> None: ...
