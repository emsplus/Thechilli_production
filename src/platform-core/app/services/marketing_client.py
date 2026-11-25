"""Read-only client for marketing-service (team, referral codes, commissions), behind an interface so tests use a fake.

Written against marketing-service's OpenAPI (docs/DESIGN.md there; not edited from here):
  GET /users                       (marketing_admin)  -> [{id,email,name,role,is_active,created_at}]
  GET /referral-codes              (admin sees all)   -> [{id,code,owner_id,campaign_id,is_active,max_uses,expires_at,created_at,uses}]
  GET /commission-entries?limit&offset&status         -> [{id,kind,user_id,application_id,amount_minor,currency,status,...}]
  GET /commission-rules                               -> [{id,name,recipient,calc,rate_bps,flat_amount_minor,currency,is_active,...}]
The real client authenticates with a scoped, read-only service key (MARKETING_SERVICE_KEY, header X-Service-Key; scope
marketing.read on the marketing-service side, which accepts it on these four GET routes only). It replaced a 365-day
marketing_admin bearer token (security review finding 5). Any upstream failure surfaces as MarketingUnavailable (HTTP 502);
not configured is 503."""
from typing import Protocol

import httpx

from app.core.config import settings


class MarketingUnavailable(Exception):
    def __init__(self, message: str, configured: bool = True):
        super().__init__(message)
        self.configured = configured


class MarketingClient(Protocol):
    def users(self) -> list[dict]: ...
    def referrals(self) -> list[dict]: ...
    def commission_entries(self, status: str | None = None) -> list[dict]: ...
    def commission_rules(self) -> list[dict]: ...


PAGE, MAX_ROWS = 500, 10000


class HttpMarketingClient:
    def __init__(self, base_url: str, service_key: str, timeout: float = 5.0, transport: httpx.BaseTransport | None = None):
        if not base_url or not service_key:
            raise MarketingUnavailable("marketing-service is not configured", configured=False)
        self._http = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport, follow_redirects=False,
                                  headers={"X-Service-Key": service_key, "Accept": "application/json"})

    def _get(self, path: str, params: dict | None = None) -> list[dict]:
        try:
            r = self._http.get(path, params=params)
        except httpx.HTTPError as e:
            raise MarketingUnavailable(f"marketing-service unreachable ({type(e).__name__})")
        if r.status_code != 200:
            raise MarketingUnavailable(f"marketing-service answered {r.status_code}")
        try:
            data = r.json()
        except ValueError:
            raise MarketingUnavailable("marketing-service returned invalid JSON")
        if not isinstance(data, list):
            raise MarketingUnavailable("marketing-service returned an unexpected shape")
        return data

    def users(self) -> list[dict]:
        return self._get("/users")

    def referrals(self) -> list[dict]:
        return self._get("/referral-codes")

    def commission_entries(self, status: str | None = None) -> list[dict]:
        out: list[dict] = []
        while len(out) < MAX_ROWS:
            page = self._get("/commission-entries", {"limit": PAGE, "offset": len(out), **({"status": status} if status else {})})
            out += page
            if len(page) < PAGE:
                break
        return out

    def commission_rules(self) -> list[dict]:
        return self._get("/commission-rules")


class FakeMarketingClient:
    """In-memory stand-in for tests and local development (no marketing-service needed)."""

    def __init__(self, users=None, referrals=None, entries=None, rules=None, fail: str | None = None):
        self._users, self._referrals, self._entries, self._rules, self.fail = users or [], referrals or [], entries or [], rules or [], fail

    def _check(self):
        if self.fail:
            raise MarketingUnavailable(self.fail)

    def users(self):
        self._check()
        return list(self._users)

    def referrals(self):
        self._check()
        return list(self._referrals)

    def commission_entries(self, status=None):
        self._check()
        return [e for e in self._entries if not status or e["status"] == status]

    def commission_rules(self):
        self._check()
        return list(self._rules)


_override: MarketingClient | None = None


def set_marketing_client(c: MarketingClient | None) -> None:
    global _override
    _override = c


def get_marketing_client() -> MarketingClient:
    if _override is not None:
        return _override
    return HttpMarketingClient(settings.marketing_service_url, settings.marketing_service_key.get_secret_value(),
                               settings.marketing_timeout_seconds)
