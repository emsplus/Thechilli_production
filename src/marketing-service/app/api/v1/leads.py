import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.api import access
from app.api.deps import ADMIN, ANY_ROLE, SALES, Principal, require_roles
from app.core.db import get_db
from app.models import (Activity, Campaign, Demo, Lead, LeadStage, OnboardingApplication, ReferralAttribution, Role,
                        SignupInvitation)
from app.schemas.api import AssignIn, DuplicateOut, LeadCreate, LeadMergeIn, LeadOut, LeadUpdate, StageIn
from app.services import audit, leads as svc, referrals
from app.services.normalize import normalize_email, normalize_phone

router = APIRouter(prefix="/leads", tags=["leads"])


def _dups_409(dups):
    return HTTPException(409, {"message": "Possible duplicate lead",
                               "duplicates": [DuplicateOut.model_validate(d).model_dump(mode="json") for d in dups]})


@router.post("", response_model=LeadOut, status_code=201)
def create_lead(body: LeadCreate, force: bool = False, p: Principal = Depends(require_roles(*SALES)),
                db: Session = Depends(get_db)):
    phone_n, email_n = normalize_phone(body.phone), normalize_email(body.email)
    dups = svc.find_duplicates(db, phone_n, email_n)
    if dups and not force:
        raise _dups_409(dups)
    if body.owner_id and not p.is_admin and body.owner_id != p.user_id:
        raise HTTPException(403, "Only an admin can assign a lead to someone else")
    if body.campaign_id and not db.get(Campaign, body.campaign_id):
        raise HTTPException(422, "Unknown campaign")
    owner_id = body.owner_id or (p.user_id if p.role == Role.salesperson else None)
    if owner_id:
        access.active_user(db, owner_id, Role.salesperson, Role.marketing_admin)
    lead = Lead(**body.model_dump(exclude={"referral_code", "owner_id"}), phone_norm=phone_n, email_norm=email_n,
                owner_id=owner_id, created_by=p.user_id)
    db.add(lead)
    db.flush()
    if body.referral_code:
        referrals.attribute_lead(db, lead, referrals.usable_code(db, body.referral_code))
    audit.record(db, p.user_id, "lead.created", "lead", lead.id,
                 {"source": lead.source, "duplicate_forced": bool(dups)})
    db.commit()
    return lead


@router.get("/duplicates", response_model=list[DuplicateOut])
def check_duplicates(phone: str | None = None, email: str | None = None,
                     p: Principal = Depends(require_roles(*SALES)), db: Session = Depends(get_db)):
    try:
        return svc.find_duplicates(db, normalize_phone(phone), normalize_email(email))
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.get("", response_model=list[LeadOut])
def list_leads(stage: LeadStage | None = None, owner_id: uuid.UUID | None = None, campaign_id: uuid.UUID | None = None,
               unassigned: bool = False, q: str | None = Query(None, max_length=100),
               limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
               p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    st = select(Lead).where(access.lead_filter(p)).order_by(Lead.created_at.desc(), Lead.id)
    if stage:
        st = st.where(Lead.stage == stage)
    if owner_id:
        st = st.where(Lead.owner_id == owner_id)
    if unassigned:
        st = st.where(Lead.owner_id.is_(None))
    if campaign_id:
        st = st.where(Lead.campaign_id == campaign_id)
    if q:
        like = f"%{q.strip()}%"
        digits = "".join(c for c in q if c.isdigit())
        conds = [Lead.business_name.ilike(like), Lead.contact_name.ilike(like), Lead.email.ilike(like)]
        if len(digits) >= 4:
            conds.append(Lead.phone_norm.ilike(f"%{digits}%"))
        st = st.where(or_(*conds))
    return list(db.scalars(st.limit(limit).offset(offset)))


@router.get("/{lead_id}", response_model=LeadOut)
def get_lead(lead_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    return access.get_lead(db, p, lead_id)


@router.patch("/{lead_id}", response_model=LeadOut)
def update_lead(lead_id: uuid.UUID, body: LeadUpdate, force: bool = False, p: Principal = Depends(require_roles(*SALES)),
                db: Session = Depends(get_db)):
    lead = access.get_lead(db, p, lead_id)
    data = body.model_dump(exclude_unset=True)
    for required in ("business_name", "contact_name"):
        if required in data and data[required] is None:
            raise HTTPException(422, f"{required} cannot be cleared")
    if "campaign_id" in data and data["campaign_id"] and not db.get(Campaign, data["campaign_id"]):
        raise HTTPException(422, "Unknown campaign")
    new_phone = data.get("phone", lead.phone)
    new_email = data.get("email", lead.email)
    if not new_phone and not new_email:
        raise HTTPException(422, "A lead needs a phone or an email")
    phone_n, email_n = normalize_phone(new_phone), normalize_email(new_email)
    if (phone_n != lead.phone_norm or email_n != lead.email_norm) and not force:
        dups = svc.find_duplicates(db, phone_n, email_n, exclude_id=lead.id)
        if dups:
            raise _dups_409(dups)
    for k, v in data.items():
        setattr(lead, k, v)
    lead.phone_norm, lead.email_norm = phone_n, email_n
    audit.record(db, p.user_id, "lead.updated", "lead", lead.id, {"fields": sorted(data)})
    db.commit()
    return lead


@router.post("/{lead_id}/assign", response_model=LeadOut)
def assign_lead(lead_id: uuid.UUID, body: AssignIn, p: Principal = Depends(require_roles(*SALES)),
                db: Session = Depends(get_db)):
    lead = access.get_lead(db, p, lead_id)
    if not p.is_admin:  # a salesperson may only claim an unassigned lead for themselves
        if body.owner_id != p.user_id or lead.owner_id not in (None, p.user_id):
            raise HTTPException(403, "Only an admin can assign or reassign leads")
    if body.owner_id:
        access.active_user(db, body.owner_id, Role.salesperson, Role.marketing_admin)
    audit.record(db, p.user_id, "lead.assigned", "lead", lead.id,
                 {"from": str(lead.owner_id) if lead.owner_id else None,
                  "to": str(body.owner_id) if body.owner_id else None})
    lead.owner_id = body.owner_id
    db.commit()
    return lead


@router.post("/{lead_id}/stage", response_model=LeadOut)
def change_stage(lead_id: uuid.UUID, body: StageIn, p: Principal = Depends(require_roles(*SALES)),
                 db: Session = Depends(get_db)):
    lead = access.get_lead(db, p, lead_id)
    svc.check_transition(lead.stage, body.stage, body.lost_reason)
    audit.record(db, p.user_id, "lead.stage_changed", "lead", lead.id, {"from": lead.stage.value, "to": body.stage.value})
    lead.stage = body.stage
    lead.lost_reason = body.lost_reason.strip() if body.stage == LeadStage.lost else None
    db.commit()
    return lead


@router.post("/{lead_id}/merge", response_model=LeadOut)
def merge_lead(lead_id: uuid.UUID, body: LeadMergeIn, p: Principal = Depends(require_roles(*SALES)),
               db: Session = Depends(get_db)):
    """Merge a duplicate (`source_id`) into this lead. The caller must be able to see both."""
    target = access.get_lead(db, p, lead_id)
    source = access.get_lead(db, p, body.source_id)
    svc.merge(db, target, source, p.user_id)
    db.commit()
    return target


@router.delete("/{lead_id}", status_code=204)
def delete_lead(lead_id: uuid.UUID, p: Principal = Depends(require_roles(*ADMIN)), db: Session = Depends(get_db)):
    lead = db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(404, "Lead not found")
    if db.scalar(select(OnboardingApplication.id).where(OnboardingApplication.lead_id == lead.id).limit(1)) or \
            db.scalar(select(SignupInvitation.id).where(SignupInvitation.lead_id == lead.id).limit(1)):
        raise HTTPException(409, "Lead has onboarding applications or invitations and cannot be deleted")
    for model in (Activity, Demo, ReferralAttribution):
        db.execute(delete(model).where(model.lead_id == lead.id))
    audit.record(db, p.user_id, "lead.deleted", "lead", lead.id)
    db.delete(lead)
    db.commit()
