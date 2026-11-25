"""Optional TOTP second factor for owners and managers (security review 2026-10-31, finding 7; contract in
docs/AUTH_CONTRACT.md). Reuses platform-core's approach (app/services/mfa.py there): RFC 6238 on the stdlib (SHA-1, 6 digits,
30 s, +-1 step), one use per time step, Fernet-encrypted secret, ten single-use recovery codes stored as sha256.

Sign-in with MFA: the password step answers 200 {"mfa_required": true, "mfa_token", "expires_in"} instead of tokens; the client
then calls POST /auth/mfa/verify with the code (or a recovery code). The mfa_token is a short-lived JWT with a different
audience, so it can never be used as an access token. With MFA_REQUIRED_ROLES naming the user's role and no MFA yet, the
password step answers {"mfa_enrolment_required": true, "mfa_token"} and the enrol endpoints accept that token.
"""
import base64
import hashlib
import hmac
import secrets
import struct
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import jwt
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.core import Role, User, UserMfa

STEP, DIGITS, WINDOW = 30, 6, 1
ELIGIBLE_ROLES = (Role.owner, Role.manager)
MFA_AUDIENCE = "pos-api-mfa"
_DEV_KEY = base64.urlsafe_b64encode(hashlib.sha256(b"chilli-pos-dev-insecure-mfa-key").digest())


# ------------------------------------------------------------------------------------------------ crypto / TOTP
def _fernet() -> Fernet:
    key = settings.mfa_encryption_key.get_secret_value().strip()
    if not key:
        if settings.env != "development":
            raise HTTPException(503, "Two-factor sign-in is not configured on this server (MFA_ENCRYPTION_KEY)")
        return Fernet(_DEV_KEY)
    return Fernet(key.encode())


def _encrypt(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def _decrypt(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        raise HTTPException(503, "Two-factor secret cannot be read (wrong MFA_ENCRYPTION_KEY?)")


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _hotp(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    return str((struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % 10 ** DIGITS).zfill(DIGITS)


def totp_at(secret: str, at: float | None = None) -> str:
    return _hotp(secret, int((time.time() if at is None else at) // STEP))


def verify_totp(secret: str, code: str, last_step: int | None = None, at: float | None = None) -> int | None:
    """The matched time step (store it: a step works once), or None."""
    code = (code or "").strip().replace(" ", "")
    if len(code) != DIGITS or not code.isdigit():
        return None
    now = int((time.time() if at is None else at) // STEP)
    hit = None
    for step in range(now - WINDOW, now + WINDOW + 1):  # constant work, no early exit
        if hmac.compare_digest(_hotp(secret, step), code) and (last_step is None or step > last_step):
            hit = step
    return hit


def otpauth_uri(secret: str, account: str) -> str:
    label = quote(f"{settings.mfa_issuer}:{account}")
    return (f"otpauth://totp/{label}?secret={secret}&issuer={quote(settings.mfa_issuer)}"
            f"&algorithm=SHA1&digits={DIGITS}&period={STEP}")


def _code_hash(code: str) -> str:
    return hashlib.sha256(code.strip().replace("-", "").lower().encode()).hexdigest()


def _new_recovery_codes() -> list[str]:
    return [f"{secrets.token_hex(4)}-{secrets.token_hex(4)}" for _ in range(10)]


# ------------------------------------------------------------------------------------------------ policy
def required_roles() -> set[str]:
    return {r.strip() for r in settings.mfa_required_roles.split(",") if r.strip()}


def eligible(user: User) -> bool:
    return user.role in ELIGIBLE_ROLES


def required(user: User) -> bool:
    return eligible(user) and user.role.value in required_roles()


def confirmed_row(db: Session, user: User) -> UserMfa | None:
    row = db.scalar(select(UserMfa).where(UserMfa.user_id == user.id))
    return row if row is not None and row.confirmed_at is not None else None


# ------------------------------------------------------------------------------------------------ pre-MFA token
def mfa_token(user: User, purpose: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({"sub": str(user.id), "rid": str(user.restaurant_id), "purpose": purpose, "typ": "mfa",
                       "iat": now, "exp": now + timedelta(minutes=settings.mfa_challenge_minutes),
                       "jti": uuid.uuid4().hex, "iss": settings.jwt_issuer, "aud": MFA_AUDIENCE},
                      settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_mfa_token(token: str, purpose: str) -> dict:
    try:
        c = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm], issuer=settings.jwt_issuer,
                       audience=MFA_AUDIENCE, options={"require": ["exp", "sub", "rid", "purpose"]})
    except jwt.PyJWTError:
        raise HTTPException(401, "Sign-in step expired. Sign in again.")
    if c.get("typ") != "mfa" or c.get("purpose") != purpose:
        raise HTTPException(401, "Sign-in step expired. Sign in again.")
    return c


def login_gate(db: Session, user: User) -> dict | None:
    """What the password step returns instead of tokens, or None when no second factor applies."""
    if confirmed_row(db, user) is not None:
        return {"mfa_required": True, "mfa_token": mfa_token(user, "verify"), "expires_in": settings.mfa_challenge_minutes * 60}
    if required(user):
        return {"mfa_enrolment_required": True, "mfa_token": mfa_token(user, "enrol"),
                "expires_in": settings.mfa_challenge_minutes * 60}
    return None


# ------------------------------------------------------------------------------------------------ operations
def start_enrolment(db: Session, user: User) -> dict:
    if not eligible(user):
        raise HTTPException(403, "Two-factor sign-in is available to owners and managers")
    row = db.scalar(select(UserMfa).where(UserMfa.user_id == user.id))
    if row is not None and row.confirmed_at is not None:
        raise HTTPException(409, "Two-factor sign-in is already on. Turn it off first to enrol a new device.")
    secret = new_secret()
    if row is None:
        row = UserMfa(restaurant_id=user.restaurant_id, user_id=user.id, secret_enc=_encrypt(secret), recovery_hashes=[])
        db.add(row)
    else:
        row.secret_enc, row.last_step = _encrypt(secret), None
    db.commit()
    return {"secret": secret, "otpauth_uri": otpauth_uri(secret, user.email)}


def confirm_enrolment(db: Session, user: User, code: str) -> list[str]:
    row = db.scalar(select(UserMfa).where(UserMfa.user_id == user.id))
    if row is None or row.confirmed_at is not None:
        raise HTTPException(409, "Start the enrolment first")
    step = verify_totp(_decrypt(row.secret_enc), code)
    if step is None:
        raise HTTPException(400, "That code is not right. Check the time on your phone and try again.")
    codes = _new_recovery_codes()
    row.confirmed_at, row.last_step = datetime.now(timezone.utc), step
    row.recovery_hashes = [_code_hash(c) for c in codes]
    return codes


def check_second_factor(db: Session, user: User, code: str | None, recovery_code: str | None) -> bool:
    """True and consumed (step stored / recovery code removed) when the code is right. Does not commit."""
    row = confirmed_row(db, user)
    if row is None:
        return False
    if recovery_code:
        h = _code_hash(recovery_code)
        left = [x for x in (row.recovery_hashes or []) if not hmac.compare_digest(x, h)]
        if len(left) == len(row.recovery_hashes or []):
            return False
        row.recovery_hashes = left
        return True
    step = verify_totp(_decrypt(row.secret_enc), code or "", row.last_step)
    if step is None:
        return False
    row.last_step = step
    return True


def disable(db: Session, user: User) -> None:
    if required(user):
        raise HTTPException(409, "Two-factor sign-in is required for your role on this server")
    row = db.scalar(select(UserMfa).where(UserMfa.user_id == user.id))
    if row is not None:
        db.delete(row)
