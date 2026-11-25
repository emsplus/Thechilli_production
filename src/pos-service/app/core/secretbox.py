"""Fernet encryption of small per-tenant secrets at rest (same key as the TOTP secrets: MFA_ENCRYPTION_KEY).

Required outside development; in development a fixed insecure key is used so a laptop works without setup."""
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

_DEV_KEY = base64.urlsafe_b64encode(hashlib.sha256(b"chilli-pos-dev-insecure-secretbox-key").digest())


class SecretBoxError(RuntimeError):
    pass


def _fernet() -> Fernet:
    key = settings.mfa_encryption_key.get_secret_value().strip()
    if not key:
        if settings.env != "development":
            raise SecretBoxError("MFA_ENCRYPTION_KEY is not set")
        return Fernet(_DEV_KEY)
    return Fernet(key.encode())


def encrypt(plain: str) -> str:
    return _fernet().encrypt(plain.encode()).decode()


def decrypt(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        raise SecretBoxError("stored secret cannot be read (wrong MFA_ENCRYPTION_KEY?)") from None
