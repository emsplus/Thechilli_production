import threading
import time

_lock = threading.Lock()
_windows: dict[str, tuple[int, int]] = {}  # key -> (window start minute, count)


def allow(key: str, limit_per_minute: int) -> bool:
    """Fixed-window counter. Process-local by design (see settings.webhook_rate_limit_per_minute)."""
    minute = int(time.monotonic() // 60)
    with _lock:
        if len(_windows) > 10_000:  # bound memory under key-spraying
            for k in [k for k, (m, _) in _windows.items() if m != minute]:
                del _windows[k]
        m, n = _windows.get(key, (minute, 0))
        if m != minute:
            m, n = minute, 0
        if n >= limit_per_minute:
            return False
        _windows[key] = (m, n + 1)
        return True


def reset() -> None:
    with _lock:
        _windows.clear()
