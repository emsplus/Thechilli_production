import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import ADMIN, ANY_ROLE, SALES, Principal, require_roles
from app.core.config import settings
from app.core.db import get_db
from app.models import Campaign, Lead, LeadStage, ReferralAttribution, ReferralCode
from app.schemas.api import CampaignCreate, CampaignOut, CampaignUpdate
from app.services import audit

router = APIRouter(prefix="/campaigns", tags=["campaigns"])


def _get(db, cid) -> Campaign:
    c = db.get(Campaign, cid)
    if not c:
        raise HTTPException(404, "Campaign not found")
    return c


@router.post("", response_model=CampaignOut, status_code=201)
def create_campaign(body: CampaignCreate, p: Principal = Depends(require_roles(*ADMIN)), db: Session = Depends(get_db)):
    c = Campaign(**body.model_dump(exclude={"currency"}), currency=(body.currency or settings.default_currency).upper(),
                 created_by=p.user_id)
    db.add(c)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A campaign with this name already exists")
    audit.record(db, p.user_id, "campaign.created", "campaign", c.id)
    db.commit()
    return c


@router.get("", response_model=list[CampaignOut])
def list_campaigns(p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    return list(db.scalars(select(Campaign).order_by(Campaign.created_at.desc(), Campaign.id)))


@router.get("/{campaign_id}", response_model=CampaignOut)
def get_campaign(campaign_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    return _get(db, campaign_id)


@router.patch("/{campaign_id}", response_model=CampaignOut)
def update_campaign(campaign_id: uuid.UUID, body: CampaignUpdate, p: Principal = Depends(require_roles(*ADMIN)),
                    db: Session = Depends(get_db)):
    c = _get(db, campaign_id)
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        if v is None and k in ("name", "channel", "status", "budget_minor"):
            raise HTTPException(422, f"{k} cannot be cleared")
        setattr(c, k, v)
    if c.starts_on and c.ends_on and c.ends_on < c.starts_on:
        raise HTTPException(422, "ends_on is before starts_on")
    audit.record(db, p.user_id, "campaign.updated", "campaign", c.id, {"fields": sorted(data)})
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A campaign with this name already exists")
    return c


@router.get("/{campaign_id}/stats")
def campaign_stats(campaign_id: uuid.UUID, p: Principal = Depends(require_roles(*SALES)), db: Session = Depends(get_db)):
    """All integers: conversion in basis points, cost per lead in minor units (floor)."""
    c = _get(db, campaign_id)
    by_stage = {s.value: 0 for s in LeadStage}
    for stage, n in db.execute(select(Lead.stage, func.count()).where(Lead.campaign_id == c.id).group_by(Lead.stage)):
        by_stage[stage.value] = n
    total, won = sum(by_stage.values()), by_stage["won"]
    referred = db.scalar(select(func.count()).select_from(ReferralAttribution)
                         .join(ReferralCode, ReferralCode.id == ReferralAttribution.referral_code_id)
                         .where(ReferralCode.campaign_id == c.id)) or 0
    return {"campaign_id": c.id, "leads": total, "by_stage": by_stage, "won": won,
            "conversion_bps": (won * 10000 // total) if total else 0,
            "cost_per_lead_minor": (c.budget_minor // total) if total else None,
            "referral_attributions": referred, "currency": c.currency}
