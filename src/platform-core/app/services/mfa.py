"""TOTP (RFC 6238, SHA-1, 6 digits, 30 s) implemented on the stdlib, recovery codes, secret encryption at rest.

Secrets are Fernet-encrypted (MFA_ENCRYPTION_KEY) because TOTP needs the plain secret to verify; recovery codes are only
ever stored as sha256 and shown once."""
import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

STEP, DIGITS, WINDOW = 30, 6, 1  # accept the previous/current/next step (clock skew)
_DEV_KEY = base64.urlsafe_b64encode(hashlib.sha256(b"chilli-dev-insecure-mfa-key").digest())


def _fernet() -> Fernet:
    key = settings.mfa_encryption_key
    if not key:
        if settings.is_production:
            raise RuntimeError("MFA_ENCRYPTION_KEY not configured; refusing to run MFA in production")
        return Fernet(_DEV_KEY)
    return Fernet(key.encode())


def check_config() -> None:
    """Called at startup: production must be able to encrypt TOTP secrets."""
    _fernet()


def encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        raise RuntimeError("cannot decrypt MFA secret (wrong MFA_ENCRYPTION_KEY?)")


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")  # 160 bits


def _hotp(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    return str((struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % 10 ** DIGITS).zfill(DIGITS)


def totp_at(secret: str, at: float | None = None) -> str:
    return _hotp(secret, int((time.time() if at is None else at) // STEP))


def verify_totp(secret: str, code: str, last_step: int | None = None, at: float | None = None) -> int | None:
    """Returns the matched time step (store it as last_step: a step can be used once), or None."""
    code = code.strip().replace(" ", "")
    if len(code) != DIGITS or not (code.isascii() and code.isdigit()):  # isdigit() accepts other scripts' digits, which compare_digest rejects with a TypeError (500)
        return None
    now_step = int((time.time() if at is None else at) // STEP)
    hit = None
    for step in range(now_step - WINDOW, now_step + WINDOW + 1):  # constant work: no early exit
        if hmac.compare_digest(_hotp(secret, step), code) and (last_step is None or step > last_step):
            hit = step
    return hit


def otpauth_uri(secret: str, account: str) -> str:
    label = quote(f"{settings.mfa_issuer}:{account}")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(settings.mfa_issuer)}&algorithm=SHA1&digits={DIGITS}&period={STEP}"


def qr_svg(data: str) -> str | None:
    """Inline SVG QR of the otpauth URI so the secret never goes to a third-party QR service. None if segno is absent
    (the UI then shows the manual-entry secret only)."""
    try:
        import io

        import segno
    except ImportError:
        return None
    buf = io.BytesIO()
    segno.make(data, error="m").save(buf, kind="svg", scale=4, border=2, xmldecl=False, nl=False)
    return buf.getvalue().decode()


# ---------- recovery codes ----------
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


def new_recovery_codes(n: int) -> list[str]:
    return ["-".join("".join(secrets.choice(_ALPHABET) for _ in range(5)) for _ in range(3)) for _ in range(n)]  # 75 bits


def norm_recovery(code: str) -> str:
    return code.strip().upper().replace("-", "").replace(" ", "")


def hash_recovery(code: str) -> str:
    return hashlib.sha256(("mfa-recovery:" + norm_recovery(code)).encode()).hexdigest()
