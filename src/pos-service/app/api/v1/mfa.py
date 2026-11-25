"""Optional TOTP for owners and managers (security review finding 7). Contract: docs/AUTH_CONTRACT.md."""
import uuid

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.deps import bearer
from app.core.db import get_db
from app.core.security import decode_token, verify_password
from app.core.tenancy import bind_tenant
from app.models.core import User
from app.schemas.common import TokenOut
from app.services import accounts, audit, mfa, tokens

router = APIRouter(prefix="/auth/mfa", tags=["auth"])


class EnrolIn(BaseModel):
    mfa_token: str | None = Field(default=None, max_length=2000)  # only for the enrolment forced at sign-in


class ConfirmIn(EnrolIn):
    code: str = Field(min_length=6, max_length=10)


class VerifyIn(BaseModel):
    mfa_token: str = Field(min_length=10, max_length=2000)
    code: str | None = Field(default=None, max_length=10)
    recovery_code: str | None = Field(default=None, max_length=40)


class DisableIn(BaseModel):
    password: str = Field(min_length=1, max_length=256)
    code: str | None = Field(default=None, max_length=10)
    recovery_code: str | None = Field(default=None, max_length=40)


class _Actor:
    def __init__(self, user: User, via_mfa_token: bool):
        self.user, self.via_mfa_token = user, via_mfa_token
        self.restaurant_id, self.user_id = user.restaurant_id, user.id  # for audit.record


def _load(db: Session, rid: str, sub: str) -> User:
    try:
        bind_tenant(db, rid)
        u = db.get(User, uuid.UUID(sub))
    except (ValueError, TypeError):
        u = None
    if u is None or not u.is_active or str(u.restaurant_id) != rid:
        raise HTTPException(401, "Invalid user")
    return u


def _actor(db: Session, creds: HTTPAuthorizationCredentials | None, token: str | None, purpose: str = "enrol") -> _Actor:
    if token:
        c = mfa.decode_mfa_token(token, purpose)
        return _Actor(_load(db, c["rid"], c["sub"]), True)
    if creds is None:
        raise HTTPException(401, "Not authenticated")
    try:
        c = decode_token(creds.credentials)
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid token")
    return _Actor(_load(db, c["rid"], c["sub"]), False)


def _guard(db: Session, user: User, request: Request) -> tuple[str, str]:
    key, ip = accounts.throttle_key(user.email), accounts.client_ip(request)
    wait = accounts.retry_after(db, key, ip)
    if wait:
        raise HTTPException(429, "Too many failed attempts. Try again later.", headers={"Retry-After": str(wait)})
    return key, ip


@router.get("/status")
def status(creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)):
    a = _actor(db, creds, None)
    return {"enabled": mfa.confirmed_row(db, a.user) is not None, "eligible": mfa.eligible(a.user),
            "required": mfa.required(a.user)}


@router.post("/enrol/start")
def enrol_start(data: EnrolIn | None = None, creds: HTTPAuthorizationCredentials | None = Depends(bearer),
                db: Session = Depends(get_db)):
    """Owner / manager. Returns the secret and an otpauth:// URI (render it as a QR code in the client)."""
    a = _actor(db, creds, data.mfa_token if data else None)
    return mfa.start_enrolment(db, a.user)


@router.post("/enrol/confirm")
def enrol_confirm(data: ConfirmIn, request: Request, creds: HTTPAuthorizationCredentials | None = Depends(bearer),
                  db: Session = Depends(get_db)):
    """Proves the authenticator works. Returns ten single-use recovery codes, shown ONCE. When the enrolment was forced at
    sign-in (mfa_token), the response also carries the session tokens."""
    a = _actor(db, creds, data.mfa_token)
    key, ip = _guard(db, a.user, request)
    try:
        codes = mfa.confirm_enrolment(db, a.user, data.code)
    except HTTPException as e:
        if e.status_code == 400:
            db.rollback()
            accounts.record_failure(db, key, ip)
        raise
    audit.record(db, a, "auth.mfa_enabled", "user", a.user.id)
    out = {"recovery_codes": codes}
    if a.via_mfa_token:
        _, pair = tokens.issue_pair(db, a.user, request.headers.get("user-agent"))
        out["tokens"] = pair.model_dump() if hasattr(pair, "model_dump") else pair
    db.commit()
    return out


@router.post("/verify", response_model=TokenOut)
def verify(data: VerifyIn, request: Request, db: Session = Depends(get_db)):
    """Second step of sign-in: the 6-digit code (or a recovery code) for the mfa_token of the password step."""
    c = mfa.decode_mfa_token(data.mfa_token, "verify")
    user = _load(db, c["rid"], c["sub"])
    key, ip = _guard(db, user, request)
    if not mfa.check_second_factor(db, user, data.code, data.recovery_code):
        db.rollback()
        accounts.record_failure(db, key, ip)
        raise HTTPException(401, "Invalid code")
    accounts.clear_failures(db, key)
    if data.recovery_code:
        audit.record(db, _Actor(user, True), "auth.mfa_recovery_code_used", "user", user.id)
    _, out = tokens.issue_pair(db, user, request.headers.get("user-agent"))
    db.commit()
    return out


@router.post("/disable", status_code=204)
def disable(data: DisableIn, request: Request, creds: HTTPAuthorizationCredentials | None = Depends(bearer),
            db: Session = Depends(get_db)):
    """Turns two-factor sign-in off: needs the password AND a current code (or a recovery code)."""
    a = _actor(db, creds, None)
    key, ip = _guard(db, a.user, request)
    if not verify_password(data.password, a.user.password_hash) or \
            not mfa.check_second_factor(db, a.user, data.code, data.recovery_code):
        db.rollback()
        accounts.record_failure(db, key, ip)
        raise HTTPException(403, "Password or code is not right")
    mfa.disable(db, a.user)
    audit.record(db, a, "auth.mfa_disabled", "user", a.user.id)
    db.commit()
    return Response(status_code=204)
