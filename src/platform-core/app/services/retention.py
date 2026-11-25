"""Retention purge of personal data in the login / security tables (security review 2026-10-31, finding 14: emails and IPs
in login_attempts, mfa_attempts, security_events, audit_log and refresh_tokens were kept forever).

Windows (days, settings RETENTION_*): login and MFA attempts 30, refresh tokens 30 after they expired or were revoked,
security events 365, audit log 730. 0 = keep forever. audit_log / security_events can never be purged younger than 90 days
(enforced by the database trigger, migration sec0004). Runs daily from a background thread (RETENTION_SWEEP_SECONDS, 0 = off)
or on demand: `python -m app.services.retention`. NEEDS LEGAL REVIEW: the statutory retention of audit records."""
import logging
from datetime import timedelta

from sqlalchemy import delete, or_, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import AuditLog, LoginAttempt, MfaAttempt, RefreshToken, SecurityEvent, StepUpGrant, utcnow

log = logging.getLogger("app.retention")
APPEND_ONLY_FLOOR_DAYS = 90


def purge(db: Session) -> dict[str, int]:
    now = utcnow()
    out: dict[str, int] = {}

    def cutoff(days: int):
        return now - timedelta(days=days)

    if settings.retention_login_days > 0:
        c = cutoff(settings.retention_login_days)
        out["login_attempts"] = db.execute(delete(LoginAttempt).where(LoginAttempt.at < c)).rowcount
        out["mfa_attempts"] = db.execute(delete(MfaAttempt).where(MfaAttempt.at < c)).rowcount
        out["step_up_grants"] = db.execute(delete(StepUpGrant).where(StepUpGrant.expires_at < c)).rowcount  # docs/STEP_UP.md
    if settings.retention_refresh_token_days > 0:
        c = cutoff(settings.retention_refresh_token_days)
        out["refresh_tokens"] = db.execute(delete(RefreshToken).where(
            or_(RefreshToken.expires_at < c, RefreshToken.revoked_at < c))).rowcount
    db.execute(text("SELECT set_config('app.retention_purge', 'on', true)"))  # transaction-local: the trigger's opt-in
    for model, days, key in ((SecurityEvent, settings.retention_security_event_days, "security_events"),
                             (AuditLog, settings.retention_audit_days, "audit_log")):
        if days > 0:
            out[key] = db.execute(delete(model).where(model.at < cutoff(max(days, APPEND_ONLY_FLOOR_DAYS)))).rowcount
    db.commit()
    log.info("retention purge: %s", out)
    return out


if __name__ == "__main__":  # pragma: no cover
    from app.core.db import SessionLocal
    with SessionLocal() as s:
        print(purge(s))
