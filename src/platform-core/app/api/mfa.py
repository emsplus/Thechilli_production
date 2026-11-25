"""Staff TOTP MFA: enrolment (secret + QR), step-up verification at login, recovery codes, disable/reset, status."""
import math
from datetime import timedelta

import jwt
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.auth import _backoff, commit_session, issue_session
from app.core import errors
from app.core.config import settings
from app.core.db import get_db
from app.core.deps import Principal, client_ip, current_staff, require
from app.core.security import decode_token, verify_password
from app.models import MfaAttempt, MfaRecoveryCode, RefreshToken, StaffMfa, StaffUser, utcnow
from app.services import mfa
from app.services import step_up as step_up_svc
from app.services.audit import audit, security_event

router = APIRouter(tags=["mfa"])


class VerifyIn(BaseModel):
    mfa_token: str
    code: str | None = Field(None, max_length=16)
    recovery_code: str | None = Field(None, max_length=40)


class CodeIn(BaseModel):
    code: str = Field(max_length=16)


class StepUpIn(BaseModel):
    code: str = Field(min_length=6, max_length=40)  # 6-digit TOTP code, or a one-time recovery code (XXXXX-XXXXX-XXXXX)


class ReauthIn(BaseModel):
    password: str
    code: str = Field(max_length=16)


def _wait(db: Session, staff_id) -> int:
    """Progressive delay on failed codes (per staff member: a 6-digit code must not be brute-forceable from many IPs)."""
    now = utcnow()
    since = now - timedelta(minutes=settings.mfa_window_minutes)
    last_ok = db.scalar(select(func.max(MfaAttempt.at)).where(MfaAttempt.staff_id == staff_id, MfaAttempt.success.is_(True)))
    start = max(since, last_ok) if last_ok else since
    n, last = db.execute(select(func.count(), func.max(MfaAttempt.at)).where(
        MfaAttempt.staff_id == staff_id, MfaAttempt.success.is_(False), MfaAttempt.at > start)).one()
    if not n or not last:
        return 0
    d = settings.mfa_window_minutes * 60 if n >= 4 * settings.mfa_max_failures else _backoff(n, settings.mfa_max_failures, 2, 300)
    left = d - (now - last).total_seconds()
    return max(1, math.ceil(left)) if left > 0 else 0


def _guard(db: Session, user: StaffUser, ip: str) -> None:
    wait = _wait(db, user.id)
    if wait:
        security_event(db, "mfa_locked_out", "warn", staff_id=user.id, email=user.email, ip=ip)
        db.commit()
        raise errors.AppError(429, "rate_limited", "Too many failed codes. Try again later.", {"Retry-After": str(wait)})


def _record(db: Session, user: StaffUser, ip: str, ok: bool, what: str) -> None:
    db.add(MfaAttempt(staff_id=user.id, ip=ip, success=ok))
    if not ok:
        security_event(db, "mfa_failed", "warn", staff_id=user.id, email=user.email, ip=ip, details={"method": what})
        db.commit()  # persist the failure before raising, so the limit holds


def _check_totp(db: Session, user: StaffUser, row: StaffMfa, code: str, ip: str) -> bool:
    row = db.scalar(select(StaffMfa).where(StaffMfa.staff_id == user.id).with_for_update())
    step = mfa.verify_totp(mfa.decrypt_secret(row.secret_enc), code, row.last_step)
    ok = step is not None
    _record(db, user, ip, ok, "totp")
    if ok:
        row.last_step = step
    return ok


def _confirmed(db: Session, user: StaffUser) -> StaffMfa | None:
    row = db.get(StaffMfa, user.id)
    return row if row and row.confirmed_at else None


def _fresh_codes(db: Session, user: StaffUser) -> list[str]:
    for c in db.scalars(select(MfaRecoveryCode).where(MfaRecoveryCode.staff_id == user.id)):
        db.delete(c)
    db.flush()
    codes = mfa.new_recovery_codes(settings.mfa_recovery_codes)
    for c in codes:
        db.add(MfaRecoveryCode(staff_id=user.id, code_hash=mfa.hash_recovery(c)))
    return codes


def _principal(user: StaffUser, request: Request) -> Principal:
    return Principal("staff", user.id, user.email, client_ip(request), user.role)


def _token_user(db: Session, token: str, purpose: str) -> StaffUser:
    try:
        claims = decode_token(token, settings.jwt_audience_staff, "staff_mfa")
    except jwt.PyJWTError:
        raise errors.unauthorized("Invalid or expired MFA step-up token")
    if claims.get("purpose") != purpose:
        raise errors.unauthorized("Invalid or expired MFA step-up token")
    user = db.get(StaffUser, claims["sub"])
    if user is None or not user.is_active:
        raise errors.unauthorized()
    return user


def _enrol_actor(request: Request, db: Session = Depends(get_db)) -> tuple[StaffUser, bool]:
    """Enrolment is allowed for a signed-in session, or with the step-up token a mandatory-MFA role gets at login."""
    h = request.headers.get("authorization", "")
    if h.lower().startswith("bearer "):
        try:
            claims = decode_token(h[7:].strip(), settings.jwt_audience_staff, "staff_mfa")
            if claims.get("purpose") == "enrol":
                user = db.get(StaffUser, claims["sub"])
                if user and user.is_active:
                    return user, True
        except jwt.PyJWTError:
            pass
    p = current_staff(request, db)
    return db.get(StaffUser, p.id), False


@router.post("/auth/mfa/verify")
def verify(body: VerifyIn, request: Request, db: Session = Depends(get_db)):
    """Second step of sign-in. Accepts a TOTP code or a one-time recovery code."""
    ip = client_ip(request)
    user = _token_user(db, body.mfa_token, "verify")
    row = _confirmed(db, user)
    if row is None:
        raise errors.unauthorized("Invalid or expired MFA step-up token")
    if bool(body.code) == bool(body.recovery_code):
        raise errors.bad("Provide either code or recovery_code", "bad_request")
    _guard(db, user, ip)
    used_recovery = False
    if body.code:
        ok = _check_totp(db, user, row, body.code, ip)
    else:
        rc = db.scalar(select(MfaRecoveryCode).where(
            MfaRecoveryCode.staff_id == user.id, MfaRecoveryCode.code_hash == mfa.hash_recovery(body.recovery_code),
            MfaRecoveryCode.used_at.is_(None)).with_for_update())
        ok = rc is not None
        _record(db, user, ip, ok, "recovery_code")
        if rc:
            rc.used_at, used_recovery = utcnow(), True
    if not ok:
        raise errors.unauthorized("Invalid code")
    user.last_login_at = utcnow()
    security_event(db, "login_success", staff_id=user.id, email=user.email, ip=ip, details={"mfa": "recovery" if used_recovery else "totp"})
    out = issue_session(db, user, request, mfa=True)
    if used_recovery:
        left = db.scalar(select(func.count()).select_from(MfaRecoveryCode).where(
            MfaRecoveryCode.staff_id == user.id, MfaRecoveryCode.used_at.is_(None)))
        security_event(db, "mfa_recovery_code_used", "warn", staff_id=user.id, email=user.email, ip=ip, details={"remaining": left})
        audit(db, _principal(user, request), "mfa.recovery_code_used", "staff_user", user.id, meta={"remaining": left})
        out["recovery_codes_remaining"] = left
    return commit_session(db, out)


@router.get("/auth/mfa/status")
def status(p: Principal = Depends(current_staff), db: Session = Depends(get_db)):
    row = db.get(StaffMfa, p.id)
    left = db.scalar(select(func.count()).select_from(MfaRecoveryCode).where(MfaRecoveryCode.staff_id == p.id, MfaRecoveryCode.used_at.is_(None)))
    return {"enrolled": bool(row and row.confirmed_at), "enrolled_at": row.confirmed_at.isoformat() if row and row.confirmed_at else None,
            "required": p.role in settings.mfa_roles, "recovery_codes_remaining": left or 0}


@router.post("/auth/mfa/enrol/start")
def enrol_start(request: Request, actor: tuple[StaffUser, bool] = Depends(_enrol_actor), db: Session = Depends(get_db)):
    user, _ = actor
    if _confirmed(db, user):
        raise errors.conflict("MFA is already enrolled; disable it first", "mfa_already_enrolled")
    secret = mfa.new_secret()
    row = db.get(StaffMfa, user.id)
    if row:
        row.secret_enc, row.last_step, row.created_at = mfa.encrypt_secret(secret), None, utcnow()
    else:
        db.add(StaffMfa(staff_id=user.id, secret_enc=mfa.encrypt_secret(secret)))
    uri = mfa.otpauth_uri(secret, user.email)
    audit(db, _principal(user, request), "mfa.enrol_started", "staff_user", user.id)
    return {"secret": secret, "otpauth_uri": uri, "qr_svg": mfa.qr_svg(uri), "issuer": settings.mfa_issuer, "account": user.email}


@router.post("/auth/mfa/enrol/confirm")
def enrol_confirm(body: CodeIn, request: Request, actor: tuple[StaffUser, bool] = Depends(_enrol_actor), db: Session = Depends(get_db)):
    user, via_token = actor
    ip = client_ip(request)
    row = db.scalar(select(StaffMfa).where(StaffMfa.staff_id == user.id).with_for_update())
    if row is None or row.confirmed_at is not None:
        raise errors.conflict("No pending enrolment; start one first", "mfa_no_pending_enrolment")
    _guard(db, user, ip)
    if not _check_totp(db, user, row, body.code, ip):
        raise errors.bad("Invalid code", "invalid_code")
    row.confirmed_at = utcnow()
    codes = _fresh_codes(db, user)
    audit(db, _principal(user, request), "mfa.enrolled", "staff_user", user.id)
    security_event(db, "mfa_enrolled", staff_id=user.id, email=user.email, ip=ip)
    out = {"ok": True, "recovery_codes": codes}  # shown once; only hashes are stored
    if via_token:
        user.last_login_at = utcnow()
        security_event(db, "login_success", staff_id=user.id, email=user.email, ip=ip, details={"mfa": "enrolment"})
        out.update(issue_session(db, user, request, mfa=True))
    return commit_session(db, out)


def _reauth(db: Session, request: Request, p: Principal, body: ReauthIn) -> StaffUser:
    user = db.get(StaffUser, p.id)
    row = _confirmed(db, user)
    if row is None:
        raise errors.conflict("MFA is not enrolled", "mfa_not_enrolled")
    ip = client_ip(request)
    _guard(db, user, ip)
    if not verify_password(body.password, user.password_hash):
        _record(db, user, ip, False, "reauth_password")
        raise errors.bad("Password or code is incorrect", "bad_credentials")
    if not _check_totp(db, user, row, body.code, ip):
        raise errors.bad("Password or code is incorrect", "bad_credentials")
    return user


@router.post("/auth/mfa/recovery-codes")
def regenerate_codes(body: ReauthIn, request: Request, p: Principal = Depends(current_staff), db: Session = Depends(get_db)):
    user = _reauth(db, request, p, body)
    codes = _fresh_codes(db, user)
    audit(db, p, "mfa.recovery_codes_regenerated", "staff_user", user.id)
    return {"recovery_codes": codes}


@router.post("/auth/mfa/disable")
def disable(body: ReauthIn, request: Request, p: Principal = Depends(current_staff), db: Session = Depends(get_db)):
    if p.role in settings.mfa_roles:
        raise errors.forbidden("MFA is mandatory for your role")
    user = _reauth(db, request, p, body)
    _drop(db, user)
    audit(db, p, "mfa.disabled", "staff_user", user.id)
    security_event(db, "mfa_disabled", "warn", staff_id=user.id, email=user.email, ip=p.ip)
    return {"ok": True}


def _drop(db: Session, user: StaffUser) -> None:
    for c in db.scalars(select(MfaRecoveryCode).where(MfaRecoveryCode.staff_id == user.id)):
        db.delete(c)
    row = db.get(StaffMfa, user.id)
    if row:
        db.delete(row)


@router.post("/staff/{staff_id}/mfa/reset")
def reset(staff_id: str, request: Request, p: Principal = Depends(require("staff.manage", staff_only=True, step_up=True)), db: Session = Depends(get_db)):
    """Lost device and lost recovery codes: a super_admin clears the factor and ends the person's sessions. A mandatory
    role must enrol again at the next sign-in."""
    from app.api.common import get_or_404, parse_uuid
    user = get_or_404(db, StaffUser, parse_uuid(staff_id), "Staff user")
    if user.id == p.id:
        raise errors.bad("Use /auth/mfa/disable for your own account", "use_disable")
    _drop(db, user)
    for t in db.scalars(select(RefreshToken).where(RefreshToken.staff_id == user.id, RefreshToken.revoked_at.is_(None))):
        t.revoked_at = utcnow()
    audit(db, p, "mfa.reset", "staff_user", user.id)
    security_event(db, "mfa_reset", "warn", staff_id=user.id, email=user.email, ip=p.ip, details={"by": p.label})
    return {"ok": True}


@router.post("/auth/step-up")
def step_up(body: StepUpIn, request: Request, p: Principal = Depends(current_staff), db: Session = Depends(get_db)):
    """Fresh second factor for a sensitive action (docs/STEP_UP.md). Returns a short-lived grant bound to this staff member
    and this session; send it as header X-Step-Up-Token on the protected request. Same per-staff throttle as sign-in codes."""
    user = db.get(StaffUser, p.id)
    row = _confirmed(db, user)
    if row is None:
        raise errors.conflict("Two-step is not set up for your account", "mfa_not_enrolled")
    if not p.session_id:
        raise errors.unauthorized("Session required")
    ip = client_ip(request)
    _guard(db, user, ip)
    code = body.code.strip().replace(" ", "")
    if code.isdigit():
        method, ok = "totp", _check_totp(db, user, row, code, ip)
    else:
        rc = db.scalar(select(MfaRecoveryCode).where(
            MfaRecoveryCode.staff_id == user.id, MfaRecoveryCode.code_hash == mfa.hash_recovery(code),
            MfaRecoveryCode.used_at.is_(None)).with_for_update())
        method, ok = "recovery_code", rc is not None
        _record(db, user, ip, ok, "step_up_recovery_code")
        if rc:
            rc.used_at = utcnow()
    if not ok:
        audit(db, p, "step_up.denied", "staff_user", p.id, meta={"reason": "bad_code", "path": request.url.path, "method": method})
        db.commit()
        raise errors.bad("Invalid code", "invalid_code")  # 400, not 401: the session itself is fine
    raw, g = step_up_svc.issue(db, p, method)
    out = {"step_up_token": raw, "header": step_up_svc.HEADER, "expires_in": settings.step_up_minutes * 60,
           "expires_at": g.expires_at.isoformat(), "uses": g.uses_left, "method": method}
    if method == "recovery_code":
        left = db.scalar(select(func.count()).select_from(MfaRecoveryCode).where(
            MfaRecoveryCode.staff_id == user.id, MfaRecoveryCode.used_at.is_(None)))
        security_event(db, "mfa_recovery_code_used", "warn", staff_id=user.id, email=user.email, ip=ip, details={"remaining": left})
        audit(db, p, "mfa.recovery_code_used", "staff_user", user.id, meta={"remaining": left, "for": "step_up"})
        out["recovery_codes_remaining"] = left
    db.commit()  # the grant exists before the client can use it
    return out
