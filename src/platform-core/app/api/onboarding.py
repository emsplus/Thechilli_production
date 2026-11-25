import hmac
from datetime import timedelta

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.common import Page, get_or_404, paged, parse_uuid, to_dict
from app.api.tenants import GSTIN_RE, BusinessType, BusinessTypes, default_business_types
from app.core import errors
from app.core.config import settings
from app.core.db import get_db
from app.core.security import new_opaque_token, sha256
from app.core.deps import Principal, authenticate, client_ip, require
from app.models import OnboardingApplication, OnboardingEvent, utcnow
from app.services import onboarding as wf
from app.services.audit import audit

router = APIRouter(tags=["onboarding"])


class OutletIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    city: str | None = Field(None, max_length=100)
    state_code: str | None = Field(None, pattern=r"^\d{2}$")


class ApplicationIn(BaseModel):
    business_name: str = Field(min_length=2, max_length=200)
    contact_name: str = Field(min_length=2, max_length=200)
    email: EmailStr
    phone: str | None = Field(None, max_length=20)
    plan_code: str | None = None
    business_types: BusinessTypes = Field(default_factory=default_business_types)  # [] or unknown value -> 422
    legal_name: str | None = Field(None, max_length=200)
    gstin: str | None = Field(None, max_length=15)
    state_code: str | None = Field(None, pattern=r"^\d{2}$")
    city: str | None = Field(None, max_length=100)
    outlets: list[OutletIn] = Field(default_factory=list, max_length=50)
    marketing_ref: str | None = Field(None, max_length=100)  # lead/campaign id from marketing-service
    idempotency_key: str | None = Field(None, max_length=100)

    @field_validator("gstin")
    @classmethod
    def _g(cls, v):
        if v and not GSTIN_RE.match(v.upper()):
            raise ValueError("invalid GSTIN format")
        return v.upper() if v else v


class Note(BaseModel):
    note: str | None = None


class Reject(BaseModel):
    reason: str = Field(min_length=3)


@router.post("/onboarding/applications", status_code=201)
def submit(body: ApplicationIn, request: Request, db: Session = Depends(get_db),
           idem: str | None = Header(None, alias="Idempotency-Key"),
           receipt: str | None = Header(None, alias="X-Idempotency-Receipt")):
    """Single intake for self-signup (anonymous, per-IP rate limited) and marketing-service (X-Service-Key with the
    `onboarding.submit` scope) and staff (Bearer with onboarding.manage). Same state machine for all."""
    p = authenticate(request, db)
    ip = client_ip(request)
    if p is None:
        source, who = "self_signup", None
        n = db.scalar(select(func.count()).select_from(OnboardingApplication).where(
            OnboardingApplication.submitter_ip == ip, OnboardingApplication.source == "self_signup",
            OnboardingApplication.created_at > utcnow() - timedelta(hours=1)))
        if n >= settings.public_intake_per_ip_per_hour:
            raise errors.AppError(429, "rate_limited", "Too many applications from this address. Try again later.", {"Retry-After": "3600"})
    elif p.kind == "service" and "onboarding.submit" in p.scopes:
        source, who = "marketing", p
    elif p.kind == "staff" and "onboarding.manage" in p.permissions:
        source, who = "staff", p
    else:
        raise errors.forbidden()
    key = body.idempotency_key or idem
    if key:
        scoped = f"{source}:{key}"
        existing = db.scalar(select(OnboardingApplication).where(OnboardingApplication.idempotency_key == scoped))
        if existing:
            if source != "self_signup":  # authenticated callers (service/staff) get the full record back
                return {**to_dict(existing, {"payload", "submitter_ip"}), "duplicate": True}
            # Anonymous replay: the key alone is not proof of ownership. Full record only with the creation receipt.
            want = (existing.payload or {}).get("_receipt_sha256")
            if receipt and want and hmac.compare_digest(sha256(receipt), want):
                return {**to_dict(existing, _ANON_HIDE), "duplicate": True}
            return {"accepted": True, "duplicate": True}
        key = scoped
    data = body.model_dump(exclude={"business_name", "contact_name", "email", "phone", "plan_code", "business_types", "marketing_ref",
                                     "idempotency_key"})
    new_receipt = None
    if source == "self_signup" and key:
        new_receipt, receipt_hash = new_opaque_token()
        data["_receipt_sha256"] = receipt_hash
    app = OnboardingApplication(source=source, idempotency_key=key, business_name=body.business_name,
                                contact_name=body.contact_name, email=body.email.lower(), phone=body.phone,
                                plan_code=body.plan_code, business_types=body.business_types, payload=data, marketing_ref=body.marketing_ref, submitter_ip=ip)
    db.add(app)
    db.flush()
    db.add(OnboardingEvent(application_id=app.id, from_status=None, to_status="received", actor=who.label if who else f"anon:{ip}", note=source))
    audit(db, who, "onboarding.received", "onboarding_application", app.id, after={"source": source, "business_name": app.business_name,
                                                                                       "business_types": app.business_types},
          meta={"ip": ip})
    if wf.auto_approves(source):
        wf.move(db, app, "approved", who, "auto-approved by configuration")
        if settings.onboarding_provision_on_approve:
            db.commit()  # the application exists even if provisioning crashes the request
            wf.provision(db, app, who or wf.SYSTEM)
    out = {**to_dict(app, _ANON_HIDE if source == "self_signup" else {"payload", "submitter_ip"}), "duplicate": False}
    if new_receipt:
        out["idempotency_receipt"] = new_receipt  # shown once; send as X-Idempotency-Receipt to replay with full response
    return out


# What an anonymous self-signup answer never carries: the internal payload, the submitter IP, the tenant id (the restaurant id
# in pos-service) and provisioning error details. The owner learns everything else from the set-password email.
_ANON_HIDE = frozenset({"payload", "submitter_ip", "tenant_id", "last_error", "provision_error_code"})


@router.get("/onboarding/applications")
def list_apps(page: Page = Depends(), status: str | None = None, source: str | None = None,
              business_types: list[BusinessType] | None = Query(None),
              _: Principal = Depends(require("onboarding.read", staff_only=True)), db: Session = Depends(get_db)):
    stmt = select(OnboardingApplication)
    if status:
        stmt = stmt.where(OnboardingApplication.status == status)
    if source:
        stmt = stmt.where(OnboardingApplication.source == source)
    if business_types:  # applications whose selection includes all of the given types
        stmt = stmt.where(OnboardingApplication.business_types.contains(business_types))
    return paged(db, stmt, page, OnboardingApplication, OnboardingApplication.created_at.desc(), {"submitter_ip"})


@router.get("/onboarding/applications/{app_id}")
def get_app(app_id: str, p: Principal = Depends(require("onboarding.read", service_scope="onboarding.read")),
            db: Session = Depends(get_db)):
    """Staff (onboarding.read) or a service with scope `onboarding.read`. Services only see marketing-sourced
    applications (their own intake channel); anything else is a 404 and the submitter IP is never exposed to them."""
    a = get_or_404(db, OnboardingApplication, parse_uuid(app_id), "Application")
    if p.kind == "service" and a.source != "marketing":
        raise errors.not_found("Application not found")
    ev = db.scalars(select(OnboardingEvent).where(OnboardingEvent.application_id == a.id).order_by(OnboardingEvent.id)).all()
    out = to_dict(a, {"submitter_ip"} if p.kind == "service" else frozenset())
    out["payload"] = {k: v for k, v in (out.get("payload") or {}).items() if not k.startswith("_")}
    return {**out, "events": [to_dict(e) for e in ev]}


def _app(db, app_id) -> OnboardingApplication:
    return get_or_404(db, OnboardingApplication, parse_uuid(app_id), "Application")


@router.post("/onboarding/applications/{app_id}/review")
def review(app_id: str, body: Note, p: Principal = Depends(require("onboarding.manage", staff_only=True)), db: Session = Depends(get_db)):
    a = _app(db, app_id)
    wf.move(db, a, "under_review", p, body.note)
    return to_dict(a)


@router.post("/onboarding/applications/{app_id}/approve")
def approve(app_id: str, body: Note, p: Principal = Depends(require("onboarding.manage", staff_only=True)), db: Session = Depends(get_db)):
    a = _locked(db, app_id)
    wf.move(db, a, "approved", p, body.note)
    if settings.onboarding_provision_on_approve:
        db.commit()
        wf.provision(db, a, p)
    return to_dict(a, _HIDE)


@router.post("/onboarding/applications/{app_id}/reject")
def reject(app_id: str, body: Reject, p: Principal = Depends(require("onboarding.manage", staff_only=True)), db: Session = Depends(get_db)):
    a = _app(db, app_id)
    wf.move(db, a, "rejected", p, body.reason)
    a.reject_reason = body.reason
    return to_dict(a)


@router.post("/onboarding/applications/{app_id}/provision")
def provision(app_id: str, p: Principal = Depends(require("onboarding.manage", staff_only=True)), db: Session = Depends(get_db)):
    """Runs provisioning now (from `approved`) or, from `failed`, a manual retry. See docs/PROVISIONING.md."""
    a = _locked(db, app_id)
    return to_dict(wf.retry_manual(db, a, p) if a.status == "failed" else wf.provision(db, a, p), _HIDE)


_HIDE = {"submitter_ip"}


def _locked(db, app_id) -> OnboardingApplication:
    a = db.scalar(select(OnboardingApplication).where(OnboardingApplication.id == parse_uuid(app_id)).with_for_update())
    if a is None:
        raise errors.not_found("Application not found")
    return a


@router.post("/onboarding/applications/{app_id}/provisioning/retry")
def provisioning_retry(app_id: str, p: Principal = Depends(require("onboarding.manage", staff_only=True)), db: Session = Depends(get_db)):
    """Staff: retry a failed provisioning immediately (ignores the backoff and the attempt budget)."""
    return to_dict(wf.retry_manual(db, _locked(db, app_id), p), _HIDE)


@router.post("/onboarding/applications/{app_id}/provisioning/resend-invite")
def provisioning_resend_invite(app_id: str, p: Principal = Depends(require("onboarding.manage", staff_only=True)), db: Session = Depends(get_db)):
    """Staff: email the owner a fresh set-password link (state owner_invited only)."""
    return to_dict(wf.resend_invite(db, _locked(db, app_id), p), _HIDE)


@router.post("/onboarding/applications/{app_id}/provisioning/refresh")
def provisioning_refresh(app_id: str, p: Principal = Depends(require("onboarding.manage", staff_only=True)), db: Session = Depends(get_db)):
    """Staff: ask pos-service whether the owner has set a password yet (owner_invited -> live)."""
    return to_dict(wf.refresh_live(db, _locked(db, app_id), p), _HIDE)


@router.post("/onboarding/provisioning/run-due")
def provisioning_run_due(p: Principal = Depends(require("onboarding.manage", service_scope="onboarding.provision")), db: Session = Depends(get_db)):
    """Staff or a scheduler holding the service scope `onboarding.provision`: one sweep (queued, due retries, stale, invite -> live)."""
    return wf.run_due(db)


@router.get("/onboarding/applications/{app_id}/provisioning")
def provisioning_status(app_id: str, p: Principal = Depends(require("onboarding.read", service_scope="onboarding.read")),
                        db: Session = Depends(get_db)):
    """Poll target for marketing-service (scope onboarding.read; only marketing-sourced applications) and staff. A small,
    stable view: no payload, no submitter IP, no error text from the callee (only a short code)."""
    a = get_or_404(db, OnboardingApplication, parse_uuid(app_id), "Application")
    if p.kind == "service" and a.source != "marketing":
        raise errors.not_found("Application not found")
    return {
        "application_id": str(a.id), "application_status": a.status, "provision_state": a.provision_state,
        "business_types": a.business_types,
        "tenant_id": str(a.tenant_id) if a.tenant_id else None, "attempts": a.attempts,
        "max_attempts": settings.provision_max_attempts, "error_code": a.provision_error_code,
        "next_attempt_at": a.provision_next_at.isoformat() if a.provision_next_at else None,
        "needs_manual_action": a.provision_state == "failed" and a.provision_next_at is None,
        "owner_invited_at": a.owner_invited_at.isoformat() if a.owner_invited_at else None,
        "live_at": a.live_at.isoformat() if a.live_at else None,
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
    }
