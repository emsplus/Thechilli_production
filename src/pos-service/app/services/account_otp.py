"""Sign-up email verification and password reset by one-time code (docs/EMAIL.md; codes: services/otp.py).

Sign-up (SIGNUP_EMAIL_VERIFICATION, default on): POST /auth/register-restaurant validates the request exactly as before but
creates NOTHING: it stores the pending registration (password as an argon2 hash) with a code and emails the code. POST
/auth/verify-email {email, otp} creates the restaurant, its owner and outlet (the same code path as the old immediate
sign-up) and returns the session. Until then no user holds the address, so a sign-up with someone else's email can neither
lock them out nor be used (security review finding 1).

Password reset (PASSWORD_RESET_MODE=otp, default): request -> always the same 200 (no enumeration; the email goes out off the
request thread only when an active account exists); verify {email, otp} -> a 10-minute single-use reset token; complete
{email, reset_token, new_password} -> the password of every active account with this email (or only `restaurant_id`'s) is
changed, every device is signed out, a 'password changed' notice is sent."""
import logging
import uuid
from types import SimpleNamespace

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import delete, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import hash_password
from app.core.tenancy import tenant_session
from app.models.core import LoginAttempt, PasswordResetToken, Restaurant, User
from app.services import audit, email_brand as B, mail, otp, tokens

log = logging.getLogger("app.account_otp")
_FIND = text("SELECT user_id, restaurant_id FROM auth_find_reset_users(:e)")


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


# ---------------------------------------------------------------- templates (English only, TheChilli.ai frame)
def render_code(kind: str, code: str, name: str = "", restaurant: str = "") -> tuple[str, str, str]:
    """kind: signup | password_reset -> (subject, text, html). The code is NOT in the subject (it would show in logs and
    notification previews)."""
    mins = settings.otp_minutes
    name = mail.clean(name, 120) or "there"
    restaurant = mail.clean(restaurant, 200)
    if kind == "signup":
        subject = "Verify your email for TheChilli.ai"
        title = "Verify your email"
        lines = [f"Hello {name},",
                 f"Use this code to finish creating {restaurant or 'your restaurant'} on TheChilli.ai:"]
        after = [f"The code expires in {mins} minutes and works once.",
                 "If you did not sign up, ignore this email: no account is created without this code."]
    else:
        subject = "Your TheChilli.ai password reset code"
        title = "Reset your password"
        lines = [f"Hello {name},", "Use this code to choose a new password for your TheChilli.ai account:"]
        after = [f"The code expires in {mins} minutes and works once.",
                 "If you did not ask for this, ignore this email: your password stays the same."]
    text_ = "\n".join([*lines, "", f"    {code}", "", *after, "", B.TEXT_FOOTER]) + "\n"
    body = "".join(B.p(x) for x in lines) + B.code(code) + "".join(B.p(x, muted=True) for x in after)
    return subject, text_, B.layout(title, body, preheader=f"Your code expires in {mins} minutes")


def _send_code(kind: str, to: str, code: str, name: str, restaurant: str) -> None:
    try:
        subject, text_, html_ = render_code(kind, code, name, restaurant)
        mail.send(mail.build(to, subject, text_, html_, from_name="TheChilli.ai"))
    except Exception as e:  # noqa: BLE001 - never raised to the request; never with the code or secrets
        log.warning("%s code email to %s could not be sent: %s", kind, mail.redact(to), mail.safe_error(e))


# ---------------------------------------------------------------- sign-up
def pending_response(email: str) -> JSONResponse:
    return JSONResponse(status_code=202, content={
        "status": "verification_required", "email": otp.norm(email),
        "detail": "We emailed a 6-digit code. Enter it to finish creating your restaurant.",
        "expires_in_seconds": settings.otp_minutes * 60, "resend_after_seconds": settings.otp_resend_seconds})


def start_signup(db: Session, data, request: Request) -> JSONResponse:
    """Stores the pending registration and emails its code. 202, no session."""
    otp.throttle_send("signup", data.owner_email, client_ip(request))
    payload = {"registration": {**data.model_dump(mode="json", exclude={"owner_password"})},
               "password_hash": hash_password(data.owner_password)}
    db.rollback()  # nothing of a tenant may be bound here
    row, code = otp.issue(db, "signup", data.owner_email, payload, replace=False)
    job = (row.email, code, data.owner_name, data.restaurant_name)
    db.commit()
    mail.submit(_send_code, "signup", *job)
    return pending_response(row.email)


def resend_signup(db: Session, email: str, request: Request) -> dict:
    """Same answer whether or not a sign-up is pending for this address."""
    otp.throttle_send("signup", email, client_ip(request))
    row = otp.latest_pending(db, "signup", email)
    if row is not None:
        reg = (row.payload or {}).get("registration", {})
        code = otp.reissue(db, row)
        job = (row.email, code, reg.get("owner_name", ""), reg.get("restaurant_name", ""))
        db.commit()
        mail.submit(_send_code, "signup", *job)
    else:
        db.rollback()
    return {"detail": "If a sign-up is waiting for this email, a new code has been sent.",
            "resend_after_seconds": settings.otp_resend_seconds}


def verify_signup(db: Session, email: str, code: str, request: Request):
    """Consumes the code and creates the restaurant exactly like the old immediate sign-up. Returns TokenOut."""
    from app.api.v1 import auth as auth_api  # the one tenant-creation path
    from app.schemas.common import RegisterRestaurantIn
    otp.throttle_verify(client_ip(request))
    row = otp.verify(db, "signup", email, code)
    reg = dict((row.payload or {}).get("registration") or {})
    pw_hash = (row.payload or {}).get("password_hash")
    if not reg or not pw_hash:
        db.rollback()
        raise HTTPException(400, otp.INVALID)
    row.payload = None  # the pending data (and its password hash) is not kept once used
    data = RegisterRestaurantIn.model_construct(**{**reg, "owner_password": ""})
    # Same transaction as the code's consumption (email_otps is not tenant data): both commit together, or neither does.
    return auth_api.create_restaurant(data, request, db, password_hash=pw_hash)


# ---------------------------------------------------------------- password reset
def request_reset(db: Session, email: str, request: Request, restaurant_id: uuid.UUID | None = None) -> dict:
    otp.throttle_send("password_reset", email, client_ip(request))
    matches = db.execute(_FIND, {"e": otp.norm(email)}).all()
    db.rollback()
    if restaurant_id is not None:
        matches = [m for m in matches if m.restaurant_id == restaurant_id]
    if matches:
        try:
            name = ""
            with tenant_session(matches[0].restaurant_id) as t:
                u = t.get(User, matches[0].user_id)
                name = u.full_name if u else ""
            row, code = otp.issue(db, "password_reset", email,
                                  {"restaurant_id": str(restaurant_id)} if restaurant_id else None)
            job = (row.email, code, name)
            db.commit()
            mail.submit(_send_code, "password_reset", *job, "")
        except Exception:  # noqa: BLE001 - the answer never changes
            db.rollback()
            log.exception("password reset code could not be issued")
    else:
        otp.code_hash(uuid.uuid4(), "000000")
    return {"detail": "If an account exists for this email, we have sent a code to it."}


def verify_reset(db: Session, email: str, code: str, request: Request) -> dict:
    otp.throttle_verify(client_ip(request))
    row = otp.verify(db, "password_reset", email, code)
    token = otp.grant(db, row)
    db.commit()
    return {"reset_token": token, "expires_in_seconds": settings.otp_minutes * 60}


def complete_reset(db: Session, email: str, reset_token: str, new_password: str, request: Request) -> None:
    from sqlalchemy import update
    from datetime import datetime, timezone
    otp.throttle_verify(client_ip(request))
    row = otp.use_grant(db, email, reset_token)
    only = (row.payload or {}).get("restaurant_id")
    db.commit()
    matches = db.execute(_FIND, {"e": otp.norm(email)}).all()
    db.rollback()
    new_hash = hash_password(new_password)
    notices = []
    for m in matches:
        if only and str(m.restaurant_id) != only:
            continue
        with tenant_session(m.restaurant_id) as t:
            u = t.get(User, m.user_id)
            rest = t.get(Restaurant, m.restaurant_id)
            if not u or not u.is_active:
                continue
            u.password_hash = new_hash
            t.execute(update(PasswordResetToken).where(PasswordResetToken.user_id == u.id, PasswordResetToken.used_at.is_(None))
                      .values(used_at=datetime.now(timezone.utc)))  # emailed links die too
            t.execute(delete(LoginAttempt).where(LoginAttempt.email == u.email.strip().lower()))
            tokens.revoke_user(t, u.id, "password_reset")
            audit.record(t, SimpleNamespace(restaurant_id=m.restaurant_id, user_id=u.id), "auth.password_reset_by_code",
                         "user", u.id)
            notices.append((u.email, "en", rest.name if rest else "", u.full_name))
            t.commit()
    from app.services import account_mail
    for n in notices:
        mail.submit(account_mail._send_changed, *n)
    if not notices:  # the accounts vanished or were deactivated meanwhile
        raise HTTPException(400, "This reset session is invalid or has expired. Start again.")
