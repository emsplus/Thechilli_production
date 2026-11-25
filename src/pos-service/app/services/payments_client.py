"""Client for payments-service (docs/PAYMENTS_INTEGRATION.md).

`PaymentsClient` is the seam: `HttpPaymentsClient` talks HTTP (short timeout, a fresh tenant-bound HS256 JWT per call),
`FakePaymentsClient` is the in-memory double used by the tests. The tenant is ALWAYS an argument and goes into the signed
`tid` claim, so one process can never speak for another tenant by accident. Amounts are integer minor units (paise).

Two failure classes, because they need different handling:
* `PaymentsUnavailable`: the outcome is UNKNOWN (connection refused, timeout, 5xx, bad answer). The request may have been
  executed; the caller keeps its record and retries with the SAME idempotency key / reconciles by sync.
* `PaymentsRejected`: payments-service answered 4xx. Definite: nothing was created (or the caller is wrong).
"""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Protocol

import httpx
import jwt

from app.core.config import settings

PAID_STATUSES = frozenset({"succeeded", "partially_refunded", "refunded"})


class PaymentsError(Exception):
    pass


class PaymentsUnavailable(PaymentsError):
    """Outcome unknown: do not assume the call did not happen."""


class PaymentsRejected(PaymentsError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message


@dataclass(frozen=True)
class RemoteIntent:
    id: uuid.UUID
    status: str
    amount: int
    currency: str
    captured_amount: int
    refunded_amount: int
    reference: str
    method: str
    payment_url: str | None = None
    qr_payload: str | None = None


@dataclass(frozen=True)
class RemoteAccount:
    id: uuid.UUID
    provider: str
    key_id_ref: str
    key_secret_ref: str
    webhook_secret_ref: str


@dataclass(frozen=True)
class RemoteUnallocated:
    intent_id: uuid.UUID
    provider_payment_id: str
    amount: int
    currency: str
    refunded: bool


class PaymentsClient(Protocol):
    def create_provider_account(self, tenant_id: str, *, provider: str, key_id_ref: str, key_secret_ref: str,
                                webhook_secret_ref: str) -> RemoteAccount: ...

    def create_intent(self, tenant_id: str, *, idempotency_key: str, amount: int, currency: str, method: str,
                      reference: str, description: str = "", provider_account_id: uuid.UUID | None = None) -> RemoteIntent: ...

    def get_intent(self, tenant_id: str, intent_id: uuid.UUID) -> RemoteIntent: ...

    def sync_intent(self, tenant_id: str, intent_id: uuid.UUID) -> RemoteIntent: ...

    def list_unallocated(self, tenant_id: str) -> list[RemoteUnallocated]: ...


def tenant_id_for(restaurant_id: uuid.UUID) -> str:
    """payments-service tenant ids are lowercase [a-z0-9-], at most 32 chars: the restaurant UUID without hyphens (32 chars)."""
    return restaurant_id.hex


def secret_prefix_for(restaurant_id: uuid.UUID) -> str:
    """The namespace payments-service requires for this tenant's secret references (app/core/security.py there)."""
    return f"PAY_SECRET_{tenant_id_for(restaurant_id).upper()}__"


def is_configured() -> bool:
    return bool(settings.payments_service_url.strip() and len(settings.payments_jwt_secret.get_secret_value().encode()) >= 32)


def mint_token(tenant_id: str, now: float | None = None) -> str:
    now = time.time() if now is None else now
    claims = {"tid": tenant_id, "aud": settings.payments_jwt_audience, "iat": int(now),
              "exp": int(now) + settings.payments_token_ttl_seconds}
    if settings.payments_jwt_issuer:
        claims["iss"] = settings.payments_jwt_issuer
    return jwt.encode(claims, settings.payments_jwt_secret.get_secret_value(), algorithm="HS256")


def _intent(d: dict) -> RemoteIntent:
    try:
        return RemoteIntent(id=uuid.UUID(d["id"]), status=d["status"], amount=int(d["amount"]), currency=d["currency"],
                            captured_amount=int(d.get("captured_amount") or 0), refunded_amount=int(d.get("refunded_amount") or 0),
                            reference=d.get("reference", ""), method=d.get("method", ""), payment_url=d.get("payment_url"),
                            qr_payload=d.get("qr_payload"))
    except (KeyError, ValueError, TypeError) as e:
        raise PaymentsUnavailable(f"unreadable answer from payments-service: {e}") from e


class HttpPaymentsClient:
    def __init__(self, base_url: str | None = None, timeout: float | None = None, transport: httpx.BaseTransport | None = None):
        self.base_url = (base_url or settings.payments_service_url).rstrip("/")
        self.timeout = settings.payments_timeout_seconds if timeout is None else timeout
        self._transport = transport

    def _request(self, tenant_id: str, method: str, path: str, *, json_body: dict | None = None,
                 idempotency_key: str | None = None) -> dict | list:
        headers = {"Authorization": f"Bearer {mint_token(tenant_id)}"}  # minted per call: never cached, never shared
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        try:
            with httpx.Client(timeout=self.timeout, transport=self._transport) as c:
                r = c.request(method, f"{self.base_url}/api/v1{path}", json=json_body, headers=headers)
        except httpx.HTTPError as e:  # timeouts, refused connections, resets: the request may or may not have run
            raise PaymentsUnavailable(f"payments-service unreachable: {type(e).__name__}") from e
        if r.status_code >= 500 or r.status_code in (401, 403, 429):
            # 401/403: OUR configuration is wrong (secret/audience), 429: throttled. Not a verdict on the payment.
            raise PaymentsUnavailable(f"payments-service answered {r.status_code}")
        try:
            body = r.json()
        except ValueError as e:
            raise PaymentsUnavailable("payments-service sent a non-JSON answer") from e
        if r.status_code >= 400:
            err = body.get("error", {}) if isinstance(body, dict) else {}
            raise PaymentsRejected(r.status_code, str(err.get("code", "error")), str(err.get("message", ""))[:300])
        return body

    def create_provider_account(self, tenant_id, *, provider, key_id_ref, key_secret_ref, webhook_secret_ref):
        d = self._request(tenant_id, "POST", "/provider-accounts", json_body={
            "provider": provider, "key_id_ref": key_id_ref, "key_secret_ref": key_secret_ref,
            "webhook_secret_ref": webhook_secret_ref})
        return RemoteAccount(id=uuid.UUID(d["id"]), provider=d["provider"], key_id_ref=d["key_id_ref"],
                             key_secret_ref=d["key_secret_ref"], webhook_secret_ref=d["webhook_secret_ref"])

    def create_intent(self, tenant_id, *, idempotency_key, amount, currency, method, reference, description="",
                      provider_account_id=None):
        body = {"amount": amount, "currency": currency, "method": method, "reference": reference, "description": description}
        if provider_account_id:
            body["provider_account_id"] = str(provider_account_id)
        return _intent(self._request(tenant_id, "POST", "/payment-intents", json_body=body, idempotency_key=idempotency_key))

    def get_intent(self, tenant_id, intent_id):
        return _intent(self._request(tenant_id, "GET", f"/payment-intents/{intent_id}"))

    def sync_intent(self, tenant_id, intent_id):
        return _intent(self._request(tenant_id, "POST", f"/payment-intents/{intent_id}/sync"))

    def list_unallocated(self, tenant_id):
        rows = self._request(tenant_id, "GET", "/unallocated-payments")
        return [RemoteUnallocated(intent_id=uuid.UUID(r["intent_id"]), provider_payment_id=r["provider_payment_id"],
                                  amount=int(r["amount"]), currency=r["currency"], refunded=bool(r["refunded"])) for r in rows]


# ------------------------------------------------------------------------------------------------ the dependency
_override: PaymentsClient | None = None


def set_client(client: PaymentsClient | None) -> None:
    """Process-wide override (tests, embedding). None restores the HTTP client built from settings."""
    global _override
    _override = client


def get_payments_client() -> PaymentsClient | None:
    """FastAPI dependency. None = online payments are not configured (no PAYMENTS_SERVICE_URL / secret)."""
    if _override is not None:
        return _override
    return HttpPaymentsClient() if is_configured() else None


# ------------------------------------------------------------------------------------------------ the test double
@dataclass
class _FakeIntent:
    tenant: str
    id: uuid.UUID
    key: str
    body_hash: str
    status: str
    amount: int
    currency: str
    method: str
    reference: str
    captured: int = 0
    payment_url: str | None = None
    qr_payload: str | None = None
    extra_payments: list[int] = field(default_factory=list)


class FakePaymentsClient:
    """In-memory payments-service with the real one's contract: tenant isolation (another tenant's ids are 404), idempotency
    keys (replay returns the same intent, a different body is 409), secret refs in the tenant's namespace, integer amounts.
    Money moves only through the `provider_*` helpers (what a verified webhook / provider fetch would do on the real side).
    Failure injection: `down` (every call fails), `fail_next(n)` (next n calls fail BEFORE running), `lose_next_answer(n)`
    (next n calls run, then time out: the nasty case)."""

    def __init__(self):
        self.intents: dict[uuid.UUID, _FakeIntent] = {}
        self.accounts: dict[uuid.UUID, tuple[str, RemoteAccount]] = {}
        self.calls: list[tuple[str, str]] = []  # (tenant, operation)
        self.down = False
        self._fail = 0
        self._lose = 0

    # ---- failure injection
    def fail_next(self, n: int = 1):
        self._fail = n

    def lose_next_answer(self, n: int = 1):
        self._lose = n

    def _enter(self, tenant: str, op: str):
        self.calls.append((tenant, op))
        if self.down:
            raise PaymentsUnavailable("fake: down")
        if self._fail > 0:
            self._fail -= 1
            raise PaymentsUnavailable("fake: connection refused")

    def _leave(self, value):
        if self._lose > 0:
            self._lose -= 1
            raise PaymentsUnavailable("fake: timed out")
        return value

    # ---- PaymentsClient
    def create_provider_account(self, tenant_id, *, provider, key_id_ref, key_secret_ref, webhook_secret_ref):
        self._enter(tenant_id, "create_provider_account")
        prefix = f"PAY_SECRET_{tenant_id.upper().replace('-', '_')}__"
        for ref in (key_id_ref, key_secret_ref, webhook_secret_ref):
            if not ref.startswith(prefix) or len(ref) == len(prefix):
                raise PaymentsRejected(422, "invalid_secret_ref", f"secret reference must be an env var name starting with {prefix}")
        acc = RemoteAccount(uuid.uuid4(), provider, key_id_ref, key_secret_ref, webhook_secret_ref)
        self.accounts[acc.id] = (tenant_id, acc)
        return self._leave(acc)

    def create_intent(self, tenant_id, *, idempotency_key, amount, currency, method, reference, description="",
                      provider_account_id=None):
        self._enter(tenant_id, "create_intent")
        if isinstance(amount, bool) or not isinstance(amount, int) or amount < 100:
            raise PaymentsRejected(422, "validation_error", "amount must be an integer number of paise, at least 100")
        if method == "upi_qr" and currency != "INR":
            raise PaymentsRejected(422, "validation_error", "UPI QR supports INR only")
        if provider_account_id is not None and self.accounts.get(provider_account_id, ("", None))[0] != tenant_id:
            raise PaymentsRejected(404, "not_found", "provider account not found")
        h = hashlib.sha256(json.dumps([amount, currency, method, reference, str(provider_account_id)]).encode()).hexdigest()
        for i in self.intents.values():
            if i.tenant == tenant_id and i.key == idempotency_key:
                if i.body_hash != h:
                    raise PaymentsRejected(409, "idempotency_conflict", "Idempotency-Key reused with a different body")
                return self._leave(self._view(i))
        i = _FakeIntent(tenant_id, uuid.uuid4(), idempotency_key, h, "pending", amount, currency, method, reference)
        if method == "upi_qr":
            i.qr_payload = f"https://fake.pay/qr/{i.id}.png"
        else:
            i.payment_url = f"https://fake.pay/l/{i.id}"
        self.intents[i.id] = i
        return self._leave(self._view(i))

    def _get(self, tenant_id: str, intent_id: uuid.UUID) -> _FakeIntent:
        i = self.intents.get(intent_id)
        if i is None or i.tenant != tenant_id:
            raise PaymentsRejected(404, "not_found", "payment intent not found")
        return i

    def get_intent(self, tenant_id, intent_id):
        self._enter(tenant_id, "get_intent")
        return self._leave(self._view(self._get(tenant_id, intent_id)))

    def sync_intent(self, tenant_id, intent_id):
        self._enter(tenant_id, "sync_intent")
        return self._leave(self._view(self._get(tenant_id, intent_id)))

    def list_unallocated(self, tenant_id):
        self._enter(tenant_id, "list_unallocated")
        return self._leave([RemoteUnallocated(i.id, f"pay_x{n}", amt, i.currency, False)
                            for i in self.intents.values() if i.tenant == tenant_id
                            for n, amt in enumerate(i.extra_payments)])

    @staticmethod
    def _view(i: _FakeIntent) -> RemoteIntent:
        return RemoteIntent(i.id, i.status, i.amount, i.currency, i.captured, 0, i.reference, i.method, i.payment_url, i.qr_payload)

    # ---- the provider side (test helpers)
    def provider_pays(self, intent_id: uuid.UUID, amount: int | None = None):
        """A verified provider event: the customer paid `amount` (default: the intent's amount). Duplicates are harmless."""
        i = self.intents[intent_id]
        i.captured = i.amount if amount is None else amount
        i.status = "succeeded"

    def provider_fails(self, intent_id: uuid.UUID):
        i = self.intents[intent_id]
        if i.status != "succeeded":
            i.status = "failed"

    def provider_extra_payment(self, intent_id: uuid.UUID, amount: int):
        """A second payment on an already paid QR: payments-service keeps it as unallocated, captured_amount does not change."""
        self.intents[intent_id].extra_payments.append(amount)
