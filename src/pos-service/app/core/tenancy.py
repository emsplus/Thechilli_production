"""Tenant context for the database (docs/PHASE1_PLAN.md section (b) "Per-request mechanism", PR 2).

Every session that works for one tenant carries the tenant id in ``session.info["tenant_id"]``; at the start of EVERY
transaction of that session it is written to the transaction-local setting ``app.tenant_id`` with
``set_config('app.tenant_id', <id>, true)`` (= ``SET LOCAL``, which cannot take bind parameters). Services commit mid-request
and keep using the session, so setting it once per request would lose it at the first commit; transaction-local scope means a
pooled connection never carries tenant A into tenant B's work.

Row Level Security policies (app/core/rls.py, PR 3) read ``app.tenant_id``; an unbound transaction sees no tenant rows. Also an
opt-in guard (TENANT_GUARD=log|raise, default off) that reports statements touching tenant tables in a transaction with no
tenant bound - the staging check the plan asks for before RLS is switched on.
"""
import logging
import re
import uuid
from functools import cache

from sqlalchemy import event, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import Base, SessionLocal, engine

log = logging.getLogger("app.tenancy")

GUC = "app.tenant_id"
_SET = text("SELECT set_config('app.tenant_id', :t, true)")
_INFO_KEY = "tenant_id"
_CONN_KEY = "pos_tenant_bound"

# Tables without their own tenant column whose rows belong to a parent's tenant (PLAN section 0 / RLS child policies).
CHILD_TABLES = frozenset({"menu_variants", "order_lines", "bill_lines", "recipe_ingredients", "purchase_lines", "ai_messages", "role_permissions"})
# Tables that are global by design (looked up before the tenant is known, or not tenant data at all).
GLOBAL_TABLES = frozenset({"login_attempts", "abuse_counters", "whatsapp_contacts", "alembic_version", "provisioning_requests"})


def _as_uuid(tenant_id) -> uuid.UUID:
    return tenant_id if isinstance(tenant_id, uuid.UUID) else uuid.UUID(str(tenant_id))


@event.listens_for(SessionLocal, "after_begin")
def _apply_tenant(session: Session, transaction, connection) -> None:
    t = session.info.get(_INFO_KEY)
    connection.info[_CONN_KEY] = t
    if t is not None:
        connection.execute(_SET, {"t": str(t)})


def bind_tenant(db: Session, tenant_id) -> uuid.UUID:
    """Binds the session to a tenant: for the current transaction (if one is open) and every later one. Raises ValueError for
    something that is not a UUID. Re-binding to a different tenant is refused: a session serves one tenant."""
    t = _as_uuid(tenant_id)
    current = db.info.get(_INFO_KEY)
    if current is not None and current != t:
        raise RuntimeError("session is already bound to another tenant")
    db.info[_INFO_KEY] = t
    if db.in_transaction():
        conn = db.connection()
        conn.execute(_SET, {"t": str(t)})
        conn.info[_CONN_KEY] = t
    return t


def session_tenant(db: Session) -> uuid.UUID | None:
    return db.info.get(_INFO_KEY)


def tenant_session(tenant_id) -> Session:
    """A new session bound to one tenant, for background jobs (auto print, re-order emails, OCR). Use as a context manager."""
    db = SessionLocal()
    bind_tenant(db, tenant_id)
    return db


# ------------------------------------------------------------------------------------------------ staging guard
@cache
def tenant_tables() -> frozenset[str]:
    """Tables whose rows belong to one tenant: every table with a restaurant_id column, the tenant root and the child tables."""
    names = {t.name for t in Base.metadata.tables.values() if "restaurant_id" in t.c}
    return frozenset(names | {"restaurants"} | CHILD_TABLES)


_TABLE_REF = re.compile(r'\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:ONLY\s+)?"?([a-z_][a-z0-9_]*)"?', re.IGNORECASE)


def touched_tenant_tables(statement: str) -> set[str]:
    tables = tenant_tables()
    return {m.lower() for m in _TABLE_REF.findall(statement) if m.lower() in tables}


class UnboundTenantError(RuntimeError):
    pass


def _guard(conn, cursor, statement, parameters, context, executemany) -> None:
    mode = settings.tenant_guard
    if mode not in ("log", "raise") or conn.info.get(_CONN_KEY) is not None:
        return
    hit = touched_tenant_tables(statement)
    if not hit:
        return
    msg = f"statement on tenant table(s) {sorted(hit)} with no tenant bound: {statement.split(chr(10))[0][:200]}"
    if mode == "raise":
        raise UnboundTenantError(msg)
    log.warning(msg, stack_info=True)


@event.listens_for(engine, "checkin")
def _forget_tenant(dbapi_conn, record) -> None:
    record.info.pop(_CONN_KEY, None)


event.listen(engine, "before_cursor_execute", _guard)
