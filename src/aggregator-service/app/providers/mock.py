"""MOCK PROVIDER - for development and tests only. It is NOT a real marketplace and mimics no real API.
Wire format is invented here: HMAC-SHA256 hex of "<timestamp>.<raw body>" in `X-Mock-Signature`, epoch seconds in `X-Mock-Timestamp`."""
import hmac
import math
from collections.abc import Mapping

from pydantic import ValidationError

from app.providers.base import (
    CanonicalItem,
    CanonicalOrder,
    MenuEntry,
    ParseError,
    ProviderAdapter,
    hmac_sha256_hex,
)


class MockProvider(ProviderAdapter):
    name = "mock"

    def __init__(self):
        self.calls: list[tuple] = []
        self.fail_next: list[Exception] = []  # popped one per outbound call; lets tests simulate outages

    def _record(self, *call):
        if self.fail_next:
            raise self.fail_next.pop(0)
        self.calls.append(call)

    def verify_signature(self, headers: Mapping[str, str], body: bytes, secret: str) -> bool:
        h = {k.lower(): v for k, v in headers.items()}
        sig, ts = h.get("x-mock-signature"), h.get("x-mock-timestamp")
        if not sig or not ts or not secret:
            return False
        return hmac.compare_digest(sig, hmac_sha256_hex(secret, f"{ts}.".encode() + body))  # timestamp is signed

    def webhook_timestamp(self, headers: Mapping[str, str]) -> float | None:
        raw = {k.lower(): v for k, v in headers.items()}.get("x-mock-timestamp")
        try:
            ts = float(raw)
        except (TypeError, ValueError):
            return None
        return ts if math.isfinite(ts) else None

    def parse_store_verification(self, payload: dict):
        if payload.get("type") == "store.verify" and isinstance(payload.get("store_id"), str) \
                and isinstance(payload.get("code"), str):
            return payload["store_id"], payload["code"]
        return None

    def parse_order_webhook(self, payload: dict) -> CanonicalOrder:
        try:
            return CanonicalOrder(
                external_order_id=str(payload["order_id"]), external_store_id=str(payload["store_id"]),
                placed_at=payload["placed_at"], fulfilment_type=payload.get("type", "delivery"),
                customer_name=payload.get("customer", {}).get("name"),
                customer_phone=payload.get("customer", {}).get("phone"), notes=payload.get("notes"),
                currency=payload["currency"],
                items=[CanonicalItem(external_item_id=str(i["id"]), name=i["name"], quantity=i["qty"],
                                     unit_price_minor=i["price"]) for i in payload["items"]],
                subtotal_minor=payload["subtotal"], tax_minor=payload.get("tax", 0),
                delivery_fee_minor=payload.get("delivery_fee", 0), discount_minor=payload.get("discount", 0),
                total_minor=payload["total"])
        except (KeyError, TypeError, ValidationError, ValueError) as e:
            raise ParseError(str(e)) from e

    def push_status(self, external_order_id, status, reason=None):
        self._record("push_status", external_order_id, status, reason)

    def sync_menu(self, external_store_id, items: list[MenuEntry]):
        self._record("sync_menu", external_store_id, [i.model_dump() for i in items])

    def set_item_availability(self, external_store_id, external_item_id, available):
        self._record("set_item_availability", external_store_id, external_item_id, available)
