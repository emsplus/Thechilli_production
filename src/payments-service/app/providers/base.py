from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class CollectResult:
    provider_ref: str  # id of the QR code / payment link at the provider
    payment_url: str | None = None  # short link to pay
    qr_payload: str | None = None  # image url or UPI intent string to render as QR


@dataclass(frozen=True)
class ProviderPayment:
    provider_payment_id: str
    status: str  # normalized: captured | failed | pending
    amount: int
    currency: str


@dataclass(frozen=True)
class ProviderRefund:
    provider_refund_id: str
    status: str  # normalized: pending | processed | failed
    amount: int


@dataclass(frozen=True)
class NormalizedEvent:
    event_id: str
    event_type: str  # payment.captured | payment.failed | refund.processed | refund.failed | ignored
    provider_payment_id: str | None = None
    provider_ref: str | None = None  # qr / link id
    reference_id: str | None = None  # payment_link.reference_id (we set it to the intent id)
    intent_id: str | None = None  # from notes we set at creation
    provider_refund_id: str | None = None
    amount: int | None = None
    currency: str | None = None


class PaymentProvider(Protocol):
    """Provider-agnostic contract. Every method that talks to the provider authenticates with credentials the
    adapter was constructed with; the service layer never sees raw keys."""

    name: str

    def create_upi_qr(self, *, intent_id: str, amount: int, currency: str, description: str) -> CollectResult: ...
    def create_payment_link(self, *, intent_id: str, amount: int, currency: str, description: str,
                           reference: str) -> CollectResult: ...
    def fetch_payment(self, provider_payment_id: str) -> ProviderPayment: ...
    def list_collection_payments(self, method: str, provider_ref: str) -> list[ProviderPayment]: ...
    def fetch_refund(self, provider_refund_id: str) -> ProviderRefund: ...
    def create_refund(self, *, provider_payment_id: str, amount: int, refund_id: str,
                      receipt: str) -> ProviderRefund: ...
    def find_refund_by_receipt(self, provider_payment_id: str, receipt: str) -> ProviderRefund | None: ...
    def verify_webhook(self, body: bytes, signature: str) -> bool: ...
    def parse_webhook(self, body: bytes, headers: dict[str, str]) -> NormalizedEvent: ...
