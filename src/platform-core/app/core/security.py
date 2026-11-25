"""Passwords (argon2id), RS256 JWT signing with a rotatable keyring, JWKS."""
import base64
import hashlib
import json
import os
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.config import settings

_ph = PasswordHasher()
MIN_PASSWORD_LEN = 12


def hash_password(p: str) -> str:
    return _ph.hash(p)


def verify_password(p: str, h: str) -> bool:
    try:
        return _ph.verify(h, p)
    except (VerifyMismatchError, InvalidHashError):
        return False


# A real hash to burn time on when the email is unknown (no user-enumeration timing side channel).
DUMMY_HASH = _ph.hash("not-a-real-password")


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def new_opaque_token() -> tuple[str, str]:
    t = secrets.token_urlsafe(32)
    return t, sha256(t)


# ---------- keyring ----------
@dataclass
class Key:
    kid: str
    public_key: object
    private_key: object | None


class Keyring:
    def __init__(self, active_kid: str, keys: list[Key]):
        self.active_kid, self.keys = active_kid, {k.kid: k for k in keys}
        if self.keys[active_kid].private_key is None:
            raise RuntimeError("active signing key has no private key")

    @property
    def active(self) -> Key:
        return self.keys[self.active_kid]

    def jwks(self) -> dict:
        out = []
        for k in self.keys.values():
            n = k.public_key.public_numbers()
            b64 = lambda i: base64.urlsafe_b64encode(i.to_bytes((i.bit_length() + 7) // 8, "big")).rstrip(b"=").decode()
            out.append({"kty": "RSA", "use": "sig", "alg": "RS256", "kid": k.kid, "n": b64(n.n), "e": b64(n.e)})
        return {"keys": out}


def generate_key(kid: str | None = None) -> dict:
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = priv.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return {"kid": kid or datetime.now(timezone.utc).strftime("k%Y%m%d%H%M%S-") + secrets.token_hex(3), "private_pem": pem.decode()}


def _load(raw: dict) -> Key:
    if raw.get("private_pem"):
        priv = serialization.load_pem_private_key(raw["private_pem"].encode(), password=None)
        return Key(raw["kid"], priv.public_key(), priv)
    return Key(raw["kid"], serialization.load_pem_public_key(raw["public_pem"].encode()), None)


_keyring: Keyring | None = None


def load_keyring() -> Keyring:
    """Keyring JSON: {"active_kid": "...", "keys": [{"kid", "private_pem"} | {"kid", "public_pem"}]}.
    Rotation: add a new key, switch active_kid, keep the old key (public only is enough) until its tokens expire."""
    text = settings.jwt_keyring
    if not text and settings.jwt_keyring_file and os.path.exists(settings.jwt_keyring_file):
        text = open(settings.jwt_keyring_file).read()
    if not text:
        if settings.is_production:
            raise RuntimeError("JWT keyring not configured (JWT_KEYRING / JWT_KEYRING_FILE); refusing to start in production")
        k = generate_key("dev-ephemeral")  # development only: regenerated on each start
        return Keyring("dev-ephemeral", [_load(k)])
    d = json.loads(text)
    return Keyring(d["active_kid"], [_load(k) for k in d["keys"]])


def get_keyring() -> Keyring:
    global _keyring
    if _keyring is None:
        _keyring = load_keyring()
    return _keyring


def reset_keyring(kr: Keyring | None = None) -> None:
    global _keyring
    _keyring = kr


def _sign(claims: dict, audience: str, minutes: int) -> str:
    kr = get_keyring()
    now = datetime.now(timezone.utc)
    payload = {"iss": settings.jwt_issuer, "aud": audience, "iat": now, "nbf": now,
               "exp": now + timedelta(minutes=minutes), "jti": uuid.uuid4().hex, **claims}
    return jwt.encode(payload, kr.active.private_key, algorithm="RS256", headers={"kid": kr.active.kid})


def create_staff_token(staff_id: str, role: str, permissions: list[str], sid: str | None = None, mfa: bool = False) -> str:
    """`sid` = session id (refresh-token family; revoking the session kills the access token at once), `mfa` = the
    session passed a second factor."""
    extra = {"sid": sid} if sid else {}
    return _sign({"sub": staff_id, "typ": "staff_access", "role": role, "perms": permissions, "mfa": mfa, **extra},
                 settings.jwt_audience_staff, settings.access_token_minutes)


def create_mfa_token(staff_id: str, purpose: str) -> str:
    """Short-lived step-up token issued after a correct password: purpose `verify` (enter a code) or `enrol` (set up TOTP).
    typ=staff_mfa, so it is never accepted as an access token."""
    return _sign({"sub": staff_id, "typ": "staff_mfa", "purpose": purpose}, settings.jwt_audience_staff, settings.mfa_challenge_minutes)


def create_support_access_token(staff_id: str, tenant_id: str, grant_id: str, scope: str, minutes: int) -> str:
    return _sign({"sub": staff_id, "typ": "support_access", "tenant_id": tenant_id, "grant_id": grant_id, "scope": scope},
                 settings.jwt_audience_support, minutes)


def decode_token(token: str, audience: str, typ: str) -> dict:
    """Verifies signature (kid-selected, RS256 only), iss, aud, exp, typ. Raises jwt.PyJWTError."""
    kr = get_keyring()
    kid = jwt.get_unverified_header(token).get("kid")
    key = kr.keys.get(kid)
    if key is None:
        raise jwt.InvalidKeyError("unknown kid")
    claims = jwt.decode(token, key.public_key, algorithms=["RS256"], audience=audience, issuer=settings.jwt_issuer,
                        options={"require": ["exp", "iat", "iss", "aud", "sub"]})
    if claims.get("typ") != typ:
        raise jwt.InvalidTokenError("wrong token type")
    return claims
