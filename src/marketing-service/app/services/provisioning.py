"""Outbound interface to platform-core, which owns tenant creation.

Real client: `PlatformCoreClient` calls platform-core's OpenAPI (`/openapi.json` of platform-core):

    POST {PROVISIONING_BASE_URL}/onboarding/applications     (body ApplicationIn, incl. business_types: one or
                                                              more of restaurant | cloud_kitchen | hotel_kitchen)
    X-Service-Key: {PROVISIONING_SERVICE_KEY}                (service client holding scope `onboarding.submit`)
    Idempotency-Key: {application id}                        (platform-core scopes it per source, repeats return the
                                                              same application with duplicate=true)
    -> 201 {id, status: "received", ...}      id is stored here as the opaque external_business_id
    400/409/422 = rejected (not retried); 429/5xx/timeout/not configured = unavailable (retry later)

Platform-core then runs its own approval -> provisioning -> provisioned state machine. This service only mirrors
the reported status (`fetch_status`): GET /onboarding/applications/{id} and GET /tenants/{tenant_id}/subscription.
Those two reads are currently staff-only in platform-core (a service key gets 403), so status refresh answers 502 until
platform-core grants a service scope for them; submission works today.

Only descriptive onboarding data crosses this boundary. Nothing restaurant-side comes back; only an opaque id and two
status strings are stored.
"""
from dataclasses import dataclass, field
from typing import Protocol

import httpx

from app.core.config import settings


class ProvisioningError(Exception):
    """The provisioning service rejected the request (4xx). Not retryable without changing the data."""


class ProvisioningUnavailable(Exception):
    """Not configured, unreachable, rate limited or 5xx. Retryable."""


@dataclass(frozen=True)
class ProvisioningRequest:
    idempotency_key: str  # onboarding application id
    source: str  # "assisted" | "self_signup"
    business_name: str
    business_types: list[str]  # platform selection, canonical order (application.business_types)
    owner_name: str
    owner_email: str
    owner_phone: str | None
    outlet: dict = field(default_factory=dict)  # name, city, country, address_line, timezone, expected_tables
    menu_source: str | None = None  # "manual" | "upload" | "pos_import" (no menu contents are sent or kept here)
    referral_code: str | None = None
    marketing_ref: dict = field(default_factory=dict)  # application_id, lead_id, agent_id: opaque correlation ids


@dataclass(frozen=True)
class ProvisioningResult:
    business_id: str
    status: str = "provisioned"


@dataclass(frozen=True)
class PlatformStatus:
    activation: str  # platform-core application status: received .. provisioned | failed | rejected
    billing: str | None  # subscription status: trialing | active | past_due | cancelled | expired | None (none yet)


class ProvisioningClient(Protocol):
    def provision(self, request: ProvisioningRequest) -> ProvisioningResult: ...

    def fetch_status(self, business_id: str) -> PlatformStatus: ...


def to_platform_payload(r: ProvisioningRequest) -> dict:
    """Map our request onto platform-core's ApplicationIn."""
    outlet = r.outlet or {}
    city = outlet.get("city")
    return {"business_name": r.business_name[:200], "business_types": list(r.business_types),
            "contact_name": r.owner_name, "email": r.owner_email,
            "phone": (r.owner_phone or None) and r.owner_phone[:20], "city": city,
            "outlets": [{"name": outlet.get("name") or r.business_name[:200], "city": city}],
            "marketing_ref": r.marketing_ref.get("application_id"), "idempotency_key": r.idempotency_key}


class PlatformCoreClient:
    SUBMIT_PATH = "/onboarding/applications"

    def _call(self, method: str, path: str, **kw) -> httpx.Response:
        if not settings.provisioning_base_url:
            raise ProvisioningUnavailable("platform-core is not configured")
        headers = {"X-Service-Key": settings.provisioning_service_key.get_secret_value(), **kw.pop("headers", {})}
        try:
            return httpx.request(method, settings.provisioning_base_url.rstrip("/") + path, headers=headers,
                                 timeout=settings.provisioning_timeout, **kw)
        except httpx.HTTPError as e:
            raise ProvisioningUnavailable(f"platform-core unreachable: {type(e).__name__}") from e

    def provision(self, request: ProvisioningRequest) -> ProvisioningResult:
        r = self._call("POST", self.SUBMIT_PATH, json=to_platform_payload(request),
                       headers={"Idempotency-Key": request.idempotency_key})
        if r.status_code >= 500 or r.status_code == 429:
            raise ProvisioningUnavailable(f"platform-core error {r.status_code}")
        if r.status_code not in (200, 201):
            raise ProvisioningError(f"platform-core rejected the request ({r.status_code})")
        try:
            body = r.json()
            return ProvisioningResult(business_id=str(body["id"]), status=str(body.get("status", "received")))
        except (ValueError, KeyError, TypeError) as e:
            raise ProvisioningError("platform-core response missing id") from e

    def fetch_status(self, business_id: str) -> PlatformStatus:
        r = self._call("GET", f"{self.SUBMIT_PATH}/{business_id}")
        if r.status_code >= 500:
            raise ProvisioningUnavailable(f"platform-core error {r.status_code}")
        if r.status_code != 200:
            raise ProvisioningError(f"platform-core status read refused ({r.status_code})")
        try:
            body = r.json()
            activation, tenant_id = str(body["status"]), body.get("tenant_id")
        except (ValueError, KeyError, TypeError) as e:
            raise ProvisioningError("platform-core status response malformed") from e
        billing = None
        if tenant_id:
            s = self._call("GET", f"/tenants/{tenant_id}/subscription")
            if s.status_code >= 500:
                raise ProvisioningUnavailable(f"platform-core error {s.status_code}")
            if s.status_code == 200:
                cur = (s.json() or {}).get("current")
                billing = str(cur["status"]) if cur else None
        return PlatformStatus(activation=activation, billing=billing)


class FakePlatformClient:
    """In-process stand-in for platform-core (tests, local development). Records requests, can be told to fail,
    and reports whatever `statuses` says (default: provisioned/trialing)."""

    def __init__(self):
        self.calls: list[ProvisioningRequest] = []
        self.fail: Exception | None = None
        self.status_fail: Exception | None = None
        self.statuses: dict[str, PlatformStatus] = {}
        self.default_status = PlatformStatus("provisioned", "trialing")

    def provision(self, request: ProvisioningRequest) -> ProvisioningResult:
        self.calls.append(request)
        if self.fail:
            raise self.fail
        return ProvisioningResult(business_id=f"biz_{request.idempotency_key[:8]}", status="received")

    def fetch_status(self, business_id: str) -> PlatformStatus:
        if self.status_fail:
            raise self.status_fail
        return self.statuses.get(business_id, self.default_status)


def get_provisioning_client() -> ProvisioningClient:
    """FastAPI dependency; tests override it with FakePlatformClient."""
    return PlatformCoreClient()
