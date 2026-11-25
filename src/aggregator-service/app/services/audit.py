from sqlalchemy.orm import Session

from app.models import AuditLog


def audit(s: Session, *, actor: str, action: str, tenant_id: str | None = None, entity_type: str | None = None,
          entity_id=None, **details) -> None:
    """Append-only; written in the caller's transaction so a change and its audit row commit together."""
    s.add(AuditLog(actor=actor, action=action, tenant_id=tenant_id, entity_type=entity_type,
                   entity_id=str(entity_id) if entity_id is not None else None, details=details))
