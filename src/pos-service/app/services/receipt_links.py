"""Expiring, HMAC-signed public receipt links (the WhatsApp-ready share flow).

Token = base64url( bill_id(16) | restaurant_id(16) | exp(8, big-endian unix secs) | mac(16) ) where
mac = HMAC-SHA256(key, payload)[:16] and key is derived from JWT_SECRET with a distinct purpose string, so a
receipt token can never be confused with (or forged from) any other secret use. Verification is constant-time.
The link is a bearer capability for ONE bill PDF only; it reveals nothing else.

Rate limit (public route): a simple per-IP in-memory token bucket. It is per-process and keyed on the socket peer
address (X-Forwarded-For is NOT trusted), so behind a reverse proxy all clients share the proxy's bucket; for a
multi-worker deployment put a real limiter in front. It exists to make token guessing impractical, not for billing.
"""
import base64
import hashlib
import hmac
import re
import threading
import time
import uuid

from app.core.config import settings

_PURPOSE = b"pos-receipt-link-v1"


def _key() -> bytes:
    return hmac.new(settings.jwt_secret.encode(), _PURPOSE, hashlib.sha256).digest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def make_token(bill_id: uuid.UUID, restaurant_id: uuid.UUID, exp: int, gen: int = 0) -> str:
    """`gen` = the bill's receipt_link_gen when the link is made. Revoking (POST /bills/{id}/share-link/revoke) bumps the
    bill's counter, so every older link stops working (security review finding 9). gen 0 keeps the original 56-byte
    format, so links shared before revocation existed stay valid until they expire or are revoked."""
    payload = bill_id.bytes + restaurant_id.bytes + exp.to_bytes(8, "big") + (gen.to_bytes(4, "big") if gen else b"")
    return _b64(payload + hmac.new(_key(), payload, hashlib.sha256).digest()[:16])


def verify(token: str, now: float | None = None) -> tuple[uuid.UUID, uuid.UUID, int] | None:
    """(bill_id, restaurant_id, gen) for a genuine unexpired token, else None. The caller compares gen with the bill."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{70,100}", token or ""):
        return None
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
    except Exception:
        return None
    if len(raw) not in (56, 60):
        return None
    payload, mac = raw[:-16], raw[-16:]
    if not hmac.compare_digest(mac, hmac.new(_key(), payload, hashlib.sha256).digest()[:16]):
        return None
    if int.from_bytes(payload[32:40], "big") < (time.time() if now is None else now):
        return None
    gen = int.from_bytes(payload[40:44], "big") if len(payload) == 44 else 0
    return uuid.UUID(bytes=payload[:16]), uuid.UUID(bytes=payload[16:32]), gen


def verify_token(token: str, now: float | None = None) -> tuple[uuid.UUID, uuid.UUID] | None:
    """(bill_id, restaurant_id) for a genuine unexpired token, else None (does NOT check revocation: use verify)."""
    v = verify(token, now)
    return (v[0], v[1]) if v else None


class TokenBucket:
    def __init__(self):
        self._lock = threading.Lock()
        self._b: dict[str, tuple[float, float]] = {}

    def reset(self) -> None:
        with self._lock:
            self._b.clear()

    def allow(self, key: str, per_minute: int) -> bool:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._b.get(key, (float(per_minute), now))
            tokens = min(float(per_minute), tokens + (now - last) * per_minute / 60.0)
            ok = tokens >= 1
            self._b[key] = (tokens - 1 if ok else tokens, now)
            if len(self._b) > 10000:  # bound memory
                self._b = {k: v for k, v in self._b.items() if now - v[1] < 60}
            return ok


limiter = TokenBucket()
