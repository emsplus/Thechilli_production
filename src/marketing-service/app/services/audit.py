import uuid

from sqlalchemy.orm import Session

from app.models import AuditLog


def record(db: Session, actor_id: uuid.UUID | None, action: str, entity_type: str, entity_id: uuid.UUID | None,
           meta: dict | None = None) -> None:
    """Add an audit row to the caller's transaction (committed or rolled back together with the change).
    `meta` must hold ids, field NAMES and status transitions only: never contact details or other PII."""
    db.add(AuditLog(actor_id=actor_id, action=action, entity_type=entity_type, entity_id=entity_id, meta=meta))
