"""The business time of a sale that was taken on a device and synced later (BREAK_CHAOS_REPORT.md D-05, INDEPENDENT_REVIEW_REPORT.md H1).

A device that was offline stamps each queued operation with `client_created_at`. That stamp is the device's own clock, which can be
minutes or hours wrong (a tablet 45 minutes slow would book a bill taken at 00:20 on 1 April into the old financial year), so it is never
used as it is. The batch (`POST /sync/operations`) carries one more field, `client_sent_at`: the device's clock at the moment the batch
is SENT. Then

    skew      = server_now - client_sent_at          (how far the device clock is behind the server; negative = ahead)
    corrected = client_created_at + skew             (a constant clock error cancels out, the real offline gap stays)

If `client_sent_at` is missing or unreadable (an old app), or |skew| is more than MAX_SKEW (24 h), ALL client times of the batch are ignored:
the server time is used and an audit row `sync.client_time_ignored` says why. Otherwise the plausibility window is applied to the
CORRECTED time: not more than FUTURE_SKEW (5 min) in the future (a smaller overshoot is read as "now") and not older than MAX_AGE (7 days);
outside it the server time is used and the fallback is audited, too.

The corrected time sets `bills.sale_at` (reports, receipt, e-invoice date), the invoice number's financial year and date,
`payments.created_at` and `orders.created_at`. Whenever the corrected time lands on a different local (IST) day or financial year than the
server time, an audit row `sync.client_time_adjusted` (raw time, skew, corrected time, server time) is written, so a back-dated sale is
always visible, also when it stays inside the window.

What does NOT move: `bills.finalized_at` (when the record was POSTED), which the X / Z reports, voids and the Z-close locking are built on,
and the invoice / credit-note NUMBERS, still allocated from the gap-free counters in posting order. A payment's time is never put before the
end of the last Z period or the close of the last cash session of the outlet, so a closed Z report or cash session never changes.
"""
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.core import Restaurant
from app.services import audit, localisation as L

FUTURE_SKEW = timedelta(minutes=5)
MAX_AGE = timedelta(days=7)
MAX_SKEW = timedelta(hours=24)
IGNORED_ACTION = "sync.client_time_ignored"
ADJUSTED_ACTION = "sync.client_time_adjusted"


def _aware(t: datetime) -> datetime:
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class ClientTime:
    """One operation's device time with the batch's clock correction. skew None = the batch's device clock was unusable."""
    raw: datetime
    skew: timedelta | None
    batch_reason: str | None

    @property
    def corrected(self) -> datetime | None:
        return None if self.skew is None else _aware(self.raw) + self.skew


class BatchClock:
    """The clock correction of one sync batch (computed once, from `client_sent_at` and the server's now)."""

    def __init__(self, client_sent_at: datetime | None, server_now: datetime):
        self.skew: timedelta | None = None
        self.reason: str | None = None
        if client_sent_at is None:
            self.reason = "batch_time_missing"
            return
        try:
            skew = server_now - _aware(client_sent_at)
        except OverflowError:
            skew = None
        if skew is None or abs(skew) > MAX_SKEW:
            self.reason = "batch_time_absurd"
            return
        self.skew = skew

    def stamp(self, raw: datetime | None) -> ClientTime | None:
        """None when the operation carries no device time (nothing to correct or audit)."""
        return None if raw is None else ClientTime(raw, self.skew, self.reason)


def resolve(ct: ClientTime | None, server_now: datetime) -> tuple[datetime, str | None]:
    """(time to use, reason the device time was refused or None)."""
    if ct is None:
        return server_now, None
    c = ct.corrected
    if c is None:
        return server_now, ct.batch_reason
    if c > server_now + FUTURE_SKEW:
        return server_now, "in_the_future"
    if c < server_now - MAX_AGE:
        return server_now, "older_than_7_days"
    return min(c, server_now), None


def _fy(local: datetime) -> int:
    return local.year if local.month >= L.FISCAL_YEAR_START_MONTH else local.year - 1


def record(db: Session, p, entity: str, entity_id: uuid.UUID, ct: ClientTime | None, used: datetime, server_now: datetime,
           ignored: str | None) -> None:
    """Audit rows of a device time (call after the entity has its id): `sync.client_time_ignored` when it was refused,
    `sync.client_time_adjusted` when the time that was used is on another local day or financial year than the server's now."""
    if ct is None:
        return
    base = {"client_created_at": _aware(ct.raw).isoformat(), "server_time": server_now.isoformat(),
            "skew_seconds": None if ct.skew is None else round(ct.skew.total_seconds())}
    if ignored:
        audit.record(db, p, IGNORED_ACTION, entity, entity_id, {**base, "used": server_now.isoformat(), "reason": ignored})
        return
    tz = ZoneInfo(db.scalar(select(Restaurant.timezone).where(Restaurant.id == p.restaurant_id)) or "Asia/Kolkata")
    a, b = used.astimezone(tz), server_now.astimezone(tz)
    moved = [k for k, differs in (("other_day", a.date() != b.date()), ("other_financial_year", _fy(a) != _fy(b))) if differs]
    if moved:
        audit.record(db, p, ADJUSTED_ACTION, entity, entity_id,
                     {**base, "corrected": used.isoformat(), "moved": moved})
