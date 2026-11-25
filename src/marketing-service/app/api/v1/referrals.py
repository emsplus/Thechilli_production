import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api import access
from app.api.deps import SALES, Principal, require_roles, read_roles
from app.core.db import get_db
from app.models import Campaign, ReferralAttribution, ReferralCode
from app.schemas.api import AttributionOut, ReferralCreate, ReferralOut, ReferralUpdate
from app.services import audit, referrals as svc

router = APIRouter(prefix="/referral-codes", tags=["referrals"])


def _out(db, rc) -> ReferralOut:
    out = ReferralOut.model_validate(rc, from_attributes=True)
    out.uses = svc.uses(db, rc)
    return out


def _mine(db, p, rc_id) -> ReferralCode:
    rc = db.get(ReferralCode, rc_id)
    if not rc or (not p.is_admin and rc.owner_id != p.user_id):
        raise HTTPException(404, "Referral code not found")
    return rc


@router.post("", response_model=ReferralOut, status_code=201)
def create_code(body: ReferralCreate, p: Principal = Depends(require_roles(*SALES)), db: Session = Depends(get_db)):
    if body.owner_id and body.owner_id != p.user_id and not p.is_admin:
        raise HTTPException(403, "Only an admin can create a code for someone else")
    owner_id = body.owner_id or p.user_id
    access.active_user(db, owner_id)
    if body.campaign_id and not db.get(Campaign, body.campaign_id):
        raise HTTPException(422, "Unknown campaign")
    rc = ReferralCode(code=(body.code or svc.generate_code(db)).upper(), owner_id=owner_id,
                      campaign_id=body.campaign_id, max_uses=body.max_uses, expires_at=body.expires_at)
    db.add(rc)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "That referral code already exists")
    audit.record(db, p.user_id, "referral.created", "referral_code", rc.id, {"owner_id": str(owner_id)})
    db.commit()
    return _out(db, rc)


@router.get("", response_model=list[ReferralOut])
def list_codes(p: Principal = Depends(read_roles(*SALES)), db: Session = Depends(get_db)):
    q = select(ReferralCode).order_by(ReferralCode.created_at.desc(), ReferralCode.id)
    if not p.is_admin:
        q = q.where(ReferralCode.owner_id == p.user_id)
    return [_out(db, rc) for rc in db.scalars(q)]


@router.patch("/{code_id}", response_model=ReferralOut)
def update_code(code_id: uuid.UUID, body: ReferralUpdate, p: Principal = Depends(require_roles(*SALES)),
                db: Session = Depends(get_db)):
    rc = _mine(db, p, code_id)
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(rc, k, v)
    audit.record(db, p.user_id, "referral.updated", "referral_code", rc.id, {"fields": sorted(data)})
    db.commit()
    return _out(db, rc)


@router.get("/{code_id}/attributions", response_model=list[AttributionOut])
def attributions(code_id: uuid.UUID, p: Principal = Depends(require_roles(*SALES)), db: Session = Depends(get_db)):
    rc = _mine(db, p, code_id)
    return list(db.scalars(select(ReferralAttribution).where(ReferralAttribution.referral_code_id == rc.id)
                           .order_by(ReferralAttribution.created_at, ReferralAttribution.id)))
