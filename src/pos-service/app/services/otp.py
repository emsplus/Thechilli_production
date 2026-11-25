"""E-mail one-time codes (docs/EMAIL.md): sign-up verification and password reset.

Rules (all enforced here):
  * 6 random digits (`secrets.randbelow`), valid OTP_MINUTES (10), single use (consumed_at), at most OTP_MAX_ATTEMPTS (5)
    wrong tries per code, then the code is dead and a new one must be requested;
  * stored as HMAC-SHA256(key derived from JWT_SECRET, "<row id>:<code>") only: a database dump does not reveal codes and
    cannot be brute-forced offline without the server key; compared with hmac.compare_digest (constant time);
  * a new code for the same (purpose, email) at most once per OTP_RESEND_SECONDS (60), at most OTP_PER_EMAIL_PER_HOUR codes per
    email and OTP_PER_IP_PER_HOUR per client IP; checking codes is limited per IP (OTP_VERIFY_PER_IP_PER_HOUR). These counters
    count the same way whether or not an account exists, so a 429 never tells an address apart.
`email_otps` is a global table (no tenant yet / not known yet); see app/models/mail.py."""
import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.mail import EmailOtp
from app.services import abuse

PURPOSES = ("signup", "password_reset")
INVALID = "The code is invalid or has expired. Request a new code."


def now() -> datetime:
    return datetime.now(timezone.utc)


def norm(email: str) -> str:
    return (email or "").strip().lower()


def email_key(email: str) -> str:
    return hashlib.sha256(norm(email).encode()).hexdigest()[:40]


def _key() -> bytes:
    return hmac.new(settings.jwt_secret.encode(), b"chilli-email-otp-v1", hashlib.sha256).digest()


def code_hash(row_id: uuid.UUID, code: str) -> str:
    return hmac.new(_key(), f"{row_id}:{code}".encode(), hashlib.sha256).hexdigest()


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def throttle_send(purpose: str, email: str, ip: str) -> None:
    """Resend gap (OTP_RESEND_SECONDS) and hourly limits per email and per IP. 429 with Retry-After."""
    ek = email_key(email)
    gap = max(1, settings.otp_resend_seconds)
    if abuse.hit(f"otp:{purpose}:gap:{ek}", window=timedelta(seconds=gap), limit=2) > 1:
        wait = abuse.locked_for([f"otp:{purpose}:gap:{ek}"]) or gap
        raise HTTPException(429, "Please wait before asking for another code.", headers={"Retry-After": str(min(wait, gap))})
    abuse.throttle([(f"otp:{purpose}:email:{ek}", settings.otp_per_email_per_hour),
                    (f"otp:ip:{ip}", settings.otp_per_ip_per_hour)], window=timedelta(hours=1), what="code requests")


def throttle_verify(ip: str) -> None:
    abuse.throttle([(f"otp:verify:ip:{ip}", settings.otp_verify_per_ip_per_hour)], window=timedelta(hours=1),
                   what="code attempts")


def issue(db: Session, purpose: str, email: str, payload: dict | None = None, *, replace: bool = True) -> tuple[EmailOtp, str]:
    """A fresh code row (caller commits). replace=True voids the earlier unused codes of this (purpose, email); sign-up keeps
    them (each pending registration has its own row, so someone else signing up with your address cannot replace yours)."""
    assert purpose in PURPOSES
    email = norm(email)
    t = now()
    if replace:
        db.execute(update(EmailOtp).where(EmailOtp.purpose == purpose, EmailOtp.email == email,
                                          EmailOtp.consumed_at.is_(None)).values(consumed_at=t))
    code = new_code()
    row = EmailOtp(id=uuid.uuid4(), purpose=purpose, email=email, attempts=0, sends=1, last_sent_at=t,
                   expires_at=t + timedelta(minutes=settings.otp_minutes), payload=payload)
    row.code_hash = code_hash(row.id, code)
    db.add(row)
    db.flush()
    return row, code


def reissue(db: Session, row: EmailOtp) -> str:
    """New code on an existing pending row (resend): new expiry, attempts reset (the send limits bound the total tries)."""
    code = new_code()
    t = now()
    row.code_hash, row.attempts, row.expires_at = code_hash(row.id, code), 0, t + timedelta(minutes=settings.otp_minutes)
    row.sends, row.last_sent_at = (row.sends or 0) + 1, t
    db.flush()
    return code


def latest_pending(db: Session, purpose: str, email: str) -> EmailOtp | None:
    return db.scalar(select(EmailOtp).where(EmailOtp.purpose == purpose, EmailOtp.email == norm(email),
                                            EmailOtp.consumed_at.is_(None)).order_by(EmailOtp.created_at.desc()).limit(1))


def verify(db: Session, purpose: str, email: str, code: str) -> EmailOtp:
    """Consumes the matching live code of (purpose, email) and returns its row, or raises the same 400 for every failure (no
    such email, wrong / expired / used code, too many tries). Wrong tries are committed even though the request fails."""
    code = (code or "").strip()
    email = norm(email)
    t = now()
    rows = db.scalars(select(EmailOtp).where(EmailOtp.purpose == purpose, EmailOtp.email == email,
                                             EmailOtp.consumed_at.is_(None), EmailOtp.expires_at > t)
                      .order_by(EmailOtp.created_at.desc()).limit(5).with_for_update()).all()
    live = [r for r in rows if r.attempts < settings.otp_max_attempts]
    well_formed = len(code) == 6 and code.isdigit()
    hit = None
    for r in live:  # every candidate is compared (constant time each) so timing does not depend on which one matches
        ok = hmac.compare_digest(r.code_hash, code_hash(r.id, code if well_formed else "x"))
        if ok and well_formed and hit is None:
            hit = r
    if hit is None:
        if not live:
            code_hash(uuid.uuid4(), "000000")  # same work as one comparison
        for r in live:
            r.attempts += 1
        db.commit()
        raise HTTPException(400, INVALID)
    hit.consumed_at = t
    db.flush()
    return hit


# ---------------------------------------------------------------- password reset grant (after the code was entered)
def grant(db: Session, row: EmailOtp) -> str:
    token = secrets.token_urlsafe(32)
    row.grant_hash = hashlib.sha256(token.encode()).hexdigest()
    row.grant_expires_at = now() + timedelta(minutes=settings.otp_minutes)
    db.flush()
    return token


def use_grant(db: Session, email: str, token: str) -> EmailOtp:
    t = now()
    digest = hashlib.sha256((token or "").encode()).hexdigest()
    row = db.scalar(select(EmailOtp).where(EmailOtp.purpose == "password_reset", EmailOtp.email == norm(email),
                                           EmailOtp.grant_hash == digest).with_for_update())
    if row is None or row.grant_used_at is not None or row.grant_expires_at is None or row.grant_expires_at <= t:
        db.rollback()
        raise HTTPException(400, "This reset session is invalid or has expired. Start again.")
    row.grant_used_at = t
    db.flush()
    return row


def purge(db: Session, older_than: timedelta = timedelta(days=2)) -> int:
    """Removes old rows (codes are dead after OTP_MINUTES; the pending sign-up data goes with them)."""
    from sqlalchemy import delete
    res = db.execute(delete(EmailOtp).where(EmailOtp.expires_at < now() - older_than))
    return res.rowcount or 0
