"""Service principal for machine callers (delivery-service). docs/DELIVERY_API.md "Authentication".

Two independent checks, both must pass:
  1. the bearer is a token signed by this service (HS256, DELIVERY_TOKEN_SECRET, aud ``pos-delivery``) that NAMES the tenant
     (``rid``) and the credential (``sub`` = key id): the tenant is never taken from a header or query parameter;
  2. the sha256 of the exact token is on the allowlist DELIVERY_SERVICE_KEYS (``kid:hash:scopes``), which also carries the
     scopes. Removing an entry revokes the credential at once; only hashes live in the environment.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from dataclasses import dataclass

import jwt

from app.core.config import settings

AUDIENCE = "pos-delivery"
ALL_SCOPES = ("menu:read", "orders:read", "orders:write")


class ServiceAuthError(Exception):
    def __init__(self, message: str, status: int = 401):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class ServiceCaller:
    kid: str
    restaurant_id: str
    scopes: frozenset[str]


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _key() -> str:
    # Derived per purpose from the dedicated secret, so a leak of another derived key never signs these.
    root = settings.delivery_token_secret.get_secret_value()
    return hmac.new(root.encode(), b"pos-delivery-token-v1", hashlib.sha256).hexdigest()


def parse_keys(raw: str) -> dict[str, tuple[str, frozenset[str]]]:
    """kid -> (token sha256 hex, scopes). Malformed entries are ignored (they can only deny)."""
    out: dict[str, tuple[str, frozenset[str]]] = {}
    for part in raw.split(","):
        bits = part.strip().split(":", 2)
        if len(bits) != 3 or not bits[0] or len(bits[1]) != 64:
            continue
        scopes = frozenset(s for s in bits[2].split("+") if s in ALL_SCOPES)
        out[bits[0]] = (bits[1].lower(), scopes)
    return out


def mint_token(restaurant_id: str, kid: str, ttl_seconds: int, now: float | None = None) -> str:
    if len(settings.delivery_token_secret.get_secret_value()) < 32:
        raise RuntimeError("DELIVERY_TOKEN_SECRET must be at least 32 characters")
    t = int(now if now is not None else time.time())
    return jwt.encode({"iss": settings.jwt_issuer, "aud": AUDIENCE, "sub": kid, "rid": restaurant_id, "scope": "delivery",
                       "iat": t, "exp": t + ttl_seconds}, _key(), algorithm="HS256")


def authenticate(token: str) -> ServiceCaller:
    keys = parse_keys(settings.delivery_service_keys)
    if not keys or len(settings.delivery_token_secret.get_secret_value()) < 32:
        raise ServiceAuthError("delivery API is not configured", 503)
    try:
        claims = jwt.decode(token, _key(), algorithms=["HS256"], audience=AUDIENCE, issuer=settings.jwt_issuer,
                            options={"require": ["exp", "sub", "rid", "iss", "aud"]})
    except jwt.PyJWTError:
        raise ServiceAuthError("invalid service token") from None
    entry = keys.get(str(claims["sub"]))
    if entry is None or not hmac.compare_digest(entry[0].encode(), token_hash(token).encode()):
        raise ServiceAuthError("service credential is not accepted")
    rid = str(claims["rid"])
    return ServiceCaller(kid=str(claims["sub"]), restaurant_id=rid, scopes=entry[1])
