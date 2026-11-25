"""DB-backed abuse counters (table `abuse_counters`, no tenant): a limit or lockout that holds across workers and restarts.

Keys are namespaced strings (`pair:ip:<addr>`, `pair:code:<sha256>`, `pair:global`, `register:ip:<addr>`, ...). Every call
runs in its OWN short session and commits, so a count survives the request failing or rolling back, and it never touches
the caller's transaction or tenant binding."""
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.core.config import settings

# The counters run in their OWN short session while the request still holds its own connection. On the request pool that
# nests: a burst of more concurrent requests than the pool has connections (pool_size + overflow, 20 by default) left every
# request waiting for a second connection that only a waiting request could free, until pool_timeout -> 500
# (docs/testing/BREAK_BACKEND_REPORT.md D12). A small dedicated pool cannot be starved by the request pool; each use is a
# single statement, so a few connections serve any burst.
engine = create_engine(settings.database_url, pool_pre_ping=True, pool_size=2, max_overflow=6, pool_timeout=10,
                       pool_recycle=settings.db_pool_recycle_seconds, hide_parameters=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def locked_for(keys: list[str]) -> int:
    """Seconds until the longest lockout among `keys` ends (0 = none is locked)."""
    now = _now()
    with SessionLocal() as db:
        until = db.scalar(text("SELECT max(locked_until) FROM abuse_counters WHERE key = ANY(:k) AND locked_until > :n"),
                          {"k": keys, "n": now})
    return 0 if until is None else max(1, int((until - now).total_seconds()) + 1)


def hit(key: str, *, window: timedelta, limit: int, lockout: timedelta | None = None) -> int:
    """Counts one event for `key` in a fixed window and returns the count in the current window. Reaching `limit` sets a
    lockout of `lockout` (default: until the window ends). Atomic (one upsert), so concurrent workers cannot undercount."""
    now = _now()
    lock = lockout if lockout is not None else window
    with SessionLocal() as db:
        n = db.scalar(text("""
            INSERT INTO abuse_counters AS c (key, failures, window_start, locked_until)
            VALUES (:k, 1, :n, CASE WHEN 1 >= :lim THEN CAST(:n AS timestamptz) + make_interval(secs => :lock) END)
            ON CONFLICT (key) DO UPDATE SET
              failures = CASE WHEN c.window_start < :n - make_interval(secs => :win) THEN 1 ELSE c.failures + 1 END,
              window_start = CASE WHEN c.window_start < :n - make_interval(secs => :win) THEN :n ELSE c.window_start END,
              locked_until = CASE
                WHEN (CASE WHEN c.window_start < :n - make_interval(secs => :win) THEN 1 ELSE c.failures + 1 END) >= :lim
                  THEN :n + make_interval(secs => :lock)
                WHEN c.locked_until IS NOT NULL AND c.locked_until > :n THEN c.locked_until
                END
            RETURNING failures"""),
            {"k": key[:100], "n": now, "win": window.total_seconds(), "lim": limit, "lock": lock.total_seconds()})
        db.commit()
    return int(n)


def throttle(key_limits: list[tuple[str, int]], *, window: timedelta, what: str) -> None:
    """Counts one event on every (key, limit) and raises 429 when any of them is over its limit (counted events still
    count). For endpoints where EVERY call is the thing to limit, e.g. creating an account."""
    over = 0
    for key, limit in key_limits:
        if hit(key, window=window, limit=limit + 1) > limit:  # the lockout starts on the first call over the limit
            over = max(over, locked_for([key]))
    if over:
        raise HTTPException(429, f"Too many {what}. Try again later.", headers={"Retry-After": str(over)})
