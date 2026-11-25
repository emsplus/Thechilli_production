import secrets

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.security import utcnow
from app.models import Lead, OnboardingApplication, ReferralAttribution, ReferralCode, Role, MarketingUser

ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I/L


def generate_code(db: Session) -> str:
    for _ in range(20):
        code = "".join(secrets.choice(ALPHABET) for _ in range(8))
        if not db.scalar(select(ReferralCode.id).where(ReferralCode.code == code)):
            return code
    raise RuntimeError("could not generate a unique referral code")


def uses(db: Session, rc: ReferralCode) -> int:
    return db.scalar(select(func.count()).select_from(ReferralAttribution)
                     .where(ReferralAttribution.referral_code_id == rc.id)) or 0


def usable_code(db: Session, code: str) -> ReferralCode:
    """Resolve an entered code; 404 (not 422) for anything unusable so callers cannot probe why."""
    rc = db.scalar(select(ReferralCode).where(ReferralCode.code == code.strip().upper()))
    owner = db.get(MarketingUser, rc.owner_id) if rc else None
    if (not rc or not rc.is_active or not owner or not owner.is_active
            or (rc.expires_at and rc.expires_at <= utcnow())
            or (rc.max_uses is not None and uses(db, rc) >= rc.max_uses)):
        raise HTTPException(404, "Referral code not found or no longer valid")
    return rc


def attribute_lead(db: Session, lead: Lead, rc: ReferralCode) -> None:
    db.add(ReferralAttribution(referral_code_id=rc.id, lead_id=lead.id))
    lead.referral_code_id = rc.id
    if rc.campaign_id and not lead.campaign_id:
        lead.campaign_id = rc.campaign_id
    owner = db.get(MarketingUser, rc.owner_id)
    if lead.owner_id is None and owner.role == Role.salesperson:
        lead.owner_id = owner.id  # the referrer's salesperson works their own referral


def attribute_application(db: Session, app: OnboardingApplication, rc: ReferralCode) -> None:
    if db.scalar(select(ReferralAttribution.id).where(ReferralAttribution.application_id == app.id)):
        return
    db.add(ReferralAttribution(referral_code_id=rc.id, application_id=app.id))
    app.referral_code_id = rc.id
