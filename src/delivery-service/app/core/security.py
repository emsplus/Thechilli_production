import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from dataclasses import dataclass

from fastapi import Depends, Header
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.errors import AppError, Unauthorized

_REF_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
MIN_SECRET = 32


@dataclass(frozen=True)
class Caller:
    restaurant_id: str


def mint_service_token(restaurant_id: str, ttl: int = 365 * 86400, now: float | None = None) -> str:
    """Tenant-bound credential: signed token carrying `tid`. Mint out of band (scripts/mint_token.py)."""
    return make_link_token("svc", {"tid": restaurant_id}, ttl, now)


def require_caller(authorization: str = Header(default=""), db: Session = Depends(get_db)) -> Caller:
    """The restaurant is taken ONLY from the verified token's `tid` claim. No tenant header is ever trusted."""
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise Unauthorized("missing bearer token")
    from app.core.auth import authorize  # local import: auth imports this module
    claims = authorize(db, token, "svc")  # 503 if links unconfigured, 401/410 if bad/expired; binds the DB tenant
    return Caller(restaurant_id=str(claims["tid"]).strip())


def validate_secret_ref(ref: str) -> str:
    """A secret reference is the NAME of an env var carrying the prefix; never the secret itself."""
    if not _REF_RE.match(ref) or not ref.startswith(settings.secret_ref_prefix):
        raise AppError(f"secret reference must be an env var name starting with {settings.secret_ref_prefix}",
                       code="invalid_secret_ref", status=422)
    return ref


def resolve_secret(ref: str) -> str:
    validate_secret_ref(ref)
    value = os.environ.get(ref, "")
    if not value:
        raise AppError(f"secret {ref} is not set in the environment", code="secret_unavailable", status=503)
    return value


# ---- HMAC helpers (POS webhooks, WhatsApp webhooks) ----

def hmac_hex(secret: str, data: bytes) -> str:
    return hmac.new(secret.encode(), data, hashlib.sha256).hexdigest()


def sign_pos(secret: str, timestamp: str, raw_body: bytes) -> str:
    """X-Pos-Signature value: sha256=<hex of HMAC-SHA256(secret, timestamp + '.' + raw_body)>."""
    return "sha256=" + hmac_hex(secret, timestamp.encode() + b"." + raw_body)


def verify_pos_signature(secret: str, timestamp: str, raw_body: bytes, signature: str, now: float | None = None) -> None:
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        raise Unauthorized("invalid timestamp", code="bad_timestamp") from None
    if abs((now if now is not None else time.time()) - ts) > settings.pos_webhook_max_skew_seconds:
        raise Unauthorized("timestamp outside the accepted window", code="stale_timestamp")
    if not hmac.compare_digest(sign_pos(secret, timestamp, raw_body).encode(), (signature or "").encode()):
        raise Unauthorized("invalid signature", code="bad_signature")


# ---- purpose-bound link tokens (not JWTs; keys are derived per audience, never the login key) ----
# Format: b64(header).b64(payload).b64(sig); header = {"kid":..,"alg":"HS256"}; sig = HMAC(derived key(kid, aud),
# header_b64 + "." + payload_b64). Legacy two-part tokens (no header) verify against the legacy key "k0" only.
LEGACY_KID = "k0"
_KID_RE = re.compile(r"^[A-Za-z0-9_-]{1,16}$")


def keyring() -> dict[str, str]:
    """kid -> root secret, in configured order. Secrets shorter than MIN_SECRET are never usable."""
    ring: dict[str, str] = {}
    for part in settings.link_keyring.get_secret_value().split(","):
        kid, _, secret = part.strip().partition(":")
        if kid and _KID_RE.match(kid) and len(secret) >= MIN_SECRET:
            ring[kid] = secret
    legacy = settings.link_secret.get_secret_value()
    if len(legacy) >= MIN_SECRET and LEGACY_KID not in ring:
        ring[LEGACY_KID] = legacy
    return ring


def active_kid() -> str:
    ring = keyring()
    if not ring:
        raise AppError("link signing is not configured", code="links_unconfigured", status=503)
    want = settings.link_active_kid
    if want:
        if want not in ring:
            raise AppError("active link key is not in the keyring", code="links_unconfigured", status=503)
        return want
    return next(iter(ring))


def _link_key(aud: str, kid: str | None = None) -> bytes:
    ring = keyring()
    if not ring:
        raise AppError("link signing is not configured", code="links_unconfigured", status=503)
    root = ring.get(kid if kid is not None else active_kid())
    if root is None:
        raise Unauthorized("invalid link", code="bad_link")  # unknown or retired kid = revoked
    return hmac.new(root.encode(), b"delivery-link-v1:" + aud.encode(), hashlib.sha256).digest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_link_token(aud: str, claims: dict, ttl: int, now: float | None = None) -> str:
    payload = {**claims, "aud": aud, "exp": int((now if now is not None else time.time()) + ttl),
               "jti": claims.get("jti") or secrets.token_urlsafe(9)}
    kid = active_kid()
    head = _b64(json.dumps({"alg": "HS256", "kid": kid}, separators=(",", ":"), sort_keys=True).encode())
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    signing = f"{head}.{body}"
    return signing + "." + _b64(hmac.new(_link_key(aud, kid), signing.encode(), hashlib.sha256).digest())


def read_link_token(token: str, aud: str, now: float | None = None) -> dict:
    parts = token.split(".")
    if len(parts) == 3:
        head_b64, body, sig = parts
        try:
            header = json.loads(_unb64(head_b64))
            kid = header["kid"]
            if header.get("alg") != "HS256" or not isinstance(kid, str):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            raise Unauthorized("invalid link", code="bad_link") from None
        signing = f"{head_b64}.{body}"
    elif len(parts) == 2:  # legacy
        body, sig = parts
        kid, signing = LEGACY_KID, body
    else:
        raise Unauthorized("invalid link", code="bad_link")
    if not body or not sig:
        raise Unauthorized("invalid link", code="bad_link")
    good = _b64(hmac.new(_link_key(aud, kid), signing.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(good.encode(), sig.encode()):
        raise Unauthorized("invalid link", code="bad_link")
    try:
        payload = json.loads(_unb64(body))
    except ValueError:
        raise Unauthorized("invalid link", code="bad_link") from None
    if payload.get("aud") != aud:
        raise Unauthorized("invalid link", code="bad_link")
    if payload.get("exp", 0) < (now if now is not None else time.time()):
        raise Unauthorized("link expired", code="link_expired", status=410)
    return payload


def keyed_hash(purpose: str, value: str) -> str:
    """Short keyed digest of an identifier (IP address, phone number) for rate-limit bucket keys: the bucket table never holds
    the raw value, and a DB dump cannot be reversed without the link key. Stable across requests for one active key."""
    return hmac.new(_link_key("rl-" + purpose), value.encode(), hashlib.sha256).hexdigest()[:24]


def hash_otp(order_id, otp: str, kid: str | None = None) -> str:
    """Keyed hash bound to the order; a DB dump alone cannot brute-force the (small) OTP space."""
    return hmac.new(_link_key("otp", kid), f"{order_id}:{otp}".encode(), hashlib.sha256).hexdigest()


def otp_matches(stored: str, order_id, otp: str) -> bool:
    """True if `stored` was produced by ANY key in the ring (an OTP issued before a rotation stays valid)."""
    ok = False
    for kid in keyring():
        ok |= hmac.compare_digest(stored.encode(), hash_otp(order_id, otp, kid).encode())
    return ok
