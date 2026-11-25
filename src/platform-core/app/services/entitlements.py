"""Effective entitlements = active plan features, plus business-type defaults (BUSINESS_TYPE_DEFAULTS, the union over the
tenant's selected business_types: e.g. a cloud kitchen gets delivery whatever its plan), overlaid with unexpired per-tenant
overrides, all switched off while the tenant is suspended/closed or has no live subscription. Every change is recorded in entitlement_history (diff of effective
state before vs after), so history explains *why* access changed."""
import hashlib
import json
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import (EntitlementHistory, EntitlementOverride, Feature, Plan, PlanFeature, Subscription, Tenant, utcnow)

LIVE = ("trialing", "active", "past_due")

# Features switched on by a business type regardless of plan (a staff override can still switch them off). A tenant gets the
# UNION over its selected business_types (restaurant + cloud_kitchen -> delivery + aggregator). Only features present and active
# in the catalog are reported. Restaurant-only tenants follow their plan. hotel_kitchen = the cloud-kitchen setup.
BUSINESS_TYPE_DEFAULTS: dict[str, frozenset[str]] = {
    "restaurant": frozenset(),
    "cloud_kitchen": frozenset({"delivery", "aggregator"}),
    "hotel_kitchen": frozenset({"delivery", "aggregator"}),
}


def business_type_defaults(business_types) -> frozenset[str]:
    return frozenset().union(*(BUSINESS_TYPE_DEFAULTS.get(t, frozenset()) for t in (business_types or ())))


def live_subscription(db: Session, tenant_id) -> Subscription | None:
    return db.scalar(select(Subscription).where(Subscription.tenant_id == tenant_id, Subscription.status.in_(LIVE)))


def sub_entitled(sub: Subscription | None, now: datetime, payg: bool = False) -> tuple[bool, str]:
    """`payg`: the plan bills per bill from the wallet (docs/PAYG_BILLING.md), so the end of the trial does NOT switch features
    off: the wallet state decides whether new bills may be created."""
    if sub is None:
        return False, "no_subscription"
    if sub.status == "trialing" and sub.trial_end and sub.trial_end < now and not payg:
        return False, "trial_ended"
    if sub.status == "past_due" and not settings.past_due_keeps_entitlements:
        return False, "past_due"
    if sub.cancel_at_period_end and sub.current_period_end < now:
        return False, "cancelled"
    return True, "ok"


def compute(db: Session, tenant: Tenant, now: datetime | None = None) -> dict:
    now = now or utcnow()
    feats = {f.code: f for f in db.scalars(select(Feature).where(Feature.is_active.is_(True)))}
    sub = live_subscription(db, tenant.id)
    plan = db.get(Plan, sub.plan_id) if sub else None
    entitled, why = sub_entitled(sub, now, is_payg(db, tenant, plan))
    tenant_ok = tenant.status == "active"
    out: dict[str, dict] = {}
    plan_rows = {}
    if plan:
        plan_rows = {r.feature_code: r for r in db.scalars(select(PlanFeature).where(PlanFeature.plan_id == plan.id))}
    ovr = {o.feature_code: o for o in db.scalars(select(EntitlementOverride).where(EntitlementOverride.tenant_id == tenant.id))
           if o.expires_at is None or o.expires_at > now}
    type_defaults = business_type_defaults(tenant.business_types)
    for code in sorted(feats):
        row, o = plan_rows.get(code), ovr.get(code)
        if not tenant_ok:
            out[code] = {"enabled": False, "limit": None, "source": f"tenant_{tenant.status}"}
        elif o is not None:
            out[code] = {"enabled": o.enabled, "limit": o.limit_value if o.enabled else None, "source": "override"}
        elif entitled and row is not None and row.enabled:
            out[code] = {"enabled": True, "limit": row.limit_value, "source": "plan"}
        elif entitled and code in type_defaults:
            out[code] = {"enabled": True, "limit": None, "source": "business_type"}
        else:
            out[code] = {"enabled": False, "limit": None, "source": "plan" if entitled else why}
    return {"tenant_id": str(tenant.id), "tenant_status": tenant.status, "business_types": list(tenant.business_types or []), "plan_code": plan.code if plan else None,
            "subscription_status": sub.status if sub else None, "subscription_reason": why, "features": out}


def is_payg(db: Session, tenant: Tenant, plan: Plan | None) -> bool:
    from app.services import wallet
    return plan is not None and wallet.effective(db, tenant.id, plan.id).metered


def version_of(snapshot: dict) -> str:
    body = json.dumps({"s": snapshot["tenant_status"], "f": snapshot["features"]}, sort_keys=True)
    return hashlib.sha256(body.encode()).hexdigest()[:16]


def record_diff(db: Session, tenant_id, before: dict, after: dict, trigger: str, actor: str, reason: str | None) -> int:
    n = 0
    for code in sorted(set(before["features"]) | set(after["features"])):
        b, a = before["features"].get(code), after["features"].get(code)
        if b != a:
            db.add(EntitlementHistory(tenant_id=tenant_id, feature_code=code, before=b, after=a, trigger=trigger,
                                      actor=actor, reason=reason))
            n += 1
    return n


def tracked_change(db: Session, tenant: Tenant, trigger: str, actor: str, reason: str | None, mutate):
    """Compute effective entitlements, run mutate(), flush, compute again and record the diff."""
    before = compute(db, tenant)
    result = mutate()
    db.flush()
    after = compute(db, tenant)
    record_diff(db, tenant.id, before, after, trigger, actor, reason)
    return result


OUTLET_FEATURE = "outlets.max"


def contract_view(db: Session, tenant: Tenant, now: datetime | None = None) -> dict:
    """Stable, minimal read model for pos-service (docs/entitlements-contract.md). Derived from compute(); do not
    add fields without updating the doc and tests/test_entitlements_contract.py."""
    from app.services import wallet
    now = now or utcnow()
    snap = compute(db, tenant, now)
    sub = live_subscription(db, tenant.id)
    plan = db.get(Plan, sub.plan_id) if sub else None
    entitled, why = sub_entitled(sub, now, is_payg(db, tenant, plan))
    if tenant.status != "active":
        status, reason = "suspended", f"tenant_{tenant.status}"
    elif not entitled:
        status, reason = "suspended", why
    elif sub.status == "past_due":
        status, reason = "past_due", "past_due"
    else:
        status, reason = "active", "ok"
    feats = {c: {"enabled": f["enabled"], "limit": f["limit"]} for c, f in snap["features"].items()}
    o = feats.get(OUTLET_FEATURE)
    outlet_limit = (o["limit"] if o["enabled"] else 0) if o else 0  # null = unlimited, 0 = none
    return {"tenant_id": snap["tenant_id"], "status": status, "status_reason": reason,
            "plan": {"code": plan.code, "name": plan.name} if plan else None,
            "outlet_limit": outlet_limit, "features": feats, "version": version_of(snap),
            "billing": wallet.view(db, tenant, now),  # PAYG wallet state; NOT part of `version` (changes with every bill)
            "generated_at": now.isoformat()}
