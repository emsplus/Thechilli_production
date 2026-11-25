"""Audit + security-event writers. They only add rows to the caller's session, so the audit entry commits atomically
with the change it describes."""
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditLog, SecurityEvent


def jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [jsonable(x) for x in v]
    if isinstance(v, (uuid.UUID, datetime, date, Decimal)):
        return str(v.isoformat() if hasattr(v, "isoformat") else v)
    return v


SECRET_KEYS = {"password", "password_hash", "token", "key", "key_hash", "token_hash", "secret"}


def scrub(d):
    if isinstance(d, dict):
        return {k: ("[redacted]" if k in SECRET_KEYS else scrub(v)) for k, v in d.items()}
    return d


def audit(db: Session, principal, action: str, target_type: str | None = None, target_id=None, tenant_id=None,
          before=None, after=None, meta=None) -> AuditLog:
    row = AuditLog(
        actor_type=getattr(principal, "kind", "system") if principal else "anonymous",
        actor_id=str(principal.id) if principal and getattr(principal, "id", None) else None,
        actor_label=getattr(principal, "label", None) if principal else None,
        action=action, target_type=target_type, target_id=str(target_id) if target_id else None,
        tenant_id=tenant_id, ip=getattr(principal, "ip", None) if principal else None,
        before=jsonable(scrub(before)) if before is not None else None,
        after=jsonable(scrub(after)) if after is not None else None,
        meta=jsonable(meta) if meta is not None else None)
    db.add(row)
    return row


def security_event(db: Session, type_: str, severity="info", staff_id=None, email=None, ip=None, details=None) -> None:
    db.add(SecurityEvent(type=type_, severity=severity, staff_id=staff_id, email=email, ip=ip, details=jsonable(details)))
