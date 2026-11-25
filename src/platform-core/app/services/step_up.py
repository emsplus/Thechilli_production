"""Per-action step-up (docs/STEP_UP.md).

Sign-in checks the second factor once; a session then lives up to REFRESH_TOKEN_DAYS. Sensitive routes (money, privileges,
platform config) additionally need a fresh code: `POST /auth/step-up {code}` returns an opaque grant (sent back as header
`X-Step-Up-Token`) that is bound to the staff member AND the session, lives STEP_UP_MINUTES and authorizes STEP_UP_MAX_USES
protected requests. Only its sha256 is stored. A use is consumed in the same transaction as the action, so an action that
fails (and rolls back) does not spend the grant.

Who must step up (when STEP_UP_REQUIRED is in force): every staff member with a confirmed second factor, and every member of a
MFA_REQUIRED_ROLES role (who always has one, since sign-in demands it). Staff of other roles without a factor behave as before:
there is nothing to step up with. Service principals never reach these routes (they are staff_only)."""
import hmac
import secrets
from datetime import timedelta

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import errors
from app.core.config import settings
from app.core.security import sha256
from app.models import StaffMfa, StepUpGrant, utcnow
from app.services.audit import audit, security_event

HEADER = "X-Step-Up-Token"
TOKEN_PREFIX = "sut_"


def required_error(message: str = "Confirm this action with a fresh two-step code") -> errors.AppError:
    return errors.AppError(403, "step_up_required", message, {"X-Step-Up-Required": "true"})


def has_factor(db: Session, staff_id) -> bool:
    row = db.get(StaffMfa, staff_id)
    return bool(row and row.confirmed_at)


def needed(db: Session, p) -> bool:
    if not settings.step_up_enforced or p.kind != "staff":
        return False
    return p.role in settings.mfa_roles or has_factor(db, p.id)


def issue(db: Session, p, method: str) -> tuple[str, StepUpGrant]:
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    g = StepUpGrant(staff_id=p.id, session_id=p.session_id, token_hash=sha256(raw), method=method,
                    uses_left=max(1, settings.step_up_max_uses), ip=p.ip,
                    expires_at=utcnow() + timedelta(minutes=settings.step_up_minutes))
    db.add(g)
    db.flush()
    audit(db, p, "step_up.granted", "staff_user", p.id,
          meta={"grant_id": g.id, "method": method, "expires_at": g.expires_at, "uses": g.uses_left})
    security_event(db, "step_up_granted", staff_id=p.id, email=p.label, ip=p.ip, details={"grant_id": g.id, "method": method})
    return raw, g


def _deny(db: Session, p, request: Request, reason: str, grant_id=None):
    details = {"reason": reason, "path": request.url.path, "method": request.method}
    if grant_id is not None:
        details["grant_id"] = grant_id
    audit(db, p, "step_up.denied", "staff_user", p.id, meta=details)
    security_event(db, "step_up_denied", "warn", staff_id=p.id, email=p.label, ip=p.ip, details=details)
    db.commit()  # the denial is recorded even though the request fails
    return required_error("Your two-step confirmation has expired; enter a fresh code" if reason in ("expired", "spent")
                          else "Confirm this action with a fresh two-step code")


def enforce(db: Session, request: Request, p) -> StepUpGrant | None:
    """Raises 403 step_up_required unless the request carries a live grant for this staff member and session; consumes one
    use otherwise. No-op when step-up does not apply to the caller."""
    if not needed(db, p):
        return None
    raw = (request.headers.get(HEADER) or "").strip()
    if not raw:
        raise _deny(db, p, request, "missing")
    if p.role in settings.mfa_roles and not has_factor(db, p.id):
        raise _deny(db, p, request, "not_enrolled")
    digest = sha256(raw)
    g = db.scalar(select(StepUpGrant).where(StepUpGrant.token_hash == digest).with_for_update())
    if g is None or not hmac.compare_digest(g.token_hash, digest):
        raise _deny(db, p, request, "invalid")
    if str(g.staff_id) != str(p.id):
        raise _deny(db, p, request, "wrong_user", g.id)
    if not p.session_id or not hmac.compare_digest(str(g.session_id), str(p.session_id)):
        raise _deny(db, p, request, "wrong_session", g.id)
    now = utcnow()
    if g.expires_at <= now:
        raise _deny(db, p, request, "expired", g.id)
    if g.uses_left <= 0:
        raise _deny(db, p, request, "spent", g.id)
    g.uses_left -= 1
    g.last_used_at = now
    audit(db, p, "step_up.used", "staff_user", p.id,
          meta={"grant_id": g.id, "path": request.url.path, "method": request.method, "uses_left": g.uses_left})
    return g
