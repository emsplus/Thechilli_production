"""Account emails: password reset (forgot / reset flow), 'password changed' notice, optional 'new device sign-in' notice.

Reset tokens: 256 random bits (`secrets.token_urlsafe(32)`), only the sha256 digest is stored, single use, expire after
PASSWORD_RESET_MINUTES (30). The emailed link names the restaurant (`r`) so the lookup runs inside that tenant under RLS (a
user may belong to several restaurants and gets one email per restaurant); the token itself travels in the URL fragment so it
is not sent to servers in the request line / logs / Referer.

No user enumeration: `request_reset` returns nothing and does the same visible work for known and unknown emails; the email
is sent off the request thread."""
import hashlib
import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import delete, exists, select, text, update
from sqlalchemy.orm import Session

from app.core import password_policy
from app.core.config import settings
from app.core.security import hash_password
from app.core.tenancy import tenant_session
from app.models.core import LoginAttempt, PasswordResetToken, RefreshToken, Restaurant, User
from app.services import audit, comms_templates as T, mail, tokens

log = logging.getLogger("app.account_mail")

TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{20,100}")
INVALID = "This reset link is invalid or has expired"
_FIND = text("SELECT user_id, restaurant_id FROM auth_find_reset_users(:e)")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def reset_link(restaurant_id: uuid.UUID, token: str) -> str:
    base = (settings.app_base_url or settings.public_base_url or (settings.cors_origins[0] if settings.cors_origins else "")).rstrip("/")
    return f"{base}/reset-password?r={restaurant_id}#t={quote(token, safe='')}"


def _deliver(kind: str, to: str, locale: str, restaurant: str, link: str | None = None, **v) -> None:
    """Builds and sends one email; any failure is logged (never raised, never with secrets)."""
    try:
        subject, text_, html_ = T.render(kind, locale, link=link, restaurant=restaurant, **v)
        mail.send(mail.build(to, subject, text_, html_, from_name=restaurant))
    except Exception as e:  # noqa: BLE001
        log.warning("%s email could not be sent: %s", kind, mail.safe_error(e))


def request_reset(db: Session, email: str, locale: str, restaurant_id: uuid.UUID | None = None) -> None:
    """Creates a token and queues the email for every ACTIVE user with this email (one per restaurant). Silent for unknown
    emails. Never raises for a mail problem."""
    secrets.token_urlsafe(32)  # same cost whether or not the email exists
    matches = db.execute(_FIND, {"e": email}).all()
    db.rollback()
    for m in matches:
        if restaurant_id is not None and m.restaurant_id != restaurant_id:
            continue
        try:
            token = secrets.token_urlsafe(32)
            with tenant_session(m.restaurant_id) as t:
                user = t.get(User, m.user_id)
                rest = t.get(Restaurant, m.restaurant_id)
                if not user or not user.is_active or not rest:
                    continue
                now = _now()
                t.execute(update(PasswordResetToken).where(PasswordResetToken.user_id == user.id,
                                                           PasswordResetToken.used_at.is_(None)).values(used_at=now))  # older links die
                t.add(PasswordResetToken(restaurant_id=rest.id, user_id=user.id, token_hash=digest(token),
                                         expires_at=now + timedelta(minutes=settings.password_reset_minutes)))
                audit.record(t, SimpleNamespace(restaurant_id=rest.id, user_id=user.id), "auth.password_reset_requested", "user", user.id)
                job = (user.email, locale, rest.name, reset_link(rest.id, token), user.full_name)
                t.commit()
            mail.submit(_send_reset, *job)
        except Exception:  # noqa: BLE001 - one restaurant's problem must not change the answer
            log.exception("password reset request could not be processed")


def _send_reset(to: str, locale: str, restaurant: str, link: str, name: str) -> None:
    _deliver("password_reset", to, locale, restaurant, link=link, name=name, minutes=settings.password_reset_minutes)


def complete_reset(db: Session, restaurant_id: uuid.UUID, token: str, new_password: str, locale: str) -> None:
    """Single-use: the row is locked, checked and marked used in one transaction. Every failure is the same 400."""
    from app.core.tenancy import bind_tenant
    if not TOKEN_RE.fullmatch(token or ""):
        raise HTTPException(400, INVALID)
    bind_tenant(db, restaurant_id)
    row = db.scalar(select(PasswordResetToken).where(PasswordResetToken.restaurant_id == restaurant_id,
                                                     PasswordResetToken.token_hash == digest(token)).with_for_update())
    now = _now()
    user = db.get(User, row.user_id) if row else None
    if not row or row.used_at is not None or row.expires_at <= now or not user or not user.is_active \
            or user.restaurant_id != restaurant_id:
        db.rollback()
        raise HTTPException(400, INVALID)
    msg = password_policy.problem(new_password, user.email, user.full_name)  # security review finding 7
    if msg:
        db.rollback()  # the link stays usable: the user picks a better password
        raise HTTPException(422, msg)
    row.used_at = now
    user.password_hash = hash_password(new_password)
    user.must_change_password = False
    db.execute(update(PasswordResetToken).where(PasswordResetToken.user_id == user.id,
                                                PasswordResetToken.used_at.is_(None)).values(used_at=now))
    db.execute(delete(LoginAttempt).where(LoginAttempt.email == user.email.strip().lower()))
    tokens.revoke_user(db, user.id, "password_reset")  # every device signs in again with the new password
    audit.record(db, SimpleNamespace(restaurant_id=restaurant_id, user_id=user.id), "auth.password_reset_by_email", "user", user.id)
    rest = db.get(Restaurant, restaurant_id)
    job = (user.email, locale, rest.name if rest else "", user.full_name)
    db.commit()
    mail.submit(_send_changed, *job)


def _send_changed(to: str, locale: str, restaurant: str, name: str) -> None:
    _deliver("password_changed", to, locale, restaurant, name=name)


# ---------------------------------------------------------------- optional 'new device sign-in' notice
def is_new_device(db: Session, user: User, device_label: str | None) -> bool:
    """True when this user has signed in before, but never from this device label (the User-Agent or the label the client
    sent). A user's very first sign-in is not 'new'. Looks at refresh_tokens, which are pruned a day after they expire."""
    label = (device_label or "")[:200]
    if not label:
        return False
    if db.scalar(select(exists().where(RefreshToken.user_id == user.id, RefreshToken.device_label == label))):
        return False
    return bool(db.scalar(select(exists().where(RefreshToken.user_id == user.id))))


def notify_new_device_to(email: str, locale: str, restaurant: str, name: str, device_label: str | None) -> None:
    mail.submit(_send_new_device, email, locale, restaurant, name, (device_label or "unknown device")[:120], T.when(_now()))


def _send_new_device(to: str, locale: str, restaurant: str, name: str, device: str, when: str) -> None:
    _deliver("new_device", to, locale, restaurant, name=name, device=device, when=when)


# ---------------------------------------------------------------- 'someone tried to register with your email' notice
def notify_register_attempt(email: str, locale: str) -> None:
    """Security review finding 1: a refused registration with an email that already has an account tells its holder, at most
    once a day per address (abuse counter), so the notice cannot be used to flood someone's inbox. Never raises."""
    from app.services import abuse
    try:
        key = f"regnotice:{hashlib.sha256(email.strip().lower().encode()).hexdigest()}"
        if abuse.hit(key, window=timedelta(days=1), limit=10_000) > 1:
            return
        mail.submit(_send_register_attempt, email.strip(), locale)
    except Exception:  # noqa: BLE001
        log.warning("register-attempt notice could not be queued")


def _send_register_attempt(to: str, locale: str) -> None:
    _deliver("register_attempt", to, locale, "TheChilli.ai", name="")
