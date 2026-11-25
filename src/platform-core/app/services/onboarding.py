"""Onboarding application state machine (single workflow for self-signup, marketing-service and staff-created intake).

received -> under_review -> approved -> provisioning -> provisioned
   |             |                         |  ^
   +-> rejected <+                         v  |
                                         failed (retry -> provisioning)
Only `provision` creates tenant records; every transition writes an onboarding_event and an audit row.

Provisioning workflow (`provision_state`, finer than `status`, docs/PROVISIONING.md):
  queued (approved, waiting) -> provisioning (call-out to pos-service in flight) -> owner_invited (tenant live in POS, set-password
  email sent; `status` = provisioned, tenant active) -> live (owner set a password; seen via pos-service status)
  any failure -> failed, with provision_next_at = now + backoff while attempts < provision_max_attempts and the error is retryable;
  otherwise only staff retry it. Every call-out is idempotent (Idempotency-Key = application id), so a retry after a lost response
  or a failed invite email is safe. State changes write audit rows, failures and manual retries also write security events."""
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core import errors
from app.core.config import settings
from app.models import (BusinessProfile, OnboardingApplication, OnboardingEvent, Outlet, Plan, Tenant, utcnow)
from app.services import entitlements as ent
from app.services import subscriptions, wallet
from app.services import mailer as mail
from app.services.audit import audit, security_event
from app.services.provisioner import ProvisionRequest, ProvisioningError, get_provisioner
from app.services.tenants import unique_slug

log = logging.getLogger("app.onboarding")

TRANSITIONS = {
    "received": {"under_review", "approved", "rejected"},
    "under_review": {"approved", "rejected"},
    "approved": {"provisioning", "rejected"},
    "provisioning": {"provisioned", "failed"},
    "failed": {"provisioning", "rejected"},
    "provisioned": set(),
    "rejected": set(),
}


class _System:
    """Principal of automatic steps (auto-approval, provision-on-approve of an anonymous self-signup)."""
    label = "system:onboarding"
    kind = "system"
    ip = None


SYSTEM = _System()


def auto_approves(source: str) -> bool:
    """ONBOARDING_AUTO_APPROVE (every source) or the source listed in ONBOARDING_AUTO_APPROVE_SOURCES."""
    listed = {x.strip() for x in settings.onboarding_auto_approve_sources.split(",") if x.strip()}
    return settings.onboarding_auto_approve or source in listed


def move(db: Session, app: OnboardingApplication, to: str, principal, note: str | None = None) -> None:
    if to not in TRANSITIONS[app.status]:
        raise errors.conflict(f"Cannot move application from {app.status} to {to}", "bad_transition")
    db.add(OnboardingEvent(application_id=app.id, from_status=app.status, to_status=to,
                           actor=getattr(principal, "label", "system"), note=note))
    audit(db, principal, f"onboarding.{to}", "onboarding_application", app.id, app.tenant_id,
          before={"status": app.status}, after={"status": to}, meta={"note": note} if note else None)
    app.status = to
    if to == "approved":
        app.provision_state, app.provision_next_at = "queued", None


def backoff_seconds(attempts: int) -> int:
    return min(settings.provision_backoff_base_seconds * 2 ** max(attempts - 1, 0), settings.provision_backoff_max_seconds)


def _set_state(db: Session, app: OnboardingApplication, state: str, principal, **meta) -> None:
    before, app.provision_state = app.provision_state, state
    audit(db, principal, f"provisioning.{state}", "onboarding_application", app.id, app.tenant_id,
          before={"provision_state": before}, after={"provision_state": state}, meta=meta or None)


def _ensure_tenant(db: Session, app: OnboardingApplication) -> Tenant:
    data = app.payload or {}
    if app.tenant_id is None:
        t = Tenant(slug=unique_slug(db, app.business_name), display_name=app.business_name, status="pending",
                   business_types=list(app.business_types))  # the tenant inherits the application's business types
        db.add(t)
        db.flush()
        db.add(BusinessProfile(
            tenant_id=t.id, legal_name=data.get("legal_name") or app.business_name, gstin=data.get("gstin"),
            state_code=data.get("state_code"), city=data.get("city"), contact_name=app.contact_name,
            contact_email=app.email, contact_phone=app.phone))
        for o in data.get("outlets") or [{"name": app.business_name, "city": data.get("city"), "state_code": data.get("state_code")}]:
            db.add(Outlet(tenant_id=t.id, name=o["name"], city=o.get("city"), state_code=o.get("state_code")))
        app.tenant_id = t.id
        db.flush()
        plan = db.scalar(select(Plan).where(Plan.code == (app.plan_code or settings.default_trial_plan_code), Plan.is_active.is_(True)))
        if plan:
            # PAYG plans: the trial length is the billing setting (docs/PAYG_BILLING.md); subscription plans keep DEFAULT_TRIAL_DAYS
            eff = wallet.effective(db, t.id, plan.id)
            days = eff.trial_days if eff.metered else settings.default_trial_days
            subscriptions.assign_plan(db, t, plan, "system:onboarding", f"application {app.id}", trial_days=days or None)
        wallet.ensure_wallet(db, t)  # the free trial starts at tenant creation
    return db.get(Tenant, app.tenant_id)


def _request_for(db: Session, app: OnboardingApplication, tenant: Tenant) -> ProvisionRequest:
    """Deterministic for one application (pos-service rejects a reused Idempotency-Key with a different body), so business_types
    comes from the application, not from the tenant (a later staff change of the tenant's type is not re-sent here)."""
    outlets = [{"name": o.name, "city": o.city, "state_code": o.state_code} for o in
               db.scalars(select(Outlet).where(Outlet.tenant_id == tenant.id).order_by(Outlet.created_at, Outlet.id))]
    prof = db.get(BusinessProfile, tenant.id)
    return ProvisionRequest(
        idempotency_key=str(app.id), tenant_id=str(tenant.id), tenant_slug=tenant.slug, business_name=app.business_name,
        owner_name=app.contact_name, owner_email=app.email, plan_code=app.plan_code, outlets=outlets,
        country=settings.pos_default_country, timezone=settings.pos_default_timezone, currency=settings.pos_default_currency,
        gstin=prof.gstin if prof else None, business_types=list(app.business_types),
        entitlement_hints={"requested_outlets": len(outlets), "source": app.source})


_DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def format_invite_expiry(iso: str | None, now: datetime | None = None) -> str | None:
    """A readable expiry for an email: 'Mon 3 Nov 2026, 6:30 pm IST (in 48 hours)'. India only: always IST. The relative part is
    left out once the time has passed. None when there is no (valid) timestamp: the caller says 'soon'. The raw ISO string of the
    provider ('2026-11-04T14:07:31.454691+00:00') must never reach an owner (smoke finding 2026-11-01)."""
    if not iso:
        return None
    try:
        exp = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    local = exp.astimezone(ZoneInfo("Asia/Kolkata"))
    hour = local.hour % 12 or 12
    text = f"{_DAYS[local.weekday()]} {local.day} {_MONTHS[local.month - 1]} {local.year}, {hour}:{local.minute:02d} {'am' if local.hour < 12 else 'pm'} IST"
    secs = (exp - (now or utcnow())).total_seconds()
    if secs <= 0:
        return text
    hours = round(secs / 3600)
    rel = "in less than an hour" if secs < 3600 else f"in {hours} hours" if hours <= 72 else f"in {round(hours / 24)} days"
    return f"{text} ({rel})"


def send_owner_invite(app: OnboardingApplication, res, tenant: Tenant) -> None:
    """Emails the set-password link. The token exists only in this call (never stored, logged or audited)."""
    from urllib.parse import quote
    url = settings.owner_invite_url_template.format(token=quote(res.invite_token, safe=""), tenant_id=tenant.id)
    from app.services import email_brand as B
    name = app.contact_name
    when = format_invite_expiry(res.invite_expires_at)
    expiry = f"The link works once and expires{' on ' + when if when else ' soon'}."
    text = (f"Hello {name},\n\nYour {app.business_name} restaurant is ready on TheChilli.ai. Set your password to sign in:"
            f"\n\n{url}\n\n{expiry} If you did not expect this email, ignore it.\n\n{B.TEXT_FOOTER}\n")
    title = "Your restaurant is ready"
    body = (B.p(f"Hello {name},") + B.p(f"Your {app.business_name} restaurant is ready on TheChilli.ai. "
                                        "Set your password to sign in:")
            + B.button(url, "Set your password") + B.p(expiry, muted=True)
            + B.p("If you did not expect this email, ignore it.", muted=True))
    mail.get_mailer().send(app.email, f"Set your password for {app.business_name}", text,
                           B.layout(title, body, preheader=f"{app.business_name} is ready on TheChilli.ai"))


def _fail(db: Session, app: OnboardingApplication, principal, err: ProvisioningError, *, manual: bool) -> None:
    app.last_error = str(err)[:500]
    app.provision_error_code = err.code[:48]
    schedule = err.retryable and app.attempts < settings.provision_max_attempts
    app.provision_next_at = utcnow() + timedelta(seconds=backoff_seconds(app.attempts)) if schedule else None
    move(db, app, "failed", principal, app.last_error)
    _set_state(db, app, "failed", principal, attempt=app.attempts, code=err.code, retryable=err.retryable,
               next_attempt_at=app.provision_next_at.isoformat() if app.provision_next_at else None)
    security_event(db, "provisioning_failed", "warn", email=None, ip=getattr(principal, "ip", None),
                   details={"application_id": app.id, "tenant_id": app.tenant_id, "attempt": app.attempts, "code": err.code,
                            "retryable": err.retryable, "automatic_retry": schedule, "manual": manual})


def provision(db: Session, app: OnboardingApplication, principal, manual: bool = False) -> OnboardingApplication:
    """One provisioning attempt: tenant records here, tenant + owner + outlet in pos-service, invite email, tenant active.
    From approved / failed (and, for a stale sweep reclaim, provisioning). Never raises for a call-out failure: the application
    goes to `failed` with a retry schedule. Commits are the caller's."""
    if app.status != "provisioning":  # a stale `provisioning` row reclaimed by the sweep keeps its status
        move(db, app, "provisioning", principal)
    _set_state(db, app, "provisioning", principal, attempt=app.attempts + 1)
    app.attempts += 1
    app.last_error, app.provision_error_code, app.provision_next_at = None, None, None
    tenant = _ensure_tenant(db, app)
    db.commit()  # the in-flight attempt is visible (and a crash leaves a `provisioning` row the sweep reclaims)
    try:
        res = get_provisioner().provision(_request_for(db, app, tenant))
        invited = False
        if res.invite_token:  # still pending: (re)send the link. Accepted already (replay): nothing to send.
            try:
                send_owner_invite(app, res, tenant)
            except mail.MailError as e:
                raise ProvisioningError(f"owner invite email failed: {e}", "invite_email_failed", True) from None
            invited = True
    except ProvisioningError as e:
        _fail(db, app, principal, e, manual=manual)
        return app
    except Exception as e:  # noqa: BLE001 - an unexpected bug must not strand the application in `provisioning`
        log.exception("provisioning crashed for application %s", app.id)
        _fail(db, app, principal, ProvisioningError(f"unexpected error: {type(e).__name__}", "internal_error", True), manual=manual)
        return app

    def activate():
        tenant.pos_tenant_ref, tenant.status, tenant.status_changed_at = res.pos_tenant_ref, "active", utcnow()
        for o, ref in zip(db.scalars(select(Outlet).where(Outlet.tenant_id == tenant.id).order_by(Outlet.created_at, Outlet.id)).all(), res.outlet_refs):
            o.pos_outlet_ref = ref
    ent.tracked_change(db, tenant, "tenant_active", getattr(principal, "label", "system"), "provisioned", activate)
    move(db, app, "provisioned", principal)
    now = utcnow()
    if invited:
        app.invite_sends += 1
        app.owner_invited_at = now
        _set_state(db, app, "owner_invited", principal, replayed=res.replayed)
        security_event(db, "owner_invite_sent", "info", ip=getattr(principal, "ip", None),
                       details={"application_id": app.id, "tenant_id": tenant.id, "sends": app.invite_sends})
    else:
        app.live_at = now
        _set_state(db, app, "live", principal, reason="owner already accepted")
    return app


def retry_manual(db: Session, app: OnboardingApplication, principal) -> OnboardingApplication:
    """Staff retry of a failed application right now, whatever the backoff or attempt budget says."""
    if app.status != "failed":
        raise errors.conflict(f"Only failed applications can be retried (status is {app.status})", "bad_transition")
    security_event(db, "provisioning_manual_retry", "info", staff_id=getattr(principal, "id", None), ip=getattr(principal, "ip", None),
                   details={"application_id": app.id, "attempts": app.attempts, "last_code": app.provision_error_code})
    return provision(db, app, principal, manual=True)


def resend_invite(db: Session, app: OnboardingApplication, principal) -> OnboardingApplication:
    """Staff: send a fresh set-password link (the old unused one is voided by pos-service). Only while owner_invited."""
    if app.provision_state != "owner_invited":
        raise errors.conflict(f"Invite can be resent only in state owner_invited (state is {app.provision_state})", "bad_state")
    tenant = db.get(Tenant, app.tenant_id)
    try:
        res = get_provisioner().provision(_request_for(db, app, tenant))
        if res.invite_token:
            send_owner_invite(app, res, tenant)
    except (ProvisioningError, mail.MailError) as e:
        code = e.code if isinstance(e, ProvisioningError) else "invite_email_failed"
        security_event(db, "owner_invite_failed", "warn", ip=getattr(principal, "ip", None),
                       details={"application_id": app.id, "code": code})
        db.commit()  # the request fails (rollback by get_db), the security event must stay
        raise errors.AppError(502, "invite_failed", f"Could not resend the invite ({code})")
    if res.invite_token:
        app.invite_sends += 1
        app.owner_invited_at = utcnow()
        audit(db, principal, "provisioning.invite_resent", "onboarding_application", app.id, app.tenant_id, meta={"sends": app.invite_sends})
        security_event(db, "owner_invite_sent", "info", ip=getattr(principal, "ip", None),
                       details={"application_id": app.id, "tenant_id": app.tenant_id, "sends": app.invite_sends, "resend": True})
    else:
        mark_live(db, app, principal)
    return app


def mark_live(db: Session, app: OnboardingApplication, principal) -> None:
    app.live_at = utcnow()
    _set_state(db, app, "live", principal, reason="owner set a password")


def refresh_live(db: Session, app: OnboardingApplication, principal) -> OnboardingApplication:
    """owner_invited -> live when pos-service says the owner accepted the invite. A call-out failure changes nothing."""
    if app.provision_state != "owner_invited" or app.tenant_id is None:
        return app
    try:
        st = get_provisioner().status(str(app.tenant_id))
    except ProvisioningError:
        return app
    if st is not None and st.owner_invite_status == "accepted":
        mark_live(db, app, principal)
    return app


class _System:
    kind, id, label, ip = "system", None, "system:provisioning-sweep", None


def run_due(db: Session, limit: int = 20) -> dict:
    """The sweep (also POST /onboarding/provisioning/run-due): attempts queued applications, failed ones whose backoff elapsed and
    that still have attempts left, reclaims applications stuck in `provisioning`, and promotes owner_invited -> live. Rows are
    claimed with FOR UPDATE SKIP LOCKED so concurrent sweeps never process the same application. Commits per application."""
    now = utcnow()
    stale = now - timedelta(minutes=settings.provision_stale_minutes)
    due = (select(OnboardingApplication).where(or_(
        OnboardingApplication.provision_state == "queued",
        (OnboardingApplication.provision_state == "failed") & OnboardingApplication.provision_next_at.is_not(None)
        & (OnboardingApplication.provision_next_at <= now) & (OnboardingApplication.attempts < settings.provision_max_attempts),
        (OnboardingApplication.provision_state == "provisioning") & (OnboardingApplication.updated_at < stale)))
        .order_by(OnboardingApplication.updated_at).limit(limit).with_for_update(skip_locked=True))
    attempted = [a.id for a in db.scalars(due).all()]
    db.rollback()  # release the claim locks; each application is re-locked below, one transaction each
    out = {"attempted": 0, "provisioned": 0, "failed": 0, "became_live": 0}
    sys_p = _System()
    for aid in attempted:
        a = db.scalar(select(OnboardingApplication).where(OnboardingApplication.id == aid).with_for_update(skip_locked=True))
        if a is None or a.provision_state not in ("queued", "failed", "provisioning") or a.status not in ("approved", "failed", "provisioning"):
            db.rollback()
            continue
        provision(db, a, sys_p)
        out["attempted"] += 1
        out["provisioned" if a.status == "provisioned" else "failed"] += 1
        db.commit()
    for a in db.scalars(select(OnboardingApplication).where(OnboardingApplication.provision_state == "owner_invited").limit(limit)).all():
        refresh_live(db, a, sys_p)
        if a.provision_state == "live":
            out["became_live"] += 1
        db.commit()
    return out
