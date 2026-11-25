"""Own session list / revoke. A session = a refresh-token family; revoking it also ends its access token (see deps)."""
from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.common import parse_uuid
from app.core import errors
from app.core.db import get_db
from app.core.deps import Principal, current_staff, require
from app.models import RefreshToken, StaffUser, utcnow
from app.services.audit import audit, security_event

router = APIRouter(tags=["sessions"])


def _live(staff_id):
    return (RefreshToken.staff_id == staff_id, RefreshToken.revoked_at.is_(None), RefreshToken.expires_at > utcnow())


def _view(db: Session, staff_id, current: str | None) -> list[dict]:
    started = dict(db.execute(select(RefreshToken.family_id, func.min(RefreshToken.created_at))
                              .where(RefreshToken.staff_id == staff_id).group_by(RefreshToken.family_id)).all())
    rows = db.scalars(select(RefreshToken).where(*_live(staff_id)).order_by(RefreshToken.created_at.desc())).all()
    return [{"id": str(r.family_id), "started_at": started[r.family_id].isoformat(), "last_active_at": r.created_at.isoformat(),
             "ip": r.ip, "user_agent": r.user_agent, "mfa": r.mfa, "current": current is not None and str(r.family_id) == current}
            for r in rows]


def _revoke(db: Session, staff_id, family=None) -> int:
    n = 0
    stmt = select(RefreshToken).where(RefreshToken.staff_id == staff_id, RefreshToken.revoked_at.is_(None))
    if family is not None:
        stmt = stmt.where(RefreshToken.family_id == family)
    for t in db.scalars(stmt):
        t.revoked_at, n = utcnow(), n + 1
    return n


@router.get("/auth/sessions")
def list_sessions(p: Principal = Depends(current_staff), db: Session = Depends(get_db)):
    return {"items": _view(db, p.id, p.session_id)}


@router.post("/auth/sessions/revoke-others")
def revoke_others(p: Principal = Depends(current_staff), db: Session = Depends(get_db)):
    """Sign out everywhere except here."""
    n = 0
    for s in _view(db, p.id, p.session_id):
        if not s["current"]:
            n += _revoke(db, p.id, parse_uuid(s["id"]))
    audit(db, p, "session.revoked_others", "staff_user", p.id, meta={"count": n})
    security_event(db, "sessions_revoked", staff_id=p.id, email=p.label, ip=p.ip, details={"scope": "others"})
    return {"ok": True, "revoked": n}


@router.delete("/auth/sessions/{session_id}")
def revoke_session(session_id: str, p: Principal = Depends(current_staff), db: Session = Depends(get_db)):
    fam = parse_uuid(session_id, "session")
    if not _revoke(db, p.id, fam):  # someone else's session looks exactly like a missing one
        raise errors.not_found("Session not found")
    audit(db, p, "session.revoked", "session", fam, meta={"current": str(fam) == p.session_id})
    security_event(db, "session_revoked", staff_id=p.id, email=p.label, ip=p.ip, details={"session": str(fam)})
    return {"ok": True}


@router.delete("/staff/{staff_id}/sessions")
def revoke_staff_sessions(staff_id: str, p: Principal = Depends(require("staff.manage", staff_only=True, step_up=True)), db: Session = Depends(get_db)):
    user = db.get(StaffUser, parse_uuid(staff_id, "staff user"))
    if user is None:
        raise errors.not_found("Staff user not found")
    n = _revoke(db, user.id)
    audit(db, p, "session.revoked_all", "staff_user", user.id, meta={"count": n})
    security_event(db, "sessions_revoked", "warn", staff_id=user.id, email=user.email, ip=p.ip, details={"scope": "all", "by": p.label})
    return {"ok": True, "revoked": n}
