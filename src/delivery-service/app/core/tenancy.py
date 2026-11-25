"""Tenant context for the database (see docs/RLS.md).

A session that works for one tenant carries the id in ``session.info["tenant_id"]``; at the start of EVERY transaction of
that session it is written to the transaction-local setting ``app.tenant_id`` (``set_config(..., true)``). Services commit
mid-request and keep using the session, so a one-off SET would be lost at the first commit; transaction-local scope also
means a pooled connection never carries tenant A into tenant B's work. An unbound session sees no tenant rows.
"""
from sqlalchemy import event, text
from sqlalchemy.orm import Session

from app.core.db import SessionLocal

_SET = text("SELECT set_config('app.tenant_id', :t, true)")
_KEY = "tenant_id"


@event.listens_for(SessionLocal, "after_begin")
def _apply_tenant(session: Session, transaction, connection) -> None:
    t = session.info.get(_KEY)
    if t is not None:
        connection.execute(_SET, {"t": t})


def bind_tenant(db: Session, tenant_id: str) -> str:
    """Binds the session to one tenant for the current and every later transaction. Re-binding to a different tenant is
    refused: a session serves one tenant."""
    t = str(tenant_id).strip()
    if not t or len(t) > 64:
        raise ValueError("invalid tenant id")
    current = db.info.get(_KEY)
    if current is not None and current != t:
        raise RuntimeError("session is already bound to another tenant")
    db.info[_KEY] = t
    if db.in_transaction():
        db.connection().execute(_SET, {"t": t})
    return t


def tenant_session(tenant_id: str) -> Session:
    """A new session bound to one tenant (webhooks, background work). Close it when done."""
    db = SessionLocal()
    bind_tenant(db, tenant_id)
    return db
