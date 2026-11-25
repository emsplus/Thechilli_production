import base64
import hashlib
import hmac
import json
import os
import re
import time
from dataclasses import dataclass
from typing import Protocol

from fastapi import Header

from app.core.config import settings
from app.core.errors import AppError

_REF_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
_TENANT_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")  # no "_", no "--": the secret namespace below stays unambiguous
MAX_TENANT_LEN = 32


@dataclass(frozen=True)
class Caller:
    tenant_id: str


class TokenVerifier(Protocol):
    """Seam for key material. HS256Verifier today; a JWKSVerifier (fetch/cache keys by `kid`, RS256/ES256) later."""

    def verify(self, token: str) -> dict: ...


def _unauthorized(msg: str = "invalid credentials") -> AppError:
    return AppError(msg, code="unauthorized", status=401)


def _b64d(part: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))
    except (ValueError, TypeError) as e:
        raise _unauthorized() from e


class HS256Verifier:
    MIN_SECRET_BYTES = 32

    def __init__(self, secret: str):
        self._secret = secret.encode()

    def verify(self, token: str) -> dict:
        parts = token.split(".")
        if len(parts) != 3 or not all(parts):
            raise _unauthorized()
        try:
            header = json.loads(_b64d(parts[0]))
            claims = json.loads(_b64d(parts[1]))
        except ValueError as e:
            raise _unauthorized() from e
        if not isinstance(header, dict) or not isinstance(claims, dict) or header.get("alg") != "HS256":
            raise _unauthorized()  # pins the algorithm: "none" and HS/RS confusion are rejected
        expected = hmac.new(self._secret, f"{parts[0]}.{parts[1]}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64d(parts[2])):
            raise _unauthorized()
        return claims


def get_verifier() -> TokenVerifier:
    secret = settings.jwt_secret.get_secret_value()
    if len(secret.encode()) < HS256Verifier.MIN_SECRET_BYTES:
        raise AppError("service authentication is not configured", code="auth_unconfigured", status=503)
    return HS256Verifier(secret)


def validate_claims(claims: dict, now: float | None = None) -> Caller:
    now = time.time() if now is None else now
    leeway = settings.jwt_leeway_seconds
    exp, nbf = claims.get("exp"), claims.get("nbf")
    if isinstance(exp, bool) or not isinstance(exp, (int, float)) or exp + leeway < now:
        raise _unauthorized("token expired or without exp")
    if nbf is not None and (isinstance(nbf, bool) or not isinstance(nbf, (int, float)) or nbf - leeway > now):
        raise _unauthorized("token not yet valid")
    aud = claims.get("aud")
    if settings.jwt_audience and settings.jwt_audience not in (aud if isinstance(aud, list) else [aud]):
        raise _unauthorized("wrong audience")
    if settings.jwt_issuer and claims.get("iss") != settings.jwt_issuer:
        raise _unauthorized("wrong issuer")
    tid = claims.get("tid")
    if not isinstance(tid, str) or len(tid) > MAX_TENANT_LEN or not _TENANT_RE.match(tid):
        raise _unauthorized("token has no valid tenant")
    return Caller(tenant_id=tid)


def require_caller(authorization: str = Header(default="")) -> Caller:
    """The tenant is whatever the *signed* token says. There is no tenant header and no shared bearer token."""
    verifier = get_verifier()
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise _unauthorized()
    return validate_claims(verifier.verify(token.strip()))


def tenant_secret_prefix(tenant_id: str) -> str:
    """PAY_SECRET_<TENANT>__ : tenant ids contain no "_" and no "--", so no tenant's prefix is a prefix of
    another's and the "__" delimiter cannot be forged by a tenant-id suffix."""
    return f"{settings.secret_ref_prefix}{tenant_id.upper().replace('-', '_')}__"


def validate_secret_ref(ref: str, tenant_id: str) -> str:
    """A secret reference is the NAME of an env var inside the tenant's own namespace; never the secret itself."""
    prefix = tenant_secret_prefix(tenant_id)
    if not _REF_RE.match(ref) or not ref.startswith(prefix) or len(ref) == len(prefix):
        raise AppError(f"secret reference must be an env var name starting with {prefix}",
                       code="invalid_secret_ref", status=422)
    return ref


def resolve_secret(ref: str, tenant_id: str) -> str:
    validate_secret_ref(ref, tenant_id)
    value = os.environ.get(ref, "")
    if not value:
        raise AppError(f"secret {ref} is not set in the environment", code="secret_unavailable", status=503)
    return value
