import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from app.core.config import settings

_ph = PasswordHasher()


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, password)
    except VerifyMismatchError:
        return False


def create_access_token(user_id: str, restaurant_id: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=settings.access_token_minutes)
    return jwt.encode(
        {"sub": user_id, "rid": restaurant_id, "role": role, "exp": exp, "iat": now,
         "iss": settings.jwt_issuer, "aud": settings.jwt_audience},
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )


REQUIRED_CLAIMS = ["exp", "sub", "rid", "iss", "aud"]


def decode_token(token: str) -> dict:
    """Verified claims, or jwt.PyJWTError. A token must carry exp (so it expires), sub, rid (the tenant), and the issuer and
    audience of this API: a token minted for another service with the same secret, or one without an expiry, is refused."""
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm], issuer=settings.jwt_issuer,
                      audience=settings.jwt_audience, options={"require": REQUIRED_CLAIMS})


def new_refresh_token() -> tuple[str, str]:
    """Opaque random refresh token and its sha256 hex digest (only the digest is stored)."""
    token = secrets.token_urlsafe(32)
    return token, hash_refresh_token(token)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
