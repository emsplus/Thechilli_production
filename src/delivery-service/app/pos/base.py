from abc import ABC, abstractmethod
from dataclasses import dataclass


class PosError(Exception):
    """Base for pos-service failures."""


class PosUnavailable(PosError):
    """Network/5xx: retryable."""


class PosRejected(PosError):
    def __init__(self, message: str, status: int = 422, code: str = "rejected"):
        super().__init__(message)
        self.status, self.code = status, code


class PriceChanged(PosError):
    def __init__(self, lines: list[dict]):
        super().__init__("price_changed")
        self.lines = lines  # [{item_id, new_price}]


class IdempotencyConflict(PosError):
    """Same Idempotency-Key with a different body."""


@dataclass
class PosOrderLine:
    item_id: str
    quantity: int
    expected_unit_price: int
    variant_id: str | None = None
    note: str = ""


class PosClient(ABC):
    """The ONLY door to pos-service. Implementations: HttpPosClient (real), FakePosClient (tests)."""

    @abstractmethod
    def get_menu(self, restaurant_id: str, outlet_id: str | None = None) -> dict:
        """{menu_version, categories:[..], items:[{id,name,price,currency,is_active,variants,description,food_type,
        image_url,sort_order}]}"""

    @abstractmethod
    def get_config(self, restaurant_id: str, outlet_id: str | None = None) -> dict: ...

    @abstractmethod
    def create_order(self, restaurant_id: str, idempotency_key: str, body: dict) -> dict:
        """Returns {order_id, order_code, total, subtotal, delivery_fee, tax, status, version}. Raises PriceChanged,
        IdempotencyConflict, PosRejected, PosUnavailable."""

    @abstractmethod
    def get_order(self, restaurant_id: str, order_id: str) -> dict: ...

    @abstractmethod
    def cancel_order(self, restaurant_id: str, order_id: str, reason: str) -> None: ...

    @abstractmethod
    def dispatch(self, restaurant_id: str, order_id: str) -> None:
        """out_for_delivery. Idempotent by (order_id, status)."""

    @abstractmethod
    def delivered(self, restaurant_id: str, order_id: str) -> None:
        """delivered. Idempotent by (order_id, status)."""
