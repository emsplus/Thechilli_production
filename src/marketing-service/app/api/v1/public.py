"""Unauthenticated endpoints for the public sign-up site. Responses are deliberately uniform for every failure
(no probing which tokens or codes exist) and the lead form is rate limited per client IP."""
import threading
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.security import hash_token, utcnow
from app.models import AppSource, Lead, OnboardingApplication, ReferralCode, SignupInvitation, lead_business_types
from app.schemas.api import PublicLeadIn, RedeemIn, TokenIn
from app.services import audit, leads as lead_svc, onboarding as onb, referrals
from app.services.normalize import normalize_email, normalize_phone

router = APIRouter(prefix="/public", tags=["public"])


class RateLimiter:
    def __init__(self, limit: int, window: float = 60.0):
        self.limit, self.window, self._hits, self._lock = limit, window, defaultdict(deque), threading.Lock()

    def check(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                raise HTTPException(429, "Too many requests")
            q.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter(20)


def _limit(request: Request) -> None:
    limiter.check(request.client.host if request.client else "unknown")


@router.post("/invitations/validate", dependencies=[Depends(_limit)])
def validate_invitation(body: TokenIn, db: Session = Depends(get_db)):
    inv = db.scalar(select(SignupInvitation).where(SignupInvitation.token_hash == hash_token(body.token)))
    if not inv or inv.used_at or inv.revoked_at or inv.expires_at <= utcnow():
        return {"valid": False}
    return {"valid": True, "expires_at": inv.expires_at}


@router.post("/invitations/redeem", status_code=201, dependencies=[Depends(_limit)])
def redeem_invitation(body: RedeemIn, db: Session = Depends(get_db)):
    """Single-use: the token is consumed by one conditional UPDATE, so two concurrent redemptions cannot both win.
    Creates (or attaches to) the onboarding application; provisioning itself still goes through the shared workflow."""
    if body.owner_phone:
        normalize_phone(body.owner_phone)
    now = utcnow()
    inv_id = db.scalar(update(SignupInvitation)
                       .where(SignupInvitation.token_hash == hash_token(body.token), SignupInvitation.used_at.is_(None),
                              SignupInvitation.revoked_at.is_(None), SignupInvitation.expires_at > now)
                       .values(used_at=now).returning(SignupInvitation.id))
    if inv_id is None:
        db.rollback()
        raise HTTPException(410, "This invitation is invalid, already used or expired")
    inv = db.get(SignupInvitation, inv_id)
    if inv.application_id:
        app = db.get(OnboardingApplication, inv.application_id)
        if app.status in onb.LOCKED:
            db.rollback()
            raise HTTPException(410, "This invitation is invalid, already used or expired")
        app.owner_name, app.owner_email = body.owner_name, inv.email
        app.owner_phone = body.owner_phone or app.owner_phone
        if "business_types" in body.model_fields_set:
            app.business_types = body.business_types
        onb.refresh_status(db, app)
    else:
        lead = db.get(Lead, inv.lead_id) if inv.lead_id else None
        btypes = body.business_types
        if "business_types" not in body.model_fields_set and lead:
            btypes = lead_business_types(lead)
        app = OnboardingApplication(lead_id=inv.lead_id, source=AppSource.self_signup, business_name=body.business_name,
                                    business_types=btypes,
                                    owner_name=body.owner_name, owner_email=inv.email, owner_phone=body.owner_phone,
                                    invitation_id=inv.id, currency=settings.default_currency,
                                    agent_id=None, created_by=None,
                                    referral_code_id=None)
        db.add(app)
        db.flush()
        onb.create_checklist(db, app)
        rc_id = inv.referral_code_id or (lead.referral_code_id if lead else None)
        if rc_id:
            referrals.attribute_application(db, app, db.get(ReferralCode, rc_id))
    audit.record(db, None, "invitation.redeemed", "signup_invitation", inv.id, {"application_id": str(app.id)})
    db.commit()
    return {"application_id": app.id, "status": app.status.value}


@router.get("/referral-codes/{code}", dependencies=[Depends(_limit)])
def check_referral_code(code: str, db: Session = Depends(get_db)):
    referrals.usable_code(db, code)
    return {"valid": True}


@router.post("/leads", status_code=202, dependencies=[Depends(_limit)])
def capture_lead(body: PublicLeadIn, db: Session = Depends(get_db)):
    """Website lead form. Always answers 202, whether or not the lead already existed (no enumeration)."""
    phone_n, email_n = normalize_phone(body.phone), normalize_email(body.email)
    rc = referrals.usable_code(db, body.referral_code) if body.referral_code else None
    if not lead_svc.find_duplicates(db, phone_n, email_n):
        lead = Lead(business_name=body.business_name, contact_name=body.contact_name, phone=body.phone,
                    email=body.email, phone_norm=phone_n, email_norm=email_n, city=body.city,
                    business_types=body.business_types, source="web_form")
        db.add(lead)
        db.flush()
        if rc:
            referrals.attribute_lead(db, lead, rc)
        audit.record(db, None, "lead.created", "lead", lead.id, {"source": "web_form"})
        db.commit()
    return {"received": True}
