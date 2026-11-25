"""Row-level visibility. Admin sees everything; a salesperson sees leads they own or created; an onboarding agent sees
applications assigned to them and the leads those applications came from."""
import uuid

from fastapi import HTTPException
from sqlalchemy import exists, or_, select
from sqlalchemy.orm import Session

from app.api.deps import Principal
from app.models import Lead, MarketingUser, OnboardingApplication, Role


def lead_filter(p: Principal):
    if p.is_admin:
        return True
    if p.role == Role.salesperson:
        return or_(Lead.owner_id == p.user_id, Lead.created_by == p.user_id)
    return exists().where(OnboardingApplication.lead_id == Lead.id, OnboardingApplication.agent_id == p.user_id)


def app_filter(p: Principal):
    if p.is_admin:
        return True
    if p.role == Role.onboarding_agent:
        return OnboardingApplication.agent_id == p.user_id
    return exists().where(Lead.id == OnboardingApplication.lead_id, or_(Lead.owner_id == p.user_id, Lead.created_by == p.user_id))


def get_lead(db: Session, p: Principal, lead_id: uuid.UUID) -> Lead:
    lead = db.scalar(select(Lead).where(Lead.id == lead_id, lead_filter(p)))
    if not lead:
        raise HTTPException(404, "Lead not found")
    return lead


def get_app(db: Session, p: Principal, app_id: uuid.UUID) -> OnboardingApplication:
    app = db.scalar(select(OnboardingApplication).where(OnboardingApplication.id == app_id, app_filter(p)))
    if not app:
        raise HTTPException(404, "Application not found")
    return app


def active_user(db: Session, user_id: uuid.UUID, *roles: Role) -> MarketingUser:
    u = db.get(MarketingUser, user_id)
    if not u or not u.is_active or (roles and u.role not in roles):
        raise HTTPException(422, "Assignee must be an active user with a suitable role")
    return u
