"""Audit/security reads, AI usage (append-only), system health + heartbeats, global config."""
import re
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.api.common import Page, paged, to_dict
from app.api.tenants import resolve_tenant
from app.core import errors
from app.core.config import settings
from app.core.db import get_db
from app.core.deps import Principal, require
from app.core.security import get_keyring
from app.models import (AiUsageRecord, AuditLog, GlobalConfig, JobHeartbeat, OnboardingApplication, SecurityEvent, utcnow)
from app.services.audit import audit

router = APIRouter(tags=["ops"])


def _since(v: str | None):
    if not v:
        return None
    try:
        d = datetime.fromisoformat(v)
    except ValueError:
        raise errors.bad("since must be ISO-8601 with timezone")
    if d.tzinfo is None:
        raise errors.bad("since must include a timezone offset")
    return d


@router.get("/audit-log")
def audit_log(page: Page = Depends(), action: str | None = None, tenant: str | None = None, actor_id: str | None = None,
              since: str | None = None, _: Principal = Depends(require("audit.read", staff_only=True)), db: Session = Depends(get_db)):
    stmt = select(AuditLog)
    if action:
        stmt = stmt.where(AuditLog.action.like(action.replace("*", "%")))
    if tenant:
        stmt = stmt.where(AuditLog.tenant_id == resolve_tenant(db, tenant).id)
    if actor_id:
        stmt = stmt.where(AuditLog.actor_id == actor_id)
    if s := _since(since):
        stmt = stmt.where(AuditLog.at >= s)
    return paged(db, stmt, page, AuditLog, AuditLog.id.desc())


@router.get("/security-events")
def security_events(page: Page = Depends(), type: str | None = None, severity: str | None = None,
                    _: Principal = Depends(require("security.read", staff_only=True)), db: Session = Depends(get_db)):
    stmt = select(SecurityEvent)
    if type:
        stmt = stmt.where(SecurityEvent.type == type)
    if severity:
        stmt = stmt.where(SecurityEvent.severity == severity)
    return paged(db, stmt, page, SecurityEvent, SecurityEvent.id.desc())


# ---------- AI usage ----------
class AiUsageIn(BaseModel):
    tenant: str
    external_id: str = Field(min_length=1, max_length=100)
    feature: str
    provider: str
    model: str
    input_tokens: int = Field(0, ge=0)
    output_tokens: int = Field(0, ge=0)
    cost_micro_inr: int = Field(0, ge=0)


class AiUsageBatch(BaseModel):
    records: list[AiUsageIn] = Field(min_length=1, max_length=500)


@router.post("/ai-usage", status_code=201)
def ingest_ai_usage(body: AiUsageBatch, p: Principal = Depends(require("ai_usage.write", service_scope="ai_usage.write")),
                    db: Session = Depends(get_db)):
    """Append-only; idempotent per (reporting service, external_id). Service clients only."""
    if p.kind != "service":
        raise errors.forbidden("AI usage is reported by services, not staff")
    source = p.label.removeprefix("service:")
    cache, accepted = {}, 0
    for r in body.records:
        if r.tenant not in cache:
            cache[r.tenant] = resolve_tenant(db, r.tenant).id
        res = db.execute(insert(AiUsageRecord).values(
            tenant_id=cache[r.tenant], source_service=source, external_id=r.external_id, feature=r.feature, provider=r.provider,
            model=r.model, input_tokens=r.input_tokens, output_tokens=r.output_tokens, cost_micro_inr=r.cost_micro_inr, at=utcnow())
            .on_conflict_do_nothing(constraint="uq_ai_usage_ext").returning(AiUsageRecord.id))
        accepted += 1 if res.first() else 0
    return {"accepted": accepted, "duplicates": len(body.records) - accepted}


@router.get("/ai-usage")
def list_ai_usage(page: Page = Depends(), tenant: str | None = None, _: Principal = Depends(require("ai_usage.read", staff_only=True)),
                  db: Session = Depends(get_db)):
    stmt = select(AiUsageRecord)
    if tenant:
        stmt = stmt.where(AiUsageRecord.tenant_id == resolve_tenant(db, tenant).id)
    return paged(db, stmt, page, AiUsageRecord, AiUsageRecord.id.desc())


@router.get("/ai-usage/summary")
def ai_usage_summary(since: str | None = None, _: Principal = Depends(require("ai_usage.read", staff_only=True)),
                     db: Session = Depends(get_db)):
    stmt = select(AiUsageRecord.tenant_id, AiUsageRecord.feature, func.count(), func.sum(AiUsageRecord.input_tokens),
                  func.sum(AiUsageRecord.output_tokens), func.sum(AiUsageRecord.cost_micro_inr)).group_by(
        AiUsageRecord.tenant_id, AiUsageRecord.feature).order_by(AiUsageRecord.tenant_id, AiUsageRecord.feature)
    if s := _since(since):
        stmt = stmt.where(AiUsageRecord.at >= s)
    return {"items": [{"tenant_id": str(t), "feature": f, "calls": c, "input_tokens": int(i), "output_tokens": int(o),
                       "cost_micro_inr": int(m)} for t, f, c, i, o, m in db.execute(stmt)]}


# ---------- system ----------
class HeartbeatIn(BaseModel):
    job_name: str = Field(min_length=1, max_length=100)
    status: str = Field("ok", pattern="^(ok|error)$")
    duration_ms: int | None = Field(None, ge=0)
    expected_interval_seconds: int = Field(300, gt=0)
    details: dict | None = None


@router.get("/health")
def health(db: Session = Depends(get_db)):
    """Liveness/readiness only; no internals."""
    try:
        db.execute(text("select 1"))
    except Exception:
        raise errors.AppError(503, "unavailable", "database unavailable")
    return {"status": "ok"}


@router.post("/system/heartbeats")
def heartbeat(body: HeartbeatIn, p: Principal = Depends(require("heartbeat.write", service_scope="heartbeat.write")),
              db: Session = Depends(get_db)):
    if p.kind != "service":
        raise errors.forbidden("Heartbeats come from services")
    svc = p.label.removeprefix("service:")
    stmt = insert(JobHeartbeat).values(job_name=body.job_name, service=svc, status=body.status, last_seen_at=utcnow(),
                                       last_duration_ms=body.duration_ms, expected_interval_seconds=body.expected_interval_seconds,
                                       details=body.details)
    db.execute(stmt.on_conflict_do_update(index_elements=["job_name", "service"], set_={
        "status": stmt.excluded.status, "last_seen_at": stmt.excluded.last_seen_at, "last_duration_ms": stmt.excluded.last_duration_ms,
        "expected_interval_seconds": stmt.excluded.expected_interval_seconds, "details": stmt.excluded.details}))
    return {"ok": True}


@router.get("/system/health")
def system_health(_: Principal = Depends(require("system.read", staff_only=True)), db: Session = Depends(get_db)):
    now = utcnow()
    db.execute(text("select 1"))
    jobs = []
    for j in db.scalars(select(JobHeartbeat).order_by(JobHeartbeat.service, JobHeartbeat.job_name)):
        age = (now - j.last_seen_at).total_seconds()
        stale = age > j.expected_interval_seconds * settings.heartbeat_stale_factor
        jobs.append({**to_dict(j), "age_seconds": int(age), "stale": stale,
                     "healthy": j.status == "ok" and not stale})
    failed = db.scalar(select(func.count()).select_from(OnboardingApplication).where(OnboardingApplication.status == "failed"))
    overall = "ok" if all(j["healthy"] for j in jobs) and failed == 0 else "degraded"
    return {"status": overall, "database": "ok", "environment": settings.env, "signing_key_id": get_keyring().active_kid,
            "jobs": jobs, "failed_onboardings": failed, "checked_at": now.isoformat()}


# ---------- global config ----------
KEY_RE = re.compile(r"^[a-z][a-z0-9_.]{1,99}$")
SECRETISH = re.compile(r"secret|password|token|api_key|private")


class ConfigIn(BaseModel):
    value: dict | list | str | int | float | bool | None
    description: str | None = None


@router.get("/config")
def list_config(_: Principal = Depends(require("config.read", service_scope="config.read")), db: Session = Depends(get_db)):
    return {"items": [to_dict(c) for c in db.scalars(select(GlobalConfig).order_by(GlobalConfig.key))]}


@router.put("/config/{key}")
def put_config(key: str, body: ConfigIn, p: Principal = Depends(require("config.write", staff_only=True, step_up=True)), db: Session = Depends(get_db)):
    """Non-secret, platform-wide settings (feature switches, maintenance banner, limits). Secrets do not belong here."""
    if not KEY_RE.match(key) or SECRETISH.search(key):
        raise errors.bad("Invalid key (lowercase dotted name; secret-looking names are refused)", "bad_key")
    row = db.get(GlobalConfig, key)
    before = {"value": row.value} if row else None
    if row is None:
        row = GlobalConfig(key=key)
        db.add(row)
    row.value, row.updated_by = body.value, p.label
    if body.description is not None:
        row.description = body.description
    db.flush()
    audit(db, p, "config.set", "config", key, before=before, after={"value": body.value})
    return to_dict(row)


@router.delete("/config/{key}")
def delete_config(key: str, p: Principal = Depends(require("config.write", staff_only=True, step_up=True)), db: Session = Depends(get_db)):
    row = db.get(GlobalConfig, key)
    if row is None:
        raise errors.not_found("Config key not found")
    audit(db, p, "config.deleted", "config", key, before={"value": row.value})
    db.delete(row)
    return {"ok": True}


Request  # noqa
