import hashlib
import hmac
import json

import httpx

from app.core.errors import AppError, ProviderError
from app.providers.base import CollectResult, NormalizedEvent, ProviderPayment, ProviderRefund


def _payment(d: dict) -> ProviderPayment:
    status = {"captured": "captured", "failed": "failed"}.get(d.get("status"), "pending")
    return ProviderPayment(d["id"], status, int(d["amount"]), d["currency"])


def _refund(d: dict) -> ProviderRefund:
    status = {"processed": "processed", "failed": "failed"}.get(d.get("status"), "pending")
    return ProviderRefund(d["id"], status, int(d["amount"]))


class RazorpayAdapter:
    name = "razorpay"

    def __init__(self, *, key_id: str, key_secret: str, webhook_secret: str, base_url: str,
                 timeout: float = 15.0, transport: httpx.BaseTransport | None = None):
        self._webhook_secret = webhook_secret.encode()
        self._client = httpx.Client(base_url=base_url, auth=(key_id, key_secret), timeout=timeout, transport=transport)

    def _call(self, method: str, path: str, **kw) -> dict:
        try:
            r = self._client.request(method, path, **kw)
        except httpx.HTTPError as e:
            raise ProviderError(f"razorpay unreachable: {type(e).__name__}") from e
        if r.status_code >= 400:
            # Provider error text can echo request data; surface only status and the short error description.
            try:
                desc = r.json().get("error", {}).get("description", "")
            except ValueError:
                desc = ""
            raise ProviderError(f"razorpay rejected the request ({r.status_code}): {desc[:200]}",
                                definitive=r.status_code < 500)
        try:
            return r.json()
        except ValueError as e:
            raise ProviderError("razorpay returned a non-JSON response") from e

    def create_upi_qr(self, *, intent_id, amount, currency, description) -> CollectResult:
        d = self._call("POST", "/v1/payments/qr_codes", json={
            "type": "upi_qr", "usage": "single_use", "fixed_amount": True, "payment_amount": amount,
            "description": description[:100], "notes": {"intent_id": intent_id}})
        return CollectResult(provider_ref=d["id"], payment_url=None, qr_payload=d.get("image_url"))

    def create_payment_link(self, *, intent_id, amount, currency, description, reference) -> CollectResult:
        d = self._call("POST", "/v1/payment_links", json={
            "amount": amount, "currency": currency, "description": description[:2048], "upi_link": True,
            "reference_id": intent_id,  # our id round-trips in webhooks even if the link id is not yet stored
            "notes": {"intent_id": intent_id, "reference": reference[:200]}})
        return CollectResult(provider_ref=d["id"], payment_url=d.get("short_url"))

    def fetch_payment(self, provider_payment_id: str) -> ProviderPayment:
        return _payment(self._call("GET", f"/v1/payments/{provider_payment_id}"))

    def list_collection_payments(self, method: str, provider_ref: str) -> list[ProviderPayment]:
        """Payments made against a QR code / payment link, as the provider reports them."""
        if method == "upi_qr":
            d = self._call("GET", f"/v1/payments/qr_codes/{provider_ref}/payments", params={"count": 100})
            return [_payment(p) for p in d.get("items") or []]
        d = self._call("GET", f"/v1/payment_links/{provider_ref}")
        # The link document only lists payment ids/status/amount (no currency): confirm each via the payments API.
        return [self.fetch_payment(p["payment_id"]) for p in d.get("payments") or [] if p.get("payment_id")]

    def fetch_refund(self, provider_refund_id: str) -> ProviderRefund:
        return _refund(self._call("GET", f"/v1/refunds/{provider_refund_id}"))

    def create_refund(self, *, provider_payment_id, amount, refund_id, receipt) -> ProviderRefund:
        d = self._call("POST", f"/v1/payments/{provider_payment_id}/refund",
                       json={"amount": amount, "notes": {"refund_id": refund_id}, "receipt": receipt[:40]})
        return _refund(d)

    def find_refund_by_receipt(self, provider_payment_id: str, receipt: str) -> ProviderRefund | None:
        """Reconciliation after an unknown outcome: did the provider already create the refund for this receipt?"""
        d = self._call("GET", f"/v1/payments/{provider_payment_id}/refunds", params={"count": 100})
        for item in d.get("items") or []:
            if item.get("receipt") == receipt:
                return _refund(item)
        return None

    def verify_webhook(self, body: bytes, signature: str) -> bool:
        if not signature or not self._webhook_secret:
            return False
        expected = hmac.new(self._webhook_secret, body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected.encode(), signature.strip().encode("utf-8", "replace"))  # str compare raises on non-ASCII

    def parse_webhook(self, body: bytes, headers: dict[str, str]) -> NormalizedEvent:
        """Normalize a (signature-verified) webhook. The body is still attacker-shaped data until proven otherwise
        (a leaked secret, or a provider quirk): every field is type-checked and anything odd is a 400, never a 500."""
        try:
            p = json.loads(body)
        except ValueError as e:
            raise AppError("malformed webhook body", code="bad_webhook", status=400) from e
        if not isinstance(p, dict) or "event" not in p:
            raise AppError("malformed webhook body", code="bad_webhook", status=400)
        event = p["event"]
        event_id = headers.get("x-razorpay-event-id", "")
        if not event_id or len(event_id) > 128:
            raise AppError("missing or invalid event id", code="bad_webhook", status=400)
        pl = _d(p.get("payload"))
        pay = _d(_d(pl.get("payment")).get("entity"))
        ref_ent = _d(_d(pl.get("qr_code") or pl.get("payment_link")).get("entity"))
        ref = _d(_d(pl.get("refund")).get("entity"))
        notes = _d(pay.get("notes"))
        if event in ("payment.captured", "qr_code.credited", "payment_link.paid"):
            etype = "payment.captured"
        elif event == "payment.failed":
            etype = "payment.failed"
        elif event == "refund.processed":
            etype = "refund.processed"
        elif event == "refund.failed":
            etype = "refund.failed"
        else:
            etype = "ignored"
        src = ref if etype.startswith("refund") else pay
        return NormalizedEvent(
            event_id=event_id, event_type=etype,
            provider_payment_id=_s(pay.get("id")) or _s(ref.get("payment_id")),
            provider_ref=_s(ref_ent.get("id")), reference_id=_s(ref_ent.get("reference_id")),
            intent_id=_s(notes.get("intent_id")) or _s(_d(ref_ent.get("notes")).get("intent_id")),
            provider_refund_id=_s(ref.get("id")),
            amount=_amount(src.get("amount")),
            currency=_s(pay.get("currency"), 3))


def _d(v) -> dict:
    return v if isinstance(v, dict) else {}


def _s(v, limit: int = 64) -> str | None:
    """A short string id or None (wrong types and over-long values are treated as absent)."""
    return v if isinstance(v, str) and 0 < len(v) <= limit else None


def _amount(v) -> int | None:
    """Minor units as a JSON integer in a sane range, else None; floats/strings like "12.5" are malformed."""
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, int) or not 0 < v <= 10**12:
        raise AppError("malformed amount in webhook", code="bad_webhook", status=400)
    return v
