"""Payment-link provider for Chilli recharges (docs/CHILLI_WALLET.md).

ONE Razorpay account belongs to Chilli (keys from env CHILLI_RAZORPAY_KEY_ID / CHILLI_RAZORPAY_KEY_SECRET); it is not a
per-restaurant account and is unrelated to payments-service (which takes customers' money for restaurants).

`PaymentLinkProvider` is the seam: `RazorpayPaymentLinks` talks to Razorpay's `POST /v1/payment_links` (basic auth, amount in
paise); `FakePaymentLinks` is what tests and the local end-to-end run use (CHILLI_PAYMENT_PROVIDER=fake, refused in production).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

import httpx

from app.core import errors
from app.core.config import settings


@dataclass(frozen=True)
class LinkRequest:
    intent_id: str  # becomes Razorpay's reference_id
    tenant_id: str
    amount_paise: int
    description: str
    callback_url: str | None
    expire_by: datetime


@dataclass(frozen=True)
class Link:
    id: str
    short_url: str
    status: str = "created"


class PaymentLinkProvider(Protocol):
    def create_link(self, req: LinkRequest) -> Link:
        """Create a one-off payment link. Raises AppError 503 payment_provider_unavailable on any provider failure."""


def unavailable(why: str = "") -> errors.AppError:
    return errors.AppError(503, "payment_provider_unavailable",
                           "We could not reach the payment page just now. Please try again in a minute.")


class RazorpayPaymentLinks:
    def __init__(self, key_id: str, key_secret: str, base: str = "https://api.razorpay.com", transport: httpx.BaseTransport | None = None,
                 timeout: float = 15.0):
        self.key_id, self.key_secret, self.base, self.transport, self.timeout = key_id, key_secret, base.rstrip("/"), transport, timeout

    def body(self, req: LinkRequest) -> dict:
        b = {"amount": req.amount_paise, "currency": "INR", "accept_partial": False, "reference_id": req.intent_id,
             "description": req.description, "notify": {"sms": False, "email": False}, "reminder_enable": False,
             "notes": {"tenant_id": req.tenant_id, "topup_order_id": req.intent_id},
             "expire_by": int(req.expire_by.timestamp())}
        if req.callback_url:
            b.update(callback_url=req.callback_url, callback_method="get")
        return b

    def create_link(self, req: LinkRequest) -> Link:
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport) as c:
                r = c.post(f"{self.base}/v1/payment_links", json=self.body(req), auth=(self.key_id, self.key_secret))
            if r.status_code not in (200, 201):
                raise RuntimeError(f"razorpay answered {r.status_code}")
            d = r.json()
            return Link(id=str(d["id"]), short_url=str(d["short_url"]), status=str(d.get("status") or "created"))
        except errors.AppError:
            raise
        except Exception as e:  # noqa: BLE001 - network error, non-2xx, malformed body: all the same to the caller
            import logging
            logging.getLogger("app.wallet").warning("razorpay payment link failed: %s", type(e).__name__)
            raise unavailable() from e


class FakePaymentLinks:
    """Deterministic stand-in: no network. `links` records what was asked; `webhook_body` / `sign` build what Razorpay would send."""

    def __init__(self):
        self.links: list[LinkRequest] = []
        self.fail = False

    def create_link(self, req: LinkRequest) -> Link:
        if self.fail:
            raise unavailable()
        self.links.append(req)
        lid = "plink_fake" + uuid.uuid4().hex[:12]
        return Link(id=lid, short_url=f"https://rzp.fake/{lid}")


def sign(secret: str, raw: bytes) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def webhook_body(event: str, *, payment_id: str, amount_paise: int, link_id: str | None = None, reference_id: str | None = None,
                 tenant_id: str | None = None, status: str = "captured", currency: str = "INR") -> bytes:
    """The JSON Razorpay posts for `event` (shape per Razorpay's docs), for tests and the local end-to-end run."""
    notes = {k: v for k, v in (("tenant_id", tenant_id), ("topup_order_id", reference_id)) if v}
    pay = {"id": payment_id, "entity": "payment", "amount": amount_paise, "currency": currency, "status": status, "notes": notes}
    payload: dict = {"payment": {"entity": pay}}
    if event == "payment_link.paid":
        payload["payment_link"] = {"entity": {"id": link_id, "reference_id": reference_id, "amount": amount_paise,
                                              "amount_paid": amount_paise if status == "captured" else 0,
                                              "currency": currency, "status": "paid" if status == "captured" else "created",
                                              "notes": notes}}
    if event == "order.paid":
        payload["order"] = {"entity": {"id": "order_fake", "amount": amount_paise, "amount_paid": amount_paise, "status": "paid", "notes": notes}}
    return json.dumps({"entity": "event", "event": event, "contains": list(payload), "payload": payload}).encode()


_provider: PaymentLinkProvider | None = None
_lock = threading.Lock()


def set_provider(p: PaymentLinkProvider | None) -> None:
    """Install a provider (tests); None restores the one built from settings."""
    global _provider
    with _lock:
        _provider = p


def provider() -> PaymentLinkProvider:
    global _provider
    with _lock:
        if _provider is not None:
            return _provider
        if settings.chilli_payment_provider == "fake":
            if settings.env == "production":
                raise errors.AppError(503, "topup_unavailable", "Recharge is not set up yet. Contact Chilli support.")
            _provider = FakePaymentLinks()
            return _provider
        key, secret = settings.chilli_razorpay_key_id, settings.chilli_razorpay_key_secret.get_secret_value()
        if not key or not secret:
            raise errors.AppError(503, "topup_unavailable", "Recharge is not set up yet. Contact Chilli support.")
        _provider = RazorpayPaymentLinks(key, secret, settings.chilli_razorpay_api_base)
        return _provider
