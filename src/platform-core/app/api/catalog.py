from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.common import get_or_404, snap, to_dict
from app.api.tenants import resolve_tenant
from app.core import errors
from app.core.db import get_db
from app.core.deps import Principal, require
from app.core.config import settings
from app.models import (EntitlementHistory, EntitlementOverride, Feature, Plan, PlanFeature, PlanVersion, Subscription, utcnow)
from app.services import entitlements as ent
from app.services import subscriptions as subs
from app.services import step_up as step_up_svc
from app.services.audit import audit, jsonable

router = APIRouter(tags=["catalog"])
CODE = r"^[a-z][a-z0-9_.]{1,63}$"


class FeatureIn(BaseModel):
    code: str = Field(pattern=CODE)
    name: str
    description: str | None = None
    kind: str = Field("flag", pattern="^(flag|limit)$")
    unit: str | None = None


class FeaturePatch(BaseModel):
    name: str | None = None
    description: str | None = None
    is_active: bool | None = None


class PlanFeatureIn(BaseModel):
    feature_code: str
    enabled: bool = True
    limit_value: int | None = Field(None, ge=0)


class PlanIn(BaseModel):
    code: str = Field(pattern=CODE)
    name: str
    description: str | None = None
    price_paise: int = Field(ge=0)
    billing_period: str = Field("month", pattern="^(month|year)$")
    features: list[PlanFeatureIn] = []


class PlanPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    price_paise: int | None = Field(None, ge=0)
    is_active: bool | None = None
    note: str | None = Field(None, max_length=500)


class PlanEdit(BaseModel):
    """Full edit of a plan (code and billing period are immutable). `expected_version` guards against two admins
    overwriting each other."""
    expected_version: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    price_paise: int = Field(ge=0)
    features: list[PlanFeatureIn]
    note: str | None = Field(None, max_length=500)


class PlanReason(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


def plan_view(db: Session, p: Plan) -> dict:
    rows = db.scalars(select(PlanFeature).where(PlanFeature.plan_id == p.id).order_by(PlanFeature.feature_code)).all()
    return {**to_dict(p), "features": [{"feature_code": r.feature_code, "enabled": r.enabled, "limit_value": r.limit_value} for r in rows]}


def _record_version(db: Session, plan: Plan, change: str, actor: str, note: str | None, first: bool = False) -> None:
    """Snapshot after a change; version n is the state after the n-th change. Called once per request."""
    db.flush()
    if not first:
        plan.version = (plan.version or 1) + 1
    snap_ = plan_view(db, plan)
    db.add(PlanVersion(plan_id=plan.id, version=plan.version, snapshot=jsonable(snap_), change=change, note=note, actor=actor))


def _with_usage(db: Session, p: Plan) -> dict:
    n = db.scalar(select(func.count()).select_from(Subscription).where(Subscription.plan_id == p.id, Subscription.status.in_(ent.LIVE)))
    return {**plan_view(db, p), "live_subscriptions": n}


def _set_plan_features(db, plan, feats: list[PlanFeatureIn]):
    codes = {f.code for f in db.scalars(select(Feature))}
    for f in feats:
        if f.feature_code not in codes:
            raise errors.bad(f"Unknown feature {f.feature_code}", "unknown_feature")
    for old in db.scalars(select(PlanFeature).where(PlanFeature.plan_id == plan.id)):
        db.delete(old)
    db.flush()
    for f in feats:
        db.add(PlanFeature(plan_id=plan.id, feature_code=f.feature_code, enabled=f.enabled, limit_value=f.limit_value))


def _subscribed_tenants(db, plan_id):
    from app.models import Tenant
    return db.scalars(select(Tenant).join(Subscription, Subscription.tenant_id == Tenant.id)
                      .where(Subscription.plan_id == plan_id, Subscription.status.in_(ent.LIVE))).all()


@router.get("/features")
def list_features(_: Principal = Depends(require("catalog.read", staff_only=True)), db: Session = Depends(get_db)):
    return {"items": [to_dict(f) for f in db.scalars(select(Feature).order_by(Feature.code))]}


@router.post("/features", status_code=201)
def create_feature(body: FeatureIn, p: Principal = Depends(require("catalog.manage", staff_only=True)), db: Session = Depends(get_db)):
    if db.get(Feature, body.code):
        raise errors.conflict("Feature code exists")
    f = Feature(**body.model_dump())
    db.add(f)
    audit(db, p, "feature.created", "feature", f.code, after=body.model_dump())
    return to_dict(f)


@router.patch("/features/{code}")
def patch_feature(code: str, body: FeaturePatch, p: Principal = Depends(require("catalog.manage", staff_only=True)),
                  db: Session = Depends(get_db)):
    f = get_or_404(db, Feature, code, "Feature")
    before = to_dict(f)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(f, k, v)
    audit(db, p, "feature.updated", "feature", f.code, before=before, after=to_dict(f))
    return to_dict(f)


@router.get("/plans")
def list_plans(_: Principal = Depends(require("catalog.read", staff_only=True)), db: Session = Depends(get_db)):
    return {"items": [_with_usage(db, p) for p in db.scalars(select(Plan).order_by(Plan.price_paise))]}


@router.get("/plans/{code}")
def get_plan(code: str, _: Principal = Depends(require("catalog.read", staff_only=True)), db: Session = Depends(get_db)):
    p = db.scalar(select(Plan).where(Plan.code == code))
    if not p:
        raise errors.not_found("Plan not found")
    return _with_usage(db, p)


@router.get("/plans/{code}/versions")
def plan_versions(code: str, _: Principal = Depends(require("catalog.read", staff_only=True)), db: Session = Depends(get_db)):
    p = db.scalar(select(Plan).where(Plan.code == code))
    if not p:
        raise errors.not_found("Plan not found")
    rows = db.scalars(select(PlanVersion).where(PlanVersion.plan_id == p.id).order_by(PlanVersion.version.desc())).all()
    return {"items": [{"version": r.version, "change": r.change, "note": r.note, "actor": r.actor, "at": r.at.isoformat(),
                       "snapshot": r.snapshot} for r in rows]}


@router.post("/plans", status_code=201)
def create_plan(body: PlanIn, p: Principal = Depends(require("catalog.manage", staff_only=True)), db: Session = Depends(get_db)):
    if db.scalar(select(Plan).where(Plan.code == body.code)):
        raise errors.conflict("Plan code exists")
    plan = Plan(**body.model_dump(exclude={"features"}))
    db.add(plan)
    db.flush()
    _set_plan_features(db, plan, body.features)
    _record_version(db, plan, "created", p.label, None, first=True)
    audit(db, p, "plan.created", "plan", plan.id, after=plan_view(db, plan))
    return plan_view(db, plan)


@router.patch("/plans/{code}")
def patch_plan(code: str, body: PlanPatch, request: Request, p: Principal = Depends(require("catalog.manage", staff_only=True)),
               db: Session = Depends(get_db)):
    if body.price_paise is not None or body.is_active is not None:  # price / retire: fresh second factor (docs/STEP_UP.md)
        step_up_svc.enforce(db, request, p)
    plan = db.scalar(select(Plan).where(Plan.code == code))
    if not plan:
        raise errors.not_found("Plan not found")
    before = to_dict(plan)
    data = body.model_dump(exclude_none=True, exclude={"note"})
    if data.get("is_active") is False:
        _guard_retire(db, plan)
    for k, v in data.items():
        setattr(plan, k, v)
    if "is_active" in data:
        plan.retired_at = None if plan.is_active else utcnow()
    _record_version(db, plan, "edited", p.label, body.note)
    audit(db, p, "plan.updated", "plan", plan.id, before=before, after=to_dict(plan))
    return plan_view(db, plan)


def _guard_retire(db: Session, plan: Plan) -> None:
    if plan.code == settings.default_trial_plan_code:
        raise errors.conflict("This is the default trial plan for new signups; change DEFAULT_TRIAL_PLAN_CODE first", "plan_is_default")


@router.put("/plans/{code}")
def edit_plan(code: str, body: PlanEdit, p: Principal = Depends(require("catalog.manage", staff_only=True, step_up=True)), db: Session = Depends(get_db)):
    """Edit name/description/price and the whole feature+limit set in one versioned, audited step. Tenants already on
    the plan get the new features immediately (diff recorded per tenant); the new price applies to invoices created from now on."""
    plan = db.scalar(select(Plan).where(Plan.code == code).with_for_update())
    if not plan:
        raise errors.not_found("Plan not found")
    if plan.version != body.expected_version:
        raise errors.conflict(f"Plan is at version {plan.version}; reload and retry", "version_conflict")
    before = plan_view(db, plan)
    tenants = _subscribed_tenants(db, plan.id)
    befores = {t.id: ent.compute(db, t) for t in tenants}
    plan.name, plan.description, plan.price_paise = body.name, body.description, body.price_paise
    _set_plan_features(db, plan, body.features)
    db.flush()
    for t in tenants:
        ent.record_diff(db, t.id, befores[t.id], ent.compute(db, t), "plan_edited", p.label, f"plan {code} v{plan.version + 1}")
    _record_version(db, plan, "edited", p.label, body.note)
    audit(db, p, "plan.edited", "plan", plan.id, before=before, after=plan_view(db, plan),
          meta={"version": plan.version, "tenants_affected": len(tenants), "note": body.note})
    return _with_usage(db, plan)


@router.post("/plans/{code}/retire")
def retire_plan(code: str, body: PlanReason, p: Principal = Depends(require("catalog.manage", staff_only=True, step_up=True)), db: Session = Depends(get_db)):
    """Retired plans cannot be newly assigned; tenants already on one keep it (grandfathered). Plans are never deleted."""
    plan = db.scalar(select(Plan).where(Plan.code == code).with_for_update())
    if not plan:
        raise errors.not_found("Plan not found")
    if not plan.is_active:
        raise errors.conflict("Plan is already retired", "plan_retired")
    _guard_retire(db, plan)
    plan.is_active, plan.retired_at = False, utcnow()
    _record_version(db, plan, "retired", p.label, body.reason)
    audit(db, p, "plan.retired", "plan", plan.id, meta={"reason": body.reason, "version": plan.version})
    return _with_usage(db, plan)


@router.post("/plans/{code}/reactivate")
def reactivate_plan(code: str, body: PlanReason, p: Principal = Depends(require("catalog.manage", staff_only=True, step_up=True)), db: Session = Depends(get_db)):
    plan = db.scalar(select(Plan).where(Plan.code == code).with_for_update())
    if not plan:
        raise errors.not_found("Plan not found")
    if plan.is_active:
        raise errors.conflict("Plan is already active", "plan_active")
    plan.is_active, plan.retired_at = True, None
    _record_version(db, plan, "reactivated", p.label, body.reason)
    audit(db, p, "plan.reactivated", "plan", plan.id, meta={"reason": body.reason, "version": plan.version})
    return _with_usage(db, plan)


@router.put("/plans/{code}/features")
def put_plan_features(code: str, body: list[PlanFeatureIn], p: Principal = Depends(require("catalog.manage", staff_only=True)),
                      db: Session = Depends(get_db)):
    """Replaces the plan's feature set. Entitlements of every tenant on this plan change, and each diff is recorded."""
    plan = db.scalar(select(Plan).where(Plan.code == code))
    if not plan:
        raise errors.not_found("Plan not found")
    before = plan_view(db, plan)
    tenants = _subscribed_tenants(db, plan.id)
    befores = {t.id: ent.compute(db, t) for t in tenants}
    _set_plan_features(db, plan, body)
    db.flush()
    for t in tenants:
        ent.record_diff(db, t.id, befores[t.id], ent.compute(db, t), "plan_features_changed", p.label, f"plan {code}")
    _record_version(db, plan, "edited", p.label, "features replaced")
    audit(db, p, "plan.features_replaced", "plan", plan.id, before=before, after=plan_view(db, plan), meta={"tenants_affected": len(tenants)})
    return plan_view(db, plan)


# ---------- subscriptions ----------
class SubscribeIn(BaseModel):
    plan_code: str
    trial_days: int | None = Field(None, ge=1, le=90)
    reason: str | None = None


class CancelIn(BaseModel):
    at_period_end: bool = True
    reason: str | None = None


@router.get("/tenants/{ref}/subscription")
def get_subscription(ref: str, _: Principal = Depends(require("subscriptions.read", service_scope="subscriptions.read")),
                     db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    sub = ent.live_subscription(db, t.id)
    history = db.scalars(select(Subscription).where(Subscription.tenant_id == t.id).order_by(Subscription.created_at.desc())).all()
    return {"current": to_dict(sub) if sub else None, "history": [to_dict(s) for s in history]}


@router.post("/tenants/{ref}/subscription", status_code=201)
def set_subscription(ref: str, body: SubscribeIn, p: Principal = Depends(require("subscriptions.manage", staff_only=True)),
                     db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    plan = subs.plan_by_code(db, body.plan_code)
    prev = ent.live_subscription(db, t.id)
    before = to_dict(prev) if prev else None
    sub = subs.assign_plan(db, t, plan, p.label, body.reason, body.trial_days)
    audit(db, p, "subscription.assigned", "subscription", sub.id, t.id, before=before, after=to_dict(sub), meta={"reason": body.reason})
    return to_dict(sub)


@router.post("/tenants/{ref}/subscription/cancel")
def cancel_subscription(ref: str, body: CancelIn, p: Principal = Depends(require("subscriptions.manage", staff_only=True)),
                        db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    sub = subs.cancel(db, t, p.label, body.reason, body.at_period_end)
    audit(db, p, "subscription.cancelled", "subscription", sub.id, t.id, after=to_dict(sub), meta={"reason": body.reason})
    return to_dict(sub)


@router.get("/subscriptions")
def list_subscriptions(status: str | None = None, _: Principal = Depends(require("subscriptions.read", staff_only=True)),
                       db: Session = Depends(get_db)):
    stmt = select(Subscription).order_by(Subscription.created_at.desc()).limit(200)
    if status:
        stmt = stmt.where(Subscription.status == status)
    return {"items": [to_dict(s) for s in db.scalars(stmt)]}


# ---------- entitlements ----------
class OverrideIn(BaseModel):
    enabled: bool
    limit_value: int | None = Field(None, ge=0)
    reason: str = Field(min_length=3)
    expires_at: str | None = None


@router.get("/entitlements/{ref}")
def get_entitlements(ref: str, _: Principal = Depends(require("entitlements.read", service_scope="entitlements.read")),
                     db: Session = Depends(get_db)):
    """Entitlement check for other services. Auth: Bearer staff token or X-Service-Key with `entitlements.read`.
    `ref` is a tenant id or slug. Unknown tenant -> 404 (callers must fail closed)."""
    t = resolve_tenant(db, ref)
    snap_ = ent.compute(db, t)
    return {**snap_, "version": ent.version_of(snap_), "generated_at": utcnow().isoformat()}


class PlanRef(BaseModel):
    code: str
    name: str


class FeatureState(BaseModel):
    enabled: bool
    limit: int | None


class EntitlementsContract(BaseModel):
    tenant_id: str
    status: Literal["active", "suspended", "past_due"]
    status_reason: str
    plan: PlanRef | None
    outlet_limit: int | None
    features: dict[str, FeatureState]
    version: str
    billing: dict  # PAYG wallet block, docs/PAYG_BILLING.md
    generated_at: str


@router.get("/tenants/{ref}/entitlements", response_model=EntitlementsContract)
def tenant_entitlements(ref: str, _: Principal = Depends(require("entitlements.read", service_scope="entitlements.read")),
                        db: Session = Depends(get_db)):
    """Contract for pos-service (docs/entitlements-contract.md). Auth: X-Service-Key with scope `entitlements:read`
    (or staff with entitlements.read). Unknown tenant -> 404; callers must fail closed."""
    return ent.contract_view(db, resolve_tenant(db, ref))


@router.get("/entitlements/{ref}/history")
def entitlement_history(ref: str, limit: int = 100, _: Principal = Depends(require("entitlements.read", staff_only=True)),
                        db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    rows = db.scalars(select(EntitlementHistory).where(EntitlementHistory.tenant_id == t.id)
                      .order_by(EntitlementHistory.id.desc()).limit(min(limit, 500))).all()
    return {"items": [to_dict(r) for r in rows]}


@router.put("/entitlements/{ref}/overrides/{feature}")
def put_override(ref: str, feature: str, body: OverrideIn, p: Principal = Depends(require("entitlements.override", staff_only=True, step_up=True)),
                 db: Session = Depends(get_db)):
    from datetime import datetime
    t = resolve_tenant(db, ref)
    get_or_404(db, Feature, feature, "Feature")
    exp = None
    if body.expires_at:
        try:
            exp = datetime.fromisoformat(body.expires_at)
        except ValueError:
            raise errors.bad("expires_at must be ISO-8601")
        if exp.tzinfo is None:
            raise errors.bad("expires_at needs a timezone offset")
        if exp <= utcnow():
            raise errors.bad("expires_at must be in the future")
    old = db.get(EntitlementOverride, (t.id, feature))
    before = to_dict(old) if old else None

    def mutate():
        o = old or EntitlementOverride(tenant_id=t.id, feature_code=feature, created_by=p.label)
        o.enabled, o.limit_value, o.reason, o.expires_at, o.created_by = body.enabled, body.limit_value, body.reason, exp, p.label
        db.add(o)
        return o
    o = ent.tracked_change(db, t, "override_set", p.label, body.reason, mutate)
    audit(db, p, "entitlement.override_set", "tenant", t.id, t.id, before=before, after=to_dict(o), meta={"feature": feature})
    return to_dict(o)


@router.delete("/entitlements/{ref}/overrides/{feature}")
def delete_override(ref: str, feature: str, p: Principal = Depends(require("entitlements.override", staff_only=True, step_up=True)),
                    db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    o = db.get(EntitlementOverride, (t.id, feature))
    if o is None:
        raise errors.not_found("Override not found")
    before = to_dict(o)
    ent.tracked_change(db, t, "override_removed", p.label, None, lambda: db.delete(o))
    audit(db, p, "entitlement.override_removed", "tenant", t.id, t.id, before=before, meta={"feature": feature})
    return {"ok": True}


func  # noqa
snap  # noqa
