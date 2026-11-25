"""Token bucket in Postgres (shared by every worker/process; the row lock serialises takers)."""
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models import RateBucket


def take(db: Session, restaurant_id: str, key: str, *, capacity: float, refill_per_second: float,
         now: datetime) -> float:
    """Takes one token. Returns 0.0 when granted, else the seconds to wait until one token is available (nothing taken)."""
    db.execute(pg_insert(RateBucket).values(restaurant_id=restaurant_id, key=key, tokens=capacity, updated_at=now)
               .on_conflict_do_nothing())
    b = db.scalar(select(RateBucket).where(RateBucket.restaurant_id == restaurant_id, RateBucket.key == key)
                  .with_for_update())
    elapsed = max(0.0, (now - b.updated_at).total_seconds())
    tokens = min(capacity, b.tokens + elapsed * refill_per_second)
    b.updated_at = max(now, b.updated_at)
    if tokens >= 1.0:
        b.tokens = tokens - 1.0
        return 0.0
    b.tokens = tokens
    return (1.0 - tokens) / refill_per_second
