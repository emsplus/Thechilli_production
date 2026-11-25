"""Kitchen status tracking (docs/KOT_ONLY_KITCHEN.md).

Two modes per restaurant (restaurants.kitchen_status_mode, owner setting, default KOT-only):

* ``kot_only``  the kitchen just receives the ticket. The only step is **Done** (POST /kot/{id}/done): one completed flag
                (``kot_tickets.done_at``; the ticket's status becomes ``served`` with it so cancellation / reports / the delivery
                module keep seeing "finished"). Preparing / ready / served can NOT be set (409 `kitchen_status_off`).
* ``track``     the full workflow new -> preparing -> ready -> served (PATCH /kot/{id}), unchanged.

Nothing else depends on the ticket status: billing needs a ticket to exist (require_kot_before_bill), never a ready / served one.
"""
from __future__ import annotations

import uuid

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.core import Kot, KotStatus, Restaurant
from app.services import audit
from app.services.order_rules import RuleError

KOT_ONLY, TRACK = "kot_only", "track"
STATUSES_NEEDING_TRACKING = (KotStatus.preparing, KotStatus.ready, KotStatus.served)


def mode_of(db: Session, restaurant_id: uuid.UUID) -> str:
    return db.scalar(select(Restaurant.kitchen_status_mode).where(Restaurant.id == restaurant_id)) or KOT_ONLY


def set_status(db: Session, kot: Kot, status: KotStatus) -> None:
    """PATCH /kot/{id}. KOT-only: only `cancelled` and `pending` (re-open a ticket marked Done by mistake) are accepted."""
    if mode_of(db, kot.restaurant_id) == KOT_ONLY and status in STATUSES_NEEDING_TRACKING:
        raise RuleError(409, "kitchen_status_off",
                        "This restaurant uses KOT-only kitchen: the kitchen just taps Done. Turn on 'Track Preparing / Ready / "
                        "Served' in Manage > Restaurant > Kitchen to use statuses.", mode=KOT_ONLY)
    kot.status = status
    kot.done_at = db_now(db) if status == KotStatus.served else None


def mark_done(db: Session, kot: Kot) -> bool:
    """The single Done step (either mode). Idempotent: an already finished ticket is left as it is (False). The caller has locked
    the ticket and checked it is not cancelled."""
    if kot.done_at is not None and kot.status == KotStatus.served:
        return False
    kot.status = KotStatus.served
    kot.done_at = kot.done_at or db_now(db)
    return True


def db_now(db: Session):
    """Wall-clock time at this instant (same as billing.db_now; local so billing can import this module)."""
    return db.scalar(select(func.clock_timestamp()))


def done_for_bill(db: Session, p, order_id: uuid.UUID) -> int:
    """The bill of an order was generated: its kitchen tickets leave the Kitchen board (docs/KOT_ONLY_KITCHEN.md, "Bill generated").
    Every ticket of the order that is not cancelled and not yet done goes through mark_done (done_at, status served), one audit row
    `kot.done` each (detail.reason = bill_finalized). Idempotent: already done tickets are untouched. Only tickets that exist NOW are
    touched, so a later KOT of the same order still shows, and paying / voiding the bill changes nothing. Called by
    billing.finalize_bill (REST and offline sync) in the bill's transaction; the caller commits. Returns how many tickets it closed."""
    n = 0
    for k in db.scalars(select(Kot).where(Kot.order_id == order_id, Kot.status != KotStatus.cancelled,
                                          Kot.done_at.is_(None)).order_by(Kot.number).with_for_update()):
        if mark_done(db, k):
            audit.record(db, p, "kot.done", "kot", k.id, {"number": k.number, "reason": "bill_finalized"})
            n += 1
    return n


# ------------------------------------------------------------------------------------------------ "in kitchen"
def active_ticket_clauses(db: Session, restaurant_id: uuid.UUID, outlet_ids: list[uuid.UUID]) -> tuple[list, dict]:
    """WHERE clauses of an ACTIVE kitchen ticket (one on the Kitchen board right now), and the settings they came from.
    Common: not cancelled, `done_at` null (not done, not served). KOT-only mode adds the display window the board uses to clear tickets
    by themselves: arrived within `kitchen_display_minutes` AND since the start of the restaurant-local day. Track mode has no window
    (an open ticket stays on the board until the kitchen serves it)."""
    r = db.get(Restaurant, restaurant_id)
    mode, minutes, tz = r.kitchen_status_mode or KOT_ONLY, r.kitchen_display_minutes or 20, ZoneInfo(r.timezone or "Asia/Kolkata")
    clauses = [Kot.restaurant_id == restaurant_id, Kot.outlet_id.in_(outlet_ids), Kot.status != KotStatus.cancelled, Kot.done_at.is_(None)]
    if mode == KOT_ONLY:
        now = db_now(db)
        day_start = now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)
        clauses.append(Kot.created_at >= max(now - timedelta(minutes=minutes), day_start.astimezone(timezone.utc)))
    return clauses, {"mode": mode, "display_minutes": minutes}


def in_kitchen_summary(db: Session, restaurant_id: uuid.UUID, outlet_ids: list[uuid.UUID]) -> dict:
    """THE shared "in kitchen" figure (Orders screen `GET /orders/summary` and the Kitchen board `GET /kot/summary` both call this):
    `in_kitchen` = number of ORDERS with at least one active ticket, `tickets` = number of active tickets."""
    clauses, cfg = active_ticket_clauses(db, restaurant_id, outlet_ids)
    orders, tickets = db.execute(select(func.count(func.distinct(Kot.order_id)), func.count(Kot.id)).where(*clauses)).one()
    return {"in_kitchen": orders, "tickets": tickets, "kitchen_status_mode": cfg["mode"], "kitchen_display_minutes": cfg["display_minutes"]}
