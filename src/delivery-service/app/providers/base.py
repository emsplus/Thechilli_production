import hmac
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from app.core.config import settings
from app.core.errors import Unauthorized
from app.core.security import hmac_hex


class ProviderError(Exception):
    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class InboundMessageEvent:
    phone_number_id: str
    provider_message_id: str
    from_number: str
    text: str
    kind: str = "text"  # text | location | audio | image | button | other
    lat: float | None = None
    lng: float | None = None
    place_name: str = ""  # location label / address the customer's phone attached to the pin
    media_id: str | None = None


@dataclass
class StatusEvent:
    """Delivery receipt for a message WE sent."""
    phone_number_id: str
    provider_message_id: str
    status: str  # sent | delivered | read | failed
    recipient: str = ""
    timestamp: int | None = None
    error_code: str | None = None
    error_title: str | None = None


@dataclass
class OutboundRequest:
    phone_number_id: str
    to: str
    template: str
    text: str
    params: dict = field(default_factory=dict)
    in_window: bool = True  # inside the 24 h customer-service window: free text allowed


def normalize_number(raw: str, default_cc: str | None = None) -> str:
    """Digits only, international form without '+'. A bare 10-digit national number gets the default country code."""
    d = "".join(ch for ch in str(raw) if ch.isdigit())
    d = d.removeprefix("00")
    cc = settings.whatsapp_default_country_code if default_cc is None else default_cc
    if cc and len(d) == 10:
        d = cc + d
    return d


class WhatsAppProvider(ABC):
    """Adapter boundary. Real providers (Meta Cloud API, BSPs) implement this; nothing else knows the vendor."""

    @abstractmethod
    def send(self, req: OutboundRequest) -> str:
        """Send and return the provider message id. Raise ProviderError(retryable=...) on failure."""

    @abstractmethod
    def parse_webhook(self, payload: dict) -> list[InboundMessageEvent]: ...

    def parse_statuses(self, payload: dict) -> list[StatusEvent]:
        return []

    def verify_webhook_signature(self, raw_body: bytes, signature_header: str) -> None:
        """Header-only X-Hub-Signature-256 (sha256=<hex>) over the raw body. Fails closed when unconfigured."""
        secret = settings.whatsapp_app_secret.get_secret_value()
        if not secret:
            raise Unauthorized("webhook signing is not configured", code="webhook_unconfigured", status=503)
        expected = "sha256=" + hmac_hex(secret, raw_body)
        if not hmac.compare_digest(expected.encode(), (signature_header or "").encode()):
            raise Unauthorized("invalid signature", code="bad_signature")
