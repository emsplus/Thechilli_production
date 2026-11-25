import calendar
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import errors
from app.models import Plan, Subscription, Tenant, utcnow
from app.services import entitlements as ent


def add_months(d: datetime, n: int) -> datetime:
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    return d.replace(year=y, month=m, day=min(d.day, calendar.monthrange(y, m)[1]))


def period_end(start: datetime, plan: Plan) -> datetime:
    return add_months(start, 12 if plan.billing_period == "year" else 1)


def plan_by_code(db: Session, code: str) -> Plan:
    p = db.scalar(select(Plan).where(Plan.code == code))
    if p is None:
        raise errors.not_found(f"Plan {code} not found")
    if not p.is_active:
        raise errors.conflict(f"Plan {code} is not active", "plan_inactive")
    return p


def assign_plan(db: Session, tenant: Tenant, plan: Plan, actor: str, reason: str | None, trial_days: int | None = None) -> Subscription:
    """Starts a subscription, ending any live one. Entitlement diff is recorded."""
    if tenant.status == "closed":
        raise errors.conflict("Tenant is closed", "tenant_closed")
    now = utcnow()

    def mutate():
        cur = ent.live_subscription(db, tenant.id)
        if cur:
            cur.status, cur.ended_at = "cancelled", now
            db.flush()
        if trial_days:
            end = now + timedelta(days=trial_days)
            sub = Subscription(tenant_id=tenant.id, plan_id=plan.id, status="trialing", trial_end=end,
                               current_period_start=now, current_period_end=end)
        else:
            sub = Subscription(tenant_id=tenant.id, plan_id=plan.id, status="active", current_period_start=now,
                               current_period_end=period_end(now, plan))
        db.add(sub)
        return sub
    return ent.tracked_change(db, tenant, "subscription_changed" if ent.live_subscription(db, tenant.id) else "subscription_started",
                              actor, reason, mutate)


def cancel(db: Session, tenant: Tenant, actor: str, reason: str | None, at_period_end: bool) -> Subscription:
    sub = ent.live_subscription(db, tenant.id)
    if sub is None:
        raise errors.conflict("No live subscription", "no_subscription")

    def mutate():
        if at_period_end:
            sub.cancel_at_period_end = True
        else:
            sub.status, sub.ended_at = "cancelled", utcnow()
    return ent.tracked_change(db, tenant, "subscription_cancelled", actor, reason, lambda: (mutate(), sub)[1])
