from datetime import timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import Page, get_or_404, paged, parse_uuid, to_dict
from app.api.tenants import resolve_tenant
from app.core import errors
from app.core.config import settings
from app.core.db import get_db
from app.core.deps import Principal, require
from app.core.permissions import ROLE_PERMISSIONS
from app.core.security import create_support_access_token
from app.models import StaffUser, SupportAccessGrant, SupportTicket, TicketComment, utcnow
from app.services.audit import audit, security_event

router = APIRouter(tags=["support"])


class TicketIn(BaseModel):
    tenant: str | None = None
    subject: str = Field(min_length=3, max_length=300)
    body: str = Field(min_length=1, max_length=10000)
    priority: str = Field("normal", pattern="^(low|normal|high|urgent)$")
    requester_email: str | None = None


class TicketPatch(BaseModel):
    status: str | None = Field(None, pattern="^(open|in_progress|waiting|resolved|closed)$")
    priority: str | None = Field(None, pattern="^(low|normal|high|urgent)$")
    assignee_id: str | None = None


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=10000)
    internal: bool = True


@router.post("/tickets", status_code=201)
def create_ticket(body: TicketIn, p: Principal = Depends(require("tickets.manage", staff_only=True)), db: Session = Depends(get_db)):
    t = resolve_tenant(db, body.tenant) if body.tenant else None
    tk = SupportTicket(tenant_id=t.id if t else None, subject=body.subject, body=body.body, priority=body.priority,
                       requester_email=body.requester_email, created_by=p.label)
    db.add(tk)
    db.flush()
    audit(db, p, "ticket.created", "ticket", tk.id, tk.tenant_id, after={"subject": tk.subject, "priority": tk.priority})
    return to_dict(tk)


@router.get("/tickets")
def list_tickets(page: Page = Depends(), status: str | None = None, tenant: str | None = None,
                 _: Principal = Depends(require("tickets.read", staff_only=True)), db: Session = Depends(get_db)):
    stmt = select(SupportTicket)
    if status:
        stmt = stmt.where(SupportTicket.status == status)
    if tenant:
        stmt = stmt.where(SupportTicket.tenant_id == resolve_tenant(db, tenant).id)
    return paged(db, stmt, page, SupportTicket, SupportTicket.created_at.desc())


@router.get("/tickets/{tid}")
def get_ticket(tid: str, _: Principal = Depends(require("tickets.read", staff_only=True)), db: Session = Depends(get_db)):
    tk = get_or_404(db, SupportTicket, parse_uuid(tid), "Ticket")
    cs = db.scalars(select(TicketComment).where(TicketComment.ticket_id == tk.id).order_by(TicketComment.created_at)).all()
    return {**to_dict(tk), "comments": [to_dict(c) for c in cs]}


@router.patch("/tickets/{tid}")
def patch_ticket(tid: str, body: TicketPatch, p: Principal = Depends(require("tickets.manage", staff_only=True)),
                 db: Session = Depends(get_db)):
    tk = get_or_404(db, SupportTicket, parse_uuid(tid), "Ticket")
    before = {"status": tk.status, "priority": tk.priority, "assignee_id": str(tk.assignee_id) if tk.assignee_id else None}
    if body.assignee_id is not None:
        a = get_or_404(db, StaffUser, parse_uuid(body.assignee_id), "Assignee")
        tk.assignee_id = a.id
    if body.status:
        tk.status = body.status
    if body.priority:
        tk.priority = body.priority
    audit(db, p, "ticket.updated", "ticket", tk.id, tk.tenant_id, before=before,
          after={"status": tk.status, "priority": tk.priority, "assignee_id": str(tk.assignee_id) if tk.assignee_id else None})
    return to_dict(tk)


@router.post("/tickets/{tid}/comments", status_code=201)
def add_comment(tid: str, body: CommentIn, p: Principal = Depends(require("tickets.manage", staff_only=True)),
                db: Session = Depends(get_db)):
    tk = get_or_404(db, SupportTicket, parse_uuid(tid), "Ticket")
    c = TicketComment(ticket_id=tk.id, author=p.label, body=body.body, internal=body.internal)
    db.add(c)
    db.flush()
    audit(db, p, "ticket.commented", "ticket", tk.id, tk.tenant_id, meta={"internal": body.internal})
    return to_dict(c)


# ---------- support-access grants ----------
class GrantIn(BaseModel):
    tenant: str
    staff_id: str
    minutes: int = Field(gt=0)
    scope: str = Field("read_only", pattern="^(read_only|diagnostics)$")
    reason: str = Field(min_length=10, max_length=1000)
    ticket_id: str | None = None


def _active(g: SupportAccessGrant) -> bool:
    now = utcnow()
    return g.revoked_at is None and g.starts_at <= now < g.expires_at


@router.post("/support-access/grants", status_code=201)
def create_grant(body: GrantIn, p: Principal = Depends(require("support_access.grant", staff_only=True, step_up=True)), db: Session = Depends(get_db)):
    """A time-boxed, audited authorization for ONE support engineer to look at ONE tenant. This service only records it and
    can mint a short-lived token for pos-service to verify; it never fetches or proxies tenant operational data."""
    if body.minutes > settings.support_access_max_minutes:
        raise errors.bad(f"Maximum grant is {settings.support_access_max_minutes} minutes", "grant_too_long")
    t = resolve_tenant(db, body.tenant)
    grantee = get_or_404(db, StaffUser, parse_uuid(body.staff_id), "Staff user")
    if not grantee.is_active or "support_access.use" not in ROLE_PERMISSIONS[grantee.role]:
        raise errors.bad("Grantee must be an active staff member whose role may use support access", "bad_grantee")
    if str(grantee.id) == str(p.id):
        raise errors.forbidden("You cannot grant support access to yourself")
    ticket_id = None
    if body.ticket_id:
        ticket_id = get_or_404(db, SupportTicket, parse_uuid(body.ticket_id), "Ticket").id
    now = utcnow()
    g = SupportAccessGrant(tenant_id=t.id, staff_id=grantee.id, ticket_id=ticket_id, scope=body.scope, reason=body.reason,
                           granted_by=p.id, starts_at=now, expires_at=now + timedelta(minutes=body.minutes))
    db.add(g)
    db.flush()
    audit(db, p, "support_access.granted", "support_access_grant", g.id, t.id,
          after={"grantee": grantee.email, "minutes": body.minutes, "scope": body.scope}, meta={"reason": body.reason})
    security_event(db, "support_access_granted", "warn", staff_id=grantee.id, email=grantee.email, ip=p.ip, details={"tenant_id": t.id, "grant_id": g.id})
    return to_dict(g)


@router.get("/support-access/grants")
def list_grants(page: Page = Depends(), tenant: str | None = None, active: bool | None = None,
                _: Principal = Depends(require("support_access.read", staff_only=True)), db: Session = Depends(get_db)):
    stmt = select(SupportAccessGrant)
    if tenant:
        stmt = stmt.where(SupportAccessGrant.tenant_id == resolve_tenant(db, tenant).id)
    if active:
        now = utcnow()
        stmt = stmt.where(SupportAccessGrant.revoked_at.is_(None), SupportAccessGrant.expires_at > now)
    return paged(db, stmt, page, SupportAccessGrant, SupportAccessGrant.created_at.desc())


@router.post("/support-access/grants/{gid}/revoke")
def revoke_grant(gid: str, p: Principal = Depends(require("support_access.grant", staff_only=True)), db: Session = Depends(get_db)):
    g = get_or_404(db, SupportAccessGrant, parse_uuid(gid), "Grant")
    if g.revoked_at is None:
        g.revoked_at, g.revoked_by = utcnow(), p.id
        audit(db, p, "support_access.revoked", "support_access_grant", g.id, g.tenant_id)
    return to_dict(g)


@router.post("/support-access/grants/{gid}/token")
def mint_token(gid: str, p: Principal = Depends(require("support_access.use", staff_only=True)), db: Session = Depends(get_db)):
    g = get_or_404(db, SupportAccessGrant, parse_uuid(gid), "Grant")
    if str(g.staff_id) != str(p.id):
        security_event(db, "support_access_misuse", "critical", staff_id=p.id, email=p.label, ip=p.ip, details={"grant_id": g.id})
        db.commit()
        raise errors.forbidden("This grant was issued to someone else")
    if not _active(g):
        raise errors.conflict("Grant is not active (expired, revoked or not started)", "grant_inactive")
    remaining = int((g.expires_at - utcnow()).total_seconds() // 60) or 1
    minutes = min(settings.support_token_max_minutes, remaining)
    tok = create_support_access_token(str(p.id), str(g.tenant_id), str(g.id), g.scope, minutes)
    audit(db, p, "support_access.token_issued", "support_access_grant", g.id, g.tenant_id, meta={"minutes": minutes, "scope": g.scope})
    security_event(db, "support_access_token_issued", "warn", staff_id=p.id, email=p.label, ip=p.ip, details={"grant_id": g.id, "tenant_id": g.tenant_id})
    return {"access_token": tok, "token_type": "bearer", "expires_in": minutes * 60, "tenant_id": str(g.tenant_id), "scope": g.scope}


@router.get("/support-access/grants/{gid}/status")
def grant_status(gid: str, _: Principal = Depends(require("support_access.read", service_scope="support_access.verify")),
                 db: Session = Depends(get_db)):
    """For pos-service: is this grant still valid right now (catches revocation before token expiry)?"""
    g = get_or_404(db, SupportAccessGrant, parse_uuid(gid), "Grant")
    return {"grant_id": str(g.id), "tenant_id": str(g.tenant_id), "staff_id": str(g.staff_id), "scope": g.scope,
            "active": _active(g), "expires_at": g.expires_at.isoformat(), "revoked": g.revoked_at is not None}
