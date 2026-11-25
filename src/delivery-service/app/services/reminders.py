from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import pos as pos_mod
from app.models import TERMINAL, DeliveryOrder, Reminder
from app.pos.base import PosError
from app.services import orders as svc


def run_due_reminders(db: Session, now: datetime | None = None, restaurant_id: str | None = None) -> int:
    """Each stage re-checks the live POS status before acting. Stages: 0,1 = unaccepted nudge to managers,
    2 = no rider accepted -> reassign, 3 = escalate to managers."""
    now = now or datetime.now(UTC)
    q = select(Reminder).where(Reminder.done.is_(False), Reminder.due_at <= now)
    if restaurant_id:
        q = q.where(Reminder.restaurant_id == restaurant_id)
    due = db.scalars(q
                     .order_by(Reminder.due_at).limit(100).with_for_update(skip_locked=True)).all()
    fired = 0
    for rem in due:
        o = db.get(DeliveryOrder, rem.order_id)
        rem.done = True
        if o.status in TERMINAL:
            continue
        try:
            live = pos_mod.get_pos_client(db, o.restaurant_id).get_order(o.restaurant_id, o.pos_order_id)
            svc.apply_pos_status(db, o, live.get("status"), live.get("version", 0))
        except PosError:
            pass  # POS unreachable: act on the mirror
        if o.status in TERMINAL:
            continue
        if rem.stage in (0, 1) and o.status == "placed":
            svc.alert_managers(db, o, "order not accepted yet")
            fired += 1
        elif rem.stage == 2 and o.rider_id is None and o.status != "out_for_delivery":
            svc.auto_assign(db, o)
            fired += 1
        elif rem.stage == 3 and o.status != "out_for_delivery":
            svc.alert_managers(db, o, "order still not dispatched")
            fired += 1
    db.commit()
    return fired
