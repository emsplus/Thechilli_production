import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.core.config import settings

_ph = PasswordHasher()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def create_access_token(user_id: str, role: str) -> str:
    exp = utcnow() + timedelta(minutes=settings.access_token_minutes)
    return jwt.encode({"sub": user_id, "role": role, "typ": "access", "jti": uuid.uuid4().hex, "exp": exp},
                      settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict:
    claims = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    if claims.get("typ") != "access":
        raise jwt.InvalidTokenError("wrong token type")
    return claims


def hash_token(token: str) -> str:
    """sha256 hex digest. Used for refresh tokens and invitation tokens: both are 256-bit random, so a fast hash is
    sufficient and lets the database look them up by equality. Only the digest is ever stored."""
    return hashlib.sha256(token.encode()).hexdigest()


def new_opaque_token() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)
