"""Invitation delivery behind a provider adapter. The mock provider never sends anything; it keeps an in-memory outbox
(tests, local dev). The webhook provider POSTs to a mail relay you operate. The invite link carries the raw token, so
messages are never logged or stored here: only status, provider and the provider's message id are recorded."""
from dataclasses import dataclass
from typing import Protocol

import httpx

from app.core.config import settings


@dataclass(frozen=True)
class InvitationMessage:
    to: str
    link: str
    expires_hours: int
    business_hint: str | None = None


@dataclass(frozen=True)
class DeliveryResult:
    provider: str
    message_id: str | None = None


class DeliveryError(Exception):
    pass


class DeliveryProvider(Protocol):
    name: str

    def send(self, msg: InvitationMessage) -> DeliveryResult: ...


class MockProvider:
    name = "mock"

    def __init__(self):
        self.outbox: list[InvitationMessage] = []
        self.fail: Exception | None = None

    def send(self, msg: InvitationMessage) -> DeliveryResult:
        if self.fail:
            raise self.fail
        self.outbox.append(msg)
        return DeliveryResult(self.name, f"mock-{len(self.outbox)}")


class WebhookProvider:
    name = "webhook"

    def send(self, msg: InvitationMessage) -> DeliveryResult:
        if not settings.delivery_webhook_url:
            raise DeliveryError("delivery webhook is not configured")
        try:
            r = httpx.post(settings.delivery_webhook_url, timeout=10,
                           headers={"Authorization": f"Bearer {settings.delivery_webhook_token.get_secret_value()}"},
                           json={"template": "signup_invitation", "to": msg.to, "link": msg.link,
                                 "expires_hours": msg.expires_hours})
        except httpx.HTTPError as e:
            raise DeliveryError(f"delivery provider unreachable: {type(e).__name__}") from e
        if r.status_code >= 300:
            raise DeliveryError(f"delivery provider error {r.status_code}")
        try:
            mid = str(r.json().get("id"))[:120]
        except ValueError:
            mid = None
        return DeliveryResult(self.name, mid)


_mock = MockProvider()


def get_delivery_provider() -> DeliveryProvider:
    """FastAPI dependency; tests override it."""
    return WebhookProvider() if settings.delivery_provider == "webhook" else _mock


def invite_link(token: str) -> str:
    return f"{settings.signup_base_url.rstrip('/')}/signup?token={token}"
