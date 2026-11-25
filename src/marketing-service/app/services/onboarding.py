import json
import uuid

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import utcnow
from app.models import (AppSource, AppStatus, ChecklistItem, ChecklistKey, ChecklistStatus, EntryStatus, Lead,
                        LeadStage, OnboardingApplication, ReferralCode, platform_business_types)
from app.schemas import checklist as cl
from app.services import audit, commission
from app.services.provisioning import (ProvisioningClient, ProvisioningError, ProvisioningRequest,
                                       ProvisioningUnavailable)

LOCKED = (AppStatus.provisioned, AppStatus.cancelled)


def items_of(db: Session, app_id: uuid.UUID) -> list[ChecklistItem]:
    order = {k: i for i, k in enumerate(ChecklistKey)}
    return sorted(db.scalars(select(ChecklistItem).where(ChecklistItem.application_id == app_id)), key=lambda i: order[i.key])


def create_checklist(db: Session, app: OnboardingApplication) -> None:
    for k in ChecklistKey:
        db.add(ChecklistItem(application_id=app.id, key=k, status=ChecklistStatus.pending, data={}))
    db.flush()


def readiness(db: Session, app: OnboardingApplication) -> dict:
    items = items_of(db, app.id)
    blockers = [f"checklist item '{i.key.value}' is {i.status.value}" for i in items if i.status != ChecklistStatus.done]
    if not app.owner_name or not app.owner_email:
        blockers.append("owner name and owner email are required")
    return {"ready": not blockers, "blockers": blockers,
            "items": [{"key": i.key.value, "status": i.status.value} for i in items]}


def refresh_status(db: Session, app: OnboardingApplication) -> None:
    """draft/in_progress/ready follow the checklist; terminal states never move."""
    if app.status in LOCKED:
        return
    items = items_of(db, app.id)
    if readiness(db, app)["ready"]:
        app.status = AppStatus.ready
    elif any(i.status != ChecklistStatus.pending for i in items):
        app.status = AppStatus.in_progress
    else:
        app.status = AppStatus.draft


def set_item(db: Session, app: OnboardingApplication, key: ChecklistKey, payload: dict, actor_id) -> ChecklistItem:
    if app.status in LOCKED:
        raise HTTPException(409, f"Application is {app.status.value}; checklist is locked")
    try:
        parsed = cl.MODELS[key.value].model_validate(payload)
    except ValidationError as e:
        raise HTTPException(422, json.loads(e.json(include_url=False, include_context=False, include_input=False)))
    item = db.scalar(select(ChecklistItem).where(ChecklistItem.application_id == app.id, ChecklistItem.key == key))
    item.data = parsed.model_dump(mode="json")
    item.status = ChecklistStatus.done if cl.is_complete(key.value, parsed) else ChecklistStatus.in_progress
    item.updated_by = actor_id
    if key == ChecklistKey.business_type:  # the checklist kinds decide the platform selection sent to platform-core
        new_types = platform_business_types([parsed.business_type, *(parsed.business_types or [])])
        if new_types != list(app.business_types or []):
            audit.record(db, actor_id, "onboarding.business_types_changed", "onboarding_application", app.id,
                         {"from": list(app.business_types or []), "to": new_types})
            app.business_types = new_types
    db.flush()
    refresh_status(db, app)
    audit.record(db, actor_id, "onboarding.checklist_updated", "onboarding_application", app.id,
                 {"key": key.value, "status": item.status.value})
    return item


def _build_request(db: Session, app: OnboardingApplication) -> ProvisioningRequest:
    data = {i.key.value: i.data for i in items_of(db, app.id)}
    ref = db.get(ReferralCode, app.referral_code_id) if app.referral_code_id else None
    return ProvisioningRequest(
        idempotency_key=str(app.id), source=app.source.value, business_name=app.business_name,
        business_types=list(app.business_types), owner_name=app.owner_name, owner_email=app.owner_email,
        owner_phone=app.owner_phone, outlet=data["outlet"], menu_source=data["menu"].get("source"),
        referral_code=ref.code if ref else None,
        marketing_ref={"application_id": str(app.id), "lead_id": str(app.lead_id) if app.lead_id else None,
                       "agent_id": str(app.agent_id) if app.agent_id else None})


def provision(db: Session, app: OnboardingApplication, client: ProvisioningClient, actor_id) -> OnboardingApplication:
    """THE shared provisioning workflow. Assisted onboarding and self-signup both end here; nothing else may create
    a business. Idempotent: a provisioned application is returned unchanged."""
    if app.status == AppStatus.provisioned:
        return app
    if app.status == AppStatus.cancelled:
        raise HTTPException(409, "Application is cancelled")
    if not readiness(db, app)["ready"]:
        raise HTTPException(409, {"message": "Application is not ready for activation",
                                  "blockers": readiness(db, app)["blockers"]})
    try:
        result = client.provision(_build_request(db, app))
    except ProvisioningUnavailable as e:
        app.provisioning_error = str(e)[:500]
        audit.record(db, actor_id, "onboarding.provision_failed", "onboarding_application", app.id, {"retryable": True})
        db.commit()
        raise HTTPException(503, "Provisioning service unavailable; try again later")
    except ProvisioningError as e:
        app.provisioning_error = str(e)[:500]
        audit.record(db, actor_id, "onboarding.provision_failed", "onboarding_application", app.id, {"retryable": False})
        db.commit()
        raise HTTPException(502, f"Provisioning rejected: {e}")
    app.status = AppStatus.provisioned
    app.external_business_id = result.business_id
    app.platform_status = result.status
    app.provisioned_at = utcnow()
    app.provisioning_error = None
    if app.lead_id:
        lead = db.get(Lead, app.lead_id)
        if lead and lead.stage != LeadStage.won:
            audit.record(db, actor_id, "lead.stage_changed", "lead", lead.id, {"from": lead.stage.value, "to": "won"})
            lead.stage, lead.lost_reason = LeadStage.won, None
    audit.record(db, actor_id, "onboarding.provisioned", "onboarding_application", app.id,
                 {"business_id": result.business_id})
    commission.generate_for_activation(db, app, utcnow().date())
    return app
