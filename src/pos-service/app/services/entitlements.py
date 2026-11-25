"""Entitlements (docs/ENTITLEMENTS.md): what platform-core says a tenant may use, with a per-tenant cache that survives a
platform-core outage. Contract: platform-core/docs/entitlements-contract.md (GET /tenants/{ref}/entitlements)."""
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Protocol

import httpx
from fastapi import HTTPException

from app.core.config import settings

log = logging.getLogger("app.entitlements")

STATUSES = ("active", "suspended", "past_due")


class EntitlementError(HTTPException):
    """A refusal with a stable machine code (`error.code` in the body, see core/errors.py)."""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(status_code, message)
        self.code = code


@dataclass(frozen=True)
class Entitlements:
    status: str = "active"  # active | suspended | past_due
    status_reason: str = "ok"
    plan_code: str | None = None
    plan_name: str | None = None
    outlet_limit: int | None = None  # None = unlimited, 0 = none
    features: dict = field(default_factory=dict)  # code -> {"enabled": bool, "limit": int | None}
    version: str = ""
    # Where this answer came from: live | cached | stale (platform-core unreachable, last known applies) | grace_expired
    # (outage lasted longer than the grace period: read-only) | unmanaged (tenant unknown to platform-core, policy allow).
    source: str = "live"
    # platform-core's PAYG wallet block (docs/PAYG_BILLING.md "billing block"); None when platform-core sends none
    billing: dict | None = None

    @property
    def suspended(self) -> bool:
        return self.status == "suspended"

    @property
    def warning(self) -> str | None:
        if self.status == "past_due":
            return "past_due"
        if self.source == "stale":
            return "entitlements_stale"
        return None

    def feature_enabled(self, code: str) -> bool:
        f = self.features.get(code)
        if f is None:
            return settings.entitlements_absent_feature == "allow"
        return bool(f.get("enabled"))

    def as_dict(self) -> dict:
        return {"status": self.status, "plan": {"code": self.plan_code, "name": self.plan_name} if self.plan_code else None,
                "outlet_limit": self.outlet_limit, "features": self.features, "version": self.version,
                "source": self.source, "warning": self.warning}


class Unmanaged(Exception):
    """platform-core does not know the tenant (404)."""


class EntitlementClient(Protocol):
    def fetch(self, tenant_id: str) -> Entitlements:
        """Raises Unmanaged for a 404, any other Exception for an outage / refusal."""


def parse(body: dict) -> Entitlements:
    status = body.get("status")
    reason = body.get("status_reason") or "ok"
    if status not in STATUSES:  # contract: fail closed on an unknown status
        status, reason = "suspended", "unknown_status"
    plan = body.get("plan") or {}
    limit = body.get("outlet_limit")
    feats = {str(k): {"enabled": bool((v or {}).get("enabled")), "limit": (v or {}).get("limit")}
             for k, v in (body.get("features") or {}).items()}
    billing = body.get("billing")
    return Entitlements(status=status, status_reason=reason, plan_code=plan.get("code"), plan_name=plan.get("name"),
                        outlet_limit=limit if isinstance(limit, int) and not isinstance(limit, bool) else None,
                        features=feats, version=str(body.get("version") or ""),
                        billing=billing if isinstance(billing, dict) else None)


class HttpEntitlementClient:
    """platform-core over HTTP with the service key (scope entitlements:read) and a short timeout."""

    def __init__(self, base_url: str | None = None, key: str | None = None, timeout: float | None = None,
                 transport: httpx.BaseTransport | None = None):
        self.base = (base_url if base_url is not None else settings.platform_core_url).rstrip("/")
        self.key = key if key is not None else settings.platform_service_key.get_secret_value()
        self.timeout = timeout if timeout is not None else settings.entitlements_timeout_seconds
        self.transport = transport

    def fetch(self, tenant_id: str) -> Entitlements:
        if not self.base or not self.key:
            raise RuntimeError("PLATFORM_CORE_URL / PLATFORM_SERVICE_KEY are not configured")
        with httpx.Client(timeout=self.timeout, transport=self.transport) as c:
            r = c.get(f"{self.base}/tenants/{tenant_id}/entitlements", headers={"X-Service-Key": self.key})
        if r.status_code == 404:
            raise Unmanaged(tenant_id)
        if r.status_code != 200:
            raise RuntimeError(f"platform-core answered {r.status_code}")  # contract: callers fail closed on non-200 (here: grace)
        return parse(r.json())


class FakeEntitlementClient:
    """For tests: `set(tenant, ...)` programs an answer, `down = True` simulates an outage, `calls` counts fetches."""

    def __init__(self):
        self.answers: dict[str, Entitlements | None] = {}
        self.down = False
        self.calls: list[str] = []

    def set(self, tenant_id, status: str = "active", outlet_limit: int | None = None, features: dict | None = None,
            plan: str = "starter", version: str = "v1", billing: dict | None = None) -> Entitlements:
        feats = {k: {"enabled": bool(v), "limit": None} for k, v in (features or {}).items()}
        e = Entitlements(status=status, plan_code=plan, plan_name=plan.title(), outlet_limit=outlet_limit, features=feats,
                         version=version, billing=billing)
        self.answers[str(tenant_id)] = e
        return e

    def fetch(self, tenant_id: str) -> Entitlements:
        self.calls.append(str(tenant_id))
        if self.down:
            raise RuntimeError("platform-core unreachable")
        e = self.answers.get(str(tenant_id))
        if e is None:
            raise Unmanaged(tenant_id)
        return e


@dataclass
class _Entry:
    value: Entitlements | None = None
    fetched_at: float = 0.0  # last good answer (monotonic)
    first_failure_at: float | None = None  # start of the current outage
    retry_at: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)


class EntitlementCache:
    """Per-tenant cache: fresh for the TTL; on a failed refresh the last known answer keeps applying (stale-if-error) for the
    grace period, then the tenant is read-only. Never raises for an outage."""

    def __init__(self, client: EntitlementClient, clock=time.monotonic):
        self.client = client
        self.clock = clock
        self._entries: dict[str, _Entry] = {}
        self._guard = threading.Lock()

    def _entry(self, tenant_id: str) -> _Entry:
        with self._guard:
            return self._entries.setdefault(tenant_id, _Entry())

    def invalidate(self, tenant_id: str | None = None) -> None:
        with self._guard:
            if tenant_id is None:
                self._entries.clear()
            else:
                self._entries.pop(str(tenant_id), None)

    def set_billing(self, tenant_id, billing: dict) -> None:
        """A fresher billing block (returned by platform-core after a usage report) replaces the cached one, so the wallet
        check sees fees already applied without waiting for the TTL. Never creates an entry (nothing else is known)."""
        e = self._entries.get(str(tenant_id))
        if e is not None and e.value is not None and isinstance(billing, dict):
            e.value = Entitlements(**{**e.value.__dict__, "billing": billing})

    def get(self, tenant_id) -> Entitlements:
        tid = str(tenant_id)
        e = self._entry(tid)
        now = self.clock()
        if e.value is not None and now - e.fetched_at < settings.entitlements_cache_ttl_seconds:
            return e.value
        if now < e.retry_at:  # a recent failure: do not hammer platform-core, answer from what we know
            return self._degraded(e, now)
        with e.lock:  # one refresh per tenant at a time; the others wait, then find it fresh
            now = self.clock()
            if e.value is not None and now - e.fetched_at < settings.entitlements_cache_ttl_seconds:
                return e.value
            if now < e.retry_at:
                return self._degraded(e, now)
            try:
                got = self.client.fetch(tid)
            except Unmanaged:
                if settings.entitlements_unknown_tenant == "allow":
                    got = Entitlements(status="active", status_reason="unmanaged", source="unmanaged")
                else:
                    got = Entitlements(status="suspended", status_reason="unknown_tenant", source="unmanaged")
            except Exception as ex:
                log.warning("entitlements fetch failed for %s: %s", tid, ex.__class__.__name__)
                e.retry_at = now + settings.entitlements_retry_seconds
                if e.first_failure_at is None:
                    e.first_failure_at = now
                return self._degraded(e, now)
            e.value, e.fetched_at, e.first_failure_at, e.retry_at = got, now, None, 0.0
            return got

    def _degraded(self, e: _Entry, now: float) -> Entitlements:
        since = e.fetched_at if e.value is not None else (e.first_failure_at if e.first_failure_at is not None else now)
        if now - since <= settings.entitlements_grace_seconds:  # fail OPEN: the restaurant keeps trading
            if e.value is None:
                return Entitlements(status="active", status_reason="platform_unreachable", source="stale")
            return Entitlements(**{**e.value.__dict__, "source": "stale"})
        base = e.value or Entitlements()
        return Entitlements(**{**base.__dict__, "status": "suspended", "status_reason": "grace_expired",
                               "source": "grace_expired"})


_cache: EntitlementCache | None = None
_cache_lock = threading.Lock()


def cache() -> EntitlementCache:
    global _cache
    with _cache_lock:
        if _cache is None:
            _cache = EntitlementCache(HttpEntitlementClient())
        return _cache


def set_client(client: EntitlementClient | None) -> None:
    """Install a client (tests, or a custom transport) and drop every cached answer; None restores the HTTP default."""
    global _cache
    with _cache_lock:
        _cache = EntitlementCache(client) if client is not None else None


def mode() -> str:
    return settings.entitlements_enforce


def current(tenant_id) -> Entitlements | None:
    """The tenant's entitlements, or None when ENTITLEMENTS_ENFORCE=off (nothing is fetched)."""
    return None if mode() == "off" else cache().get(tenant_id)
