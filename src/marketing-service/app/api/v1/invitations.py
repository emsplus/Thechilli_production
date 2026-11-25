import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import access
from app.api.deps import ANY_ROLE, Principal, require_roles
from app.core.config import settings
from app.core.db import get_db
from app.core.security import new_opaque_token, utcnow
from app.models import DeliveryStatus, InvitationDelivery, SignupInvitation
from app.schemas.api import DeliveryOut, InvitationCreate, InvitationCreated, InvitationOut
from app.services import audit, referrals
from app.services.delivery import (DeliveryError, DeliveryProvider, InvitationMessage, get_delivery_provider,
                                   invite_link)
from app.services.onboarding import LOCKED

router = APIRouter(prefix="/invitations", tags=["invitations"])


@router.post("", response_model=InvitationCreated, status_code=201)
def create_invitation(body: InvitationCreate, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db),
                      provider: DeliveryProvider = Depends(get_delivery_provider)):
    """The raw token is returned once, in this response only; the database keeps its sha256 digest."""
    if not p.is_admin and not (body.lead_id or body.application_id):
        raise HTTPException(422, "lead_id or application_id is required")
    lead_id, app_id = body.lead_id, body.application_id
    if lead_id:
        access.get_lead(db, p, lead_id)
    if app_id:
        app = access.get_app(db, p, app_id)
        if app.status in LOCKED:
            raise HTTPException(409, f"Application is {app.status.value}")
    rc = referrals.usable_code(db, body.referral_code) if body.referral_code else None
    raw, digest = new_opaque_token()
    ttl = body.ttl_hours or settings.invitation_ttl_hours
    inv = SignupInvitation(token_hash=digest, email=body.email.lower(), lead_id=lead_id, application_id=app_id,
                           referral_code_id=rc.id if rc else None, expires_at=utcnow() + timedelta(hours=ttl),
                           created_by=p.user_id)
    db.add(inv)
    db.flush()
    audit.record(db, p.user_id, "invitation.created", "signup_invitation", inv.id, {"ttl_hours": ttl})
    status = _deliver(db, inv, raw, ttl, p, provider) if body.send else None
    db.commit()
    return InvitationCreated(**{**InvitationOut.model_validate(inv).model_dump(), "delivery_status": status}, token=raw)


def _deliver(db: Session, inv: SignupInvitation, raw: str, ttl_hours: int, p: Principal, provider: DeliveryProvider) -> str:
    """Send and record the attempt. A provider failure never fails the request: the invitation exists and can be resent."""
    status, mid, err = DeliveryStatus.sent, None, None
    try:
        mid = provider.send(InvitationMessage(to=inv.email, link=invite_link(raw), expires_hours=ttl_hours)).message_id
    except DeliveryError as e:
        status, err = DeliveryStatus.failed, str(e)[:300]
    db.add(InvitationDelivery(invitation_id=inv.id, provider=provider.name, provider_message_id=mid, status=status,
                              error=err, created_by=p.user_id))
    audit.record(db, p.user_id, "invitation.delivery_" + status.value, "signup_invitation", inv.id,
                 {"provider": provider.name})
    return status.value


def _owned(db: Session, p: Principal, invitation_id: uuid.UUID) -> SignupInvitation:
    inv = db.get(SignupInvitation, invitation_id)
    if not inv or (not p.is_admin and inv.created_by != p.user_id):
        raise HTTPException(404, "Invitation not found")
    return inv


@router.post("/{invitation_id}/resend", response_model=InvitationCreated)
def resend_invitation(invitation_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)),
                      db: Session = Depends(get_db), provider: DeliveryProvider = Depends(get_delivery_provider)):
    """Only the token's hash is stored, so a resend rotates the token (the old link stops working), extends the expiry
    and delivers the new link."""
    inv = _owned(db, p, invitation_id)
    if inv.used_at is not None or inv.revoked_at is not None:
        raise HTTPException(409, "Invitation is already used or revoked")
    raw, digest = new_opaque_token()
    ttl = settings.invitation_ttl_hours
    inv.token_hash, inv.expires_at = digest, utcnow() + timedelta(hours=ttl)
    db.flush()
    status = _deliver(db, inv, raw, ttl, p, provider)
    db.commit()
    return InvitationCreated(**{**InvitationOut.model_validate(inv).model_dump(), "delivery_status": status}, token=raw)


@router.get("/{invitation_id}/deliveries", response_model=list[DeliveryOut])
def list_deliveries(invitation_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    inv = _owned(db, p, invitation_id)
    return list(db.scalars(select(InvitationDelivery).where(InvitationDelivery.invitation_id == inv.id)
                           .order_by(InvitationDelivery.created_at.desc())))


@router.get("", response_model=list[InvitationOut])
def list_invitations(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                     p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    q = select(SignupInvitation).order_by(SignupInvitation.created_at.desc(), SignupInvitation.id)
    if not p.is_admin:
        q = q.where(SignupInvitation.created_by == p.user_id)
    rows = list(db.scalars(q.limit(limit).offset(offset)))
    last = {}
    for d in db.scalars(select(InvitationDelivery).where(InvitationDelivery.invitation_id.in_([r.id for r in rows]))
                        .order_by(InvitationDelivery.created_at)):
        last[d.invitation_id] = d.status.value
    return [InvitationOut.model_validate(r).model_copy(update={"delivery_status": last.get(r.id)}) for r in rows]


@router.post("/{invitation_id}/revoke", response_model=InvitationOut)
def revoke_invitation(invitation_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    inv = _owned(db, p, invitation_id)
    if inv.used_at is not None or inv.revoked_at is not None:
        raise HTTPException(409, "Invitation is already used or revoked")
    inv.revoked_at = utcnow()
    audit.record(db, p.user_id, "invitation.revoked", "signup_invitation", inv.id)
    db.commit()
    return inv
