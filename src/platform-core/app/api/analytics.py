"""Platform analytics (MRR, active tenants, churn, signups by source) and CSV exports. Platform facts only: no tenant
operational data. Money is integer paise, excl. GST; ratios are integer basis points."""
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, Response
from sqlalchemy import and_, case, exists, func, or_, select
from sqlalchemy.orm import Session

from app.core import errors
from app.core.db import get_db
from app.core.deps import Principal, require
from app.models import OnboardingApplication, Plan, Subscription, Tenant, utcnow
from app.services import entitlements as ent
from app.services.audit import audit
from app.services.csvsafe import to_csv

router = APIRouter(tags=["analytics"])
PAYING = ("active", "past_due")  # MRR counts paying subscriptions; trials are not revenue yet
SOURCES = ("self_signup", "marketing", "staff")
REPORTS = ("mrr_by_plan", "signups", "subscriptions", "tenants")


def _window(since: str | None, until: str | None) -> tuple[datetime, datetime]:
    def parse(v, end):
        try:
            d = date.fromisoformat(v)
        except ValueError:
            raise errors.bad("since/until must be YYYY-MM-DD")
        return datetime.combine(d + timedelta(days=1 if end else 0), time.min, tzinfo=timezone.utc)
    now = utcnow()
    u = parse(until, True) if until else now + timedelta(seconds=1)
    s = parse(since, False) if since else u - timedelta(days=90)
    if s >= u:
        raise errors.bad("since must be before until")
    if (u - s).days > 3660:
        raise errors.bad("window too large")
    return s, u


def _monthly_paise(price, period):
    return case((period == "year", price / 12), else_=price)  # integer division in SQL: truncates, never invents revenue


def mrr_by_plan(db: Session) -> list[dict]:
    rows = db.execute(select(Plan.code, Plan.name, func.count(Subscription.id), func.coalesce(func.sum(_monthly_paise(Plan.price_paise, Plan.billing_period)), 0))
                      .join(Subscription, Subscription.plan_id == Plan.id).where(Subscription.status.in_(PAYING))
                      .group_by(Plan.code, Plan.name, Plan.price_paise).order_by(Plan.code)).all()
    merged: dict[str, dict] = {}
    for code, name, n, m in rows:
        d = merged.setdefault(code, {"plan_code": code, "plan_name": name, "subscriptions": 0, "mrr_paise": 0})
        d["subscriptions"] += n
        d["mrr_paise"] += int(m)
    return list(merged.values())


def signups(db: Session, s: datetime, u: datetime) -> dict:
    cond = and_(OnboardingApplication.created_at >= s, OnboardingApplication.created_at < u)
    by_source = {k: 0 for k in SOURCES}
    for src, n in db.execute(select(OnboardingApplication.source, func.count()).where(cond).group_by(OnboardingApplication.source)):
        by_source[src] = by_source.get(src, 0) + n
    month = func.to_char(func.timezone("UTC", OnboardingApplication.created_at), "YYYY-MM")
    months: dict[str, dict] = {}
    for m, src, n in db.execute(select(month, OnboardingApplication.source, func.count()).where(cond).group_by(month, OnboardingApplication.source).order_by(month)):
        months.setdefault(m, {"month": m, **{k: 0 for k in SOURCES}})[src] = n
    return {"total": sum(by_source.values()), "by_source": by_source, "by_month": list(months.values())}


def churn(db: Session, s: datetime, u: datetime) -> dict:
    """Logo churn of the opening cohort: tenants subscribed at `since` that ended a subscription inside the window and have
    none live now (plan switches end a subscription too, but the tenant then has a live one, so they are not churn)."""
    opening = select(Subscription.tenant_id).where(Subscription.created_at < s, or_(Subscription.ended_at.is_(None), Subscription.ended_at >= s)).distinct()
    live_now = exists().where(Subscription.tenant_id == Tenant.id, Subscription.status.in_(ent.LIVE))
    ended = exists().where(Subscription.tenant_id == Tenant.id, Subscription.status.in_(("cancelled", "expired")),
                           Subscription.ended_at >= s, Subscription.ended_at < u)
    n_open = db.scalar(select(func.count()).select_from(opening.subquery()))
    n_churn = db.scalar(select(func.count()).select_from(Tenant).where(Tenant.id.in_(opening), ended, ~live_now))
    return {"opening_tenants": n_open, "churned_tenants": n_churn, "rate_bps": (n_churn * 10000 // n_open) if n_open else 0}


@router.get("/analytics/overview")
def overview(since: str | None = None, until: str | None = None, _: Principal = Depends(require("analytics.read", staff_only=True)),
             db: Session = Depends(get_db)):
    s, u = _window(since, until)
    plans = mrr_by_plan(db)
    mrr = sum(p["mrr_paise"] for p in plans)
    by_status = {k: n for k, n in db.execute(select(Tenant.status, func.count()).group_by(Tenant.status))}
    entitled = exists().where(Subscription.tenant_id == Tenant.id, Subscription.status.in_(ent.LIVE))
    active = db.scalar(select(func.count()).select_from(Tenant).where(Tenant.status == "active", entitled))
    trialing = db.scalar(select(func.count(func.distinct(Subscription.tenant_id))).where(Subscription.status == "trialing"))
    return {"as_of": utcnow().isoformat(), "window": {"since": s.date().isoformat(), "until": (u - timedelta(days=1)).date().isoformat() if until else None},
            "mrr_paise": mrr, "arr_paise": mrr * 12, "mrr_by_plan": plans,
            "paying_subscriptions": sum(p["subscriptions"] for p in plans),
            "active_tenants": active, "trialing_tenants": trialing, "tenants_by_status": by_status,
            "churn": churn(db, s, u), "signups": signups(db, s, u),
            "notes": {"mrr": "active + past_due subscriptions, excl. GST; yearly plans / 12 (truncated); trials excluded",
                      "churn": "opening-cohort tenants with an ended subscription in the window and none live now"}}


@router.get("/analytics/export")
def export(report: str, since: str | None = None, until: str | None = None,
           p: Principal = Depends(require("analytics.export", staff_only=True)), db: Session = Depends(get_db)):
    if report not in REPORTS:
        raise errors.bad(f"report must be one of {', '.join(REPORTS)}", "bad_report")
    s, u = _window(since, until)
    if report == "mrr_by_plan":
        header = ["plan_code", "plan_name", "subscriptions", "mrr_paise"]
        rows = [[r["plan_code"], r["plan_name"], r["subscriptions"], r["mrr_paise"]] for r in mrr_by_plan(db)]
    elif report == "signups":
        header = ["month", *SOURCES, "total"]
        rows = [[m["month"], *(m[k] for k in SOURCES), sum(m[k] for k in SOURCES)] for m in signups(db, s, u)["by_month"]]
    elif report == "subscriptions":
        header = ["tenant_slug", "tenant_name", "plan_code", "status", "price_paise", "billing_period", "period_start", "period_end", "trial_end", "cancel_at_period_end"]
        q = select(Tenant.slug, Tenant.display_name, Plan.code, Subscription.status, Plan.price_paise, Plan.billing_period,
                   Subscription.current_period_start, Subscription.current_period_end, Subscription.trial_end, Subscription.cancel_at_period_end
                   ).join(Subscription, Subscription.tenant_id == Tenant.id).join(Plan, Plan.id == Subscription.plan_id
                   ).where(Subscription.status.in_(ent.LIVE)).order_by(Tenant.slug)
        rows = [[*r[:6], *(x.isoformat() if x else None for x in r[6:9]), r[9]] for r in db.execute(q)]
    else:
        header = ["slug", "name", "status", "created_at"]
        q = select(Tenant.slug, Tenant.display_name, Tenant.status, Tenant.created_at).where(Tenant.created_at >= s, Tenant.created_at < u).order_by(Tenant.created_at)
        rows = [[a, b, c, d.isoformat()] for a, b, c, d in db.execute(q)]
    audit(db, p, "analytics.exported", "report", report, meta={"report": report, "rows": len(rows)})
    name = f"{report}-{utcnow().date().isoformat()}.csv"
    return Response(to_csv(header, rows), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "X-Content-Type-Options": "nosniff"})
