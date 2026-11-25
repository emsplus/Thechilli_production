"""Platform-core support access (docs/ENTITLEMENTS.md): a short-lived RS256 token minted by platform-core for a staff member
and one tenant. We verify it against platform-core's JWKS and give the bearer READ-ONLY access to that tenant only, bounded by
the token's claims (tenant_id, exp, scope). Every request is audited. Token format: platform-core docs/DESIGN.md "Support
access token": aud=chilli-support-access, typ=support_access, sub=staff id, tenant_id, grant_id, scope read_only|diagnostics."""
import logging
import time
import uuid

import httpx
import jwt
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.core import AuditLog

log = logging.getLogger("app.support")

SCOPES = ("read_only", "diagnostics")
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
_jwk_client: jwt.PyJWKClient | None = None
_grant_cache: dict[str, tuple[float, bool]] = {}
GRANT_CACHE_SECONDS = 30


def looks_like_support_token(token: str) -> bool:
    """Cheap routing decision before any verification: only RS256 tokens are candidates (pos-service's own are HS256)."""
    try:
        return jwt.get_unverified_header(token).get("alg") == "RS256"
    except jwt.PyJWTError:
        return False


def _signing_key(token: str):
    """The platform-core public key for the token's `kid` (PyJWKClient caches the set and refetches once on an unknown kid).
    A seam for tests."""
    global _jwk_client
    if _jwk_client is None:
        _jwk_client = jwt.PyJWKClient(settings.support_jwks_url, cache_keys=True, lifespan=300, timeout=3)
    return _jwk_client.get_signing_key_from_jwt(token).key


def _grant_active(grant_id: str) -> bool:
    now = time.monotonic()
    hit = _grant_cache.get(grant_id)
    if hit and now - hit[0] < GRANT_CACHE_SECONDS:
        return hit[1]
    try:
        r = httpx.get(f"{settings.platform_core_url.rstrip('/')}/support-access/grants/{grant_id}/status",
                      headers={"X-Service-Key": settings.platform_service_key.get_secret_value()},
                      timeout=settings.entitlements_timeout_seconds)
        ok = r.status_code == 200 and bool(r.json().get("active"))
    except Exception:
        log.warning("support grant status check failed")  # fail CLOSED: support access is never worth guessing about
        return False
    _grant_cache[grant_id] = (now, ok)
    return ok


def verify(token: str) -> dict:
    """Verified claims of a support token, or HTTPException 401/403. Checks signature (RS256 only), iss, aud, exp, typ, scope,
    that tenant_id and grant_id are present, and (SUPPORT_VERIFY_GRANT) that the grant is still active."""
    if not settings.support_access_enabled:
        raise HTTPException(401, "Invalid token")
    try:
        claims = jwt.decode(token, _signing_key(token), algorithms=["RS256"], audience=settings.support_audience,
                            issuer=settings.support_issuer, options={"require": ["exp", "iat", "iss", "aud", "sub"]})
    except Exception:  # signature, expiry, audience, unknown kid, JWKS unreachable: all the same to the caller
        raise HTTPException(401, "Invalid token")
    if claims.get("typ") != "support_access" or claims.get("scope") not in SCOPES:
        raise HTTPException(401, "Invalid token")
    try:
        uuid.UUID(str(claims["tenant_id"]))
        claims["grant_id"] = str(claims["grant_id"])
    except (KeyError, ValueError):
        raise HTTPException(401, "Invalid token")
    if settings.support_verify_grant and not _grant_active(claims["grant_id"]):
        raise HTTPException(401, "Support access grant is not active")
    return claims


def staff_uuid(claims: dict) -> uuid.UUID:
    try:
        return uuid.UUID(str(claims["sub"]))
    except ValueError:
        return uuid.uuid5(uuid.NAMESPACE_URL, f"platform-staff:{claims['sub']}")


def record(db: Session, claims: dict, method: str, path: str) -> None:
    """One audit row per request (user_id stays NULL: the actor is platform staff, not a tenant user). Committed here: a read
    request would otherwise leave no trace."""
    db.add(AuditLog(restaurant_id=uuid.UUID(str(claims["tenant_id"])), user_id=None, action="support.access",
                    entity="support_access", entity_id=claims["grant_id"][:64],
                    detail={"staff_id": str(claims["sub"]), "grant_id": claims["grant_id"], "scope": claims["scope"],
                            "method": method, "path": path}))
    db.commit()
