"""Tenant-bound signed JWTs, same scheme as payments-service/app/core/security.py. The tenant is whatever the signed
token says: there is no tenant header, no shared API key. Internal callers (worker, platform admin) use a separate
secret and a `role` claim and carry no tenant."""
import base64
import hashlib
import hmac
import json
import os
import re
import time
from dataclasses import dataclass

from fastapi import Header

from app.core.config import MIN_SECRET_BYTES, settings
from app.core.errors import AppError

_REF_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
_TENANT_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")  # no "_", no "--": the secret namespace stays unambiguous
_SUB_RE = re.compile(r"^[A-Za-z0-9._@-]{1,48}$")
MAX_TENANT_LEN = 32


@dataclass(frozen=True)
class Caller:
    tenant_id: str
    actor: str  # derived from the signed token only


@dataclass(frozen=True)
class Internal:
    role: str  # worker | admin
    actor: str


def _unauthorized(msg: str = "invalid credentials") -> AppError:
    return AppError(401, "unauthorized", msg)


def _b64d(part: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))
    except (ValueError, TypeError) as e:
        raise _unauthorized() from e


def _verify(token: str, secret: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3 or not all(parts):
        raise _unauthorized()
    try:
        header = json.loads(_b64d(parts[0]))
        claims = json.loads(_b64d(parts[1]))
    except ValueError as e:
        raise _unauthorized() from e
    if not isinstance(header, dict) or not isinstance(claims, dict) or header.get("alg") != "HS256":
        raise _unauthorized()  # pinned algorithm: "none" and HS/RS confusion are rejected
    expected = hmac.new(secret.encode(), f"{parts[0]}.{parts[1]}".encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(expected, _b64d(parts[2])):
        raise _unauthorized()
    return claims


def _secret(value) -> str:
    sec = value.get_secret_value()
    if len(sec.encode()) < MIN_SECRET_BYTES:  # fail closed in every env, development included
        raise AppError(503, "auth_unconfigured", "service authentication is not configured")
    return sec


def _check_common(claims: dict, now: float | None) -> None:
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


def _actor(claims: dict, prefix: str) -> str:
    sub = claims.get("sub")
    if sub is None:
        return prefix
    if not isinstance(sub, str) or not _SUB_RE.match(sub):
        raise _unauthorized("invalid sub")
    return f"{prefix}:{sub}"  # fixed prefix: a token cannot claim to be "provider:x", "worker" or "system"


def validate_claims(claims: dict, now: float | None = None) -> Caller:
    _check_common(claims, now)
    tid = claims.get("tid")
    if not isinstance(tid, str) or len(tid) > MAX_TENANT_LEN or not _TENANT_RE.match(tid):
        raise _unauthorized("token has no valid tenant")
    return Caller(tenant_id=tid, actor=_actor(claims, f"user:{tid}"))


def _bearer(authorization: str) -> str:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise _unauthorized()
    return token.strip()


def require_caller(authorization: str = Header(default="")) -> Caller:
    secret = _secret(settings.jwt_secret)
    return validate_claims(_verify(_bearer(authorization), secret))


def _internal(authorization: str, roles: set[str]) -> Internal:
    claims = _verify(_bearer(authorization), _secret(settings.internal_jwt_secret))
    _check_common(claims, None)
    role = claims.get("role")
    if role not in roles:
        raise AppError(403, "forbidden", "insufficient role")
    if "tid" in claims:
        raise _unauthorized("internal tokens carry no tenant")
    return Internal(role=role, actor=_actor(claims, role))


def require_worker(authorization: str = Header(default="")) -> Internal:
    return _internal(authorization, {"worker"})


def require_admin(authorization: str = Header(default="")) -> Internal:
    return _internal(authorization, {"admin"})


def tenant_secret_prefix(tenant_id: str) -> str:
    return f"{settings.secret_ref_prefix}{tenant_id.upper().replace('-', '_')}__"


def validate_secret_ref(ref: str, tenant_id: str) -> str:
    """A secret reference is the NAME of an env var inside the tenant's own namespace; never the secret itself."""
    prefix = tenant_secret_prefix(tenant_id)
    if not _REF_RE.match(ref) or not ref.startswith(prefix) or len(ref) == len(prefix):
        raise AppError(422, "invalid_secret_ref", f"secret reference must be an env var name starting with {prefix}")
    return ref


def resolve_secret(ref: str, tenant_id: str) -> str:
    validate_secret_ref(ref, tenant_id)
    value = os.environ.get(ref, "")
    if not value:
        raise AppError(503, "secret_unavailable", f"secret {ref} is not set in the environment")
    return value
