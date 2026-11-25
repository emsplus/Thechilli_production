"""Provisioning call-out to pos-service (contract: docs/PROVISIONING.md, shared JSON examples in docs/contract/).

`HttpProvisioner` is the real client: httpx, a timeout, retries with the SAME Idempotency-Key (the application id) on transport
errors / 5xx / 429, and a classification of failures into retryable and permanent. `FakeProvisioner` is the in-memory double
for tests and demos. Secrets (the provisioning key, the owner invite token) never appear in logs, exceptions or reprs."""
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable, Literal, Protocol

import httpx

from app.core.config import settings

log = logging.getLogger("app.provisioner")


@dataclass
class ProvisionRequest:
    idempotency_key: str  # the onboarding application id; pos-service treats repeats as the same request
    tenant_id: str  # becomes the pos-service restaurant id
    tenant_slug: str
    business_name: str
    owner_name: str
    owner_email: str
    plan_code: str | None
    outlets: list[dict] = field(default_factory=list)  # the first one becomes the first outlet
    country: Literal["IN"] = "IN"  # India only, INR only (docs/INR_ONLY.md)
    # one or more of restaurant | cloud_kitchen | hotel_kitchen (canonical order); pos-service derives capabilities from them
    business_types: list[str] = field(default_factory=lambda: ["restaurant"])
    timezone: str | None = None
    currency: Literal["INR"] | None = None
    gstin: str | None = None
    entitlement_hints: dict | None = None

    def to_payload(self) -> dict:
        """The exact JSON body of POST /internal/provision/tenants (docs/contract/provision_request.json)."""
        first = self.outlets[0] if self.outlets else {}
        outlet = {"name": first.get("name") or self.business_name}
        addr = ", ".join(x for x in (first.get("address"), first.get("city")) if x)
        if addr:
            outlet["address"] = addr
        if first.get("phone"):
            outlet["phone"] = first["phone"]
        body = {"tenant_id": self.tenant_id, "business_name": self.business_name, "country": self.country,
                "business_types": list(self.business_types), "owner": {"name": self.owner_name, "email": self.owner_email}, "outlet": outlet}
        for k, v in (("timezone", self.timezone), ("currency", self.currency), ("gstin", self.gstin),
                     ("plan_code", self.plan_code), ("entitlement_hints", self.entitlement_hints)):
            if v is not None:
                body[k] = v
        return body


@dataclass
class ProvisionResult:
    pos_tenant_ref: str
    outlet_refs: list[str] = field(default_factory=list)
    owner_user_ref: str | None = None
    invite_token: str | None = field(default=None, repr=False)  # None once the owner has accepted
    invite_expires_at: str | None = None
    invite_status: str = "pending"  # pending | accepted
    replayed: bool = False


@dataclass
class PosTenantStatus:
    tenant_id: str
    owner_invite_status: str  # none | pending | expired | accepted


class ProvisioningError(Exception):
    """`code` is a short stable machine code (no secrets, no response bodies); `retryable` False = needs a human."""
    def __init__(self, message: str, code: str = "provisioning_failed", retryable: bool = True):
        super().__init__(message)
        self.code, self.retryable = code, retryable


class Provisioner(Protocol):
    def provision(self, req: ProvisionRequest) -> ProvisionResult: ...
    def status(self, tenant_id: str) -> PosTenantStatus | None: ...
    def set_business_types(self, tenant_id: str, business_types: list[str], reason: str | None = None) -> bool: ...


# ------------------------------------------------------------------------------------------------ http
class HttpProvisioner:
    def __init__(self, base_url: str | None = None, key: str | None = None, timeout: float | None = None,
                 retries: int | None = None, backoff: float | None = None, transport: httpx.BaseTransport | None = None,
                 sleep: Callable[[float], None] = time.sleep):
        self.base_url = (base_url if base_url is not None else settings.pos_service_url).rstrip("/")
        self._key = key if key is not None else settings.pos_provision_key.get_secret_value()
        self.timeout = settings.pos_timeout_seconds if timeout is None else timeout
        self.retries = settings.pos_call_retries if retries is None else retries
        self.backoff = settings.pos_call_backoff_seconds if backoff is None else backoff
        self._transport, self._sleep = transport, sleep

    def __repr__(self):  # the key must not leak through a repr
        return f"HttpProvisioner(base_url={self.base_url!r})"

    def _request(self, method: str, path: str, *, json=None, idempotency_key: str | None = None) -> httpx.Response:
        if not self.base_url or not self._key:
            raise ProvisioningError("pos-service is not configured (POS_SERVICE_URL / POS_PROVISION_KEY)", "not_configured", False)
        headers = {"X-Provision-Key": self._key}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        last = "unknown"
        for attempt in range(self.retries + 1):
            if attempt:
                self._sleep(self.backoff * 2 ** (attempt - 1))
            try:
                with httpx.Client(timeout=self.timeout, transport=self._transport) as c:
                    r = c.request(method, self.base_url + path, json=json, headers=headers)
            except httpx.HTTPError as e:  # timeouts, connection errors
                last = type(e).__name__
                log.warning("pos-service %s %s failed: %s (try %d)", method, path.split("/tenants")[0], last, attempt + 1)
                continue
            if r.status_code in (408, 425, 429) or r.status_code >= 500:
                last = f"http_{r.status_code}"
                log.warning("pos-service answered %s (try %d)", r.status_code, attempt + 1)
                continue
            return r
        raise ProvisioningError(f"pos-service unreachable or failing ({last}) after {self.retries + 1} tries", "pos_unavailable", True)

    @staticmethod
    def _permanent(r: httpx.Response) -> ProvisioningError:
        try:
            code = (r.json().get("error") or {}).get("code") or "rejected"
        except (ValueError, AttributeError):
            code = "rejected"
        mapped = {401: "pos_auth", 403: "pos_auth"}.get(r.status_code, f"pos_{code}"[:48])
        return ProvisioningError(f"pos-service refused the request (HTTP {r.status_code}, {code})", mapped, False)

    def provision(self, req: ProvisionRequest) -> ProvisionResult:
        r = self._request("POST", "/internal/provision/tenants", json=req.to_payload(), idempotency_key=req.idempotency_key)
        if r.status_code not in (200, 201):
            raise self._permanent(r)
        try:
            d = r.json()
            inv = d["owner"]["invite"]
            return ProvisionResult(
                pos_tenant_ref=str(d["tenant_id"]), outlet_refs=[str(d["outlet_id"])], owner_user_ref=str(d["owner_user_id"]),
                invite_token=inv.get("token"), invite_expires_at=inv.get("expires_at"), invite_status=inv["status"],
                replayed=bool(d.get("replayed")))
        except (ValueError, KeyError, TypeError, AttributeError):
            raise ProvisioningError("pos-service returned an unexpected response", "pos_bad_response", True) from None

    def status(self, tenant_id: str) -> PosTenantStatus | None:
        r = self._request("GET", f"/internal/provision/tenants/{tenant_id}/status")
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise self._permanent(r)
        try:
            d = r.json()
            return PosTenantStatus(str(d["tenant_id"]), (d.get("owner") or {}).get("invite_status", "none"))
        except (ValueError, KeyError, TypeError, AttributeError):
            raise ProvisioningError("pos-service returned an unexpected response", "pos_bad_response", True) from None


    def set_business_types(self, tenant_id: str, business_types: list[str], reason: str | None = None) -> bool:
        """Staff change of an already provisioned tenant: PUT /internal/provision/tenants/{id}/business-types (scope
        provision.create). False = pos-service does not know the tenant (404)."""
        body = {"business_types": list(business_types), **({"reason": reason[:300]} if reason else {})}
        r = self._request("PUT", f"/internal/provision/tenants/{tenant_id}/business-types", json=body)
        if r.status_code == 404:
            return False
        if r.status_code != 200:
            raise self._permanent(r)
        return True


# ------------------------------------------------------------------------------------------------ fake
class FakeProvisioner:
    """In-memory pos-service. Idempotent per key like the real one (a replay re-issues the invite token). A business name
    containing FAIL_PROVISION fails permanently-looking-but-retryable (the demo/test failure hook); `fail_next` makes the next N
    calls raise ProvisioningError(code, retryable)."""
    def __init__(self):
        self.calls: list[ProvisionRequest] = []
        self.tenants: dict[str, dict] = {}
        self.fail_next = 0
        self.fail_code, self.fail_retryable = "pos_unavailable", True
        self._n = 0

    def provision(self, req: ProvisionRequest) -> ProvisionResult:
        self.calls.append(req)
        if "FAIL_PROVISION" in req.business_name:
            raise ProvisioningError("fake: simulated pos-service failure", "simulated", True)
        if self.fail_next > 0:
            self.fail_next -= 1
            raise ProvisioningError("fake: scripted failure", self.fail_code, self.fail_retryable)
        t = self.tenants.setdefault(req.tenant_id, {
            "outlet": str(uuid.uuid5(uuid.NAMESPACE_URL, "outlet:" + req.tenant_id)),
            "owner": str(uuid.uuid5(uuid.NAMESPACE_URL, "owner:" + req.tenant_id)), "accepted": False})
        self._n += 1
        token = None if t["accepted"] else f"{req.tenant_id}.fake-secret-{self._n}"
        t["token"] = token
        return ProvisionResult(req.tenant_id, [t["outlet"]], t["owner"], token, "2099-01-01T00:00:00+00:00",
                               "accepted" if t["accepted"] else "pending", replayed=self._n > 1)

    def status(self, tenant_id: str) -> PosTenantStatus | None:
        t = self.tenants.get(tenant_id)
        return None if t is None else PosTenantStatus(tenant_id, "accepted" if t["accepted"] else "pending")

    def set_business_types(self, tenant_id: str, business_types: list[str], reason: str | None = None) -> bool:
        if self.fail_next > 0:
            self.fail_next -= 1
            raise ProvisioningError("fake: scripted failure", self.fail_code, self.fail_retryable)
        t = self.tenants.get(tenant_id)
        if t is None:
            return False
        t["business_types"] = list(business_types)
        return True

    def accept_invite(self, tenant_id: str) -> None:  # test helper: the owner set a password
        self.tenants[tenant_id]["accepted"] = True


_override: Provisioner | None = None
_fake: FakeProvisioner | None = None


def set_provisioner(p: Provisioner | None) -> None:
    global _override, _fake
    _override = p
    _fake = None


def get_provisioner() -> Provisioner:
    global _fake
    if _override is not None:
        return _override
    if settings.provisioner == "fake":
        _fake = _fake or FakeProvisioner()
        return _fake
    if settings.provisioner == "http":
        return HttpProvisioner()
    raise RuntimeError(f"Unsupported PROVISIONER={settings.provisioner!r}; use 'http' or 'fake'")
