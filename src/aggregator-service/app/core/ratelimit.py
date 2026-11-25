"""In-process fixed-window limiter for failed webhook authentications. Per worker process: a deployment with N
replicas allows up to N x the limit; put an edge/WAF limit in front for a hard global cap (see README)."""
import threading
import time

from app.core.config import settings

_GLOBAL = "*"


class BadSignatureLimiter:
    def __init__(self):
        self._lock = threading.Lock()
        self._w: dict[object, tuple[float, int]] = {}

    def reset(self):
        with self._lock:
            self._w.clear()

    def _count(self, key, now) -> int:
        start, n = self._w.get(key, (now, 0))
        return n if now - start < settings.webhook_bad_sig_window_seconds else 0

    def blocked(self, key) -> bool:
        with self._lock:
            return self._count(key, time.monotonic()) >= settings.webhook_bad_sig_limit

    def record(self, key) -> bool:
        """Count one failure. Returns True while an audit row may still be written (bounded per key, and globally
        at 10x the per-key limit so many sources cannot flood the table either)."""
        now = time.monotonic()
        limit = settings.webhook_bad_sig_limit
        with self._lock:
            if len(self._w) > 10_000:  # bound memory: drop expired windows
                self._w = {k: v for k, v in self._w.items() if now - v[0] < settings.webhook_bad_sig_window_seconds}
            counts = []
            for k in (key, _GLOBAL):
                start, n = self._w.get(k, (now, 0))
                if now - start >= settings.webhook_bad_sig_window_seconds:
                    start, n = now, 0
                self._w[k] = (start, n + 1)
                counts.append(n + 1)
        return counts[0] <= limit and counts[1] <= limit * 10


limiter = BadSignatureLimiter()
