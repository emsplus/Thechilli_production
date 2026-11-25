import uuid

from sqlalchemy.orm import Session

from app.models import AuditLog

_CARD_KEYS = {"number", "card_number", "cvv", "cvc", "cvv2", "pan", "expiry_month", "expiry_year", "exp_month",
              "exp_year", "track", "pin"}


def scrub(obj):
    """Drop anything resembling raw card data before a payload is stored. Razorpay sends only last4/network."""
    if isinstance(obj, dict):
        return {k: scrub(v) for k, v in obj.items() if k.lower() not in _CARD_KEYS}
    if isinstance(obj, list):
        return [scrub(v) for v in obj]
    return obj


def audit(db: Session, tenant_id: str, actor: str, action: str, intent_id: uuid.UUID | None = None, **detail) -> None:
    db.add(AuditLog(tenant_id=tenant_id, actor=actor, action=action, intent_id=intent_id, detail=detail))
