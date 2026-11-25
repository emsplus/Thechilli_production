import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import access
from app.api.deps import ADMIN, ANY_ROLE, ONBOARDING, Principal, require_roles
from app.core.config import settings
from app.core.db import get_db
from app.models import (AppSource, AppStatus, ApplicationDocument, ChecklistKey, DocStatus, Lead, LeadStage,
                        OnboardingApplication, Role, lead_business_types)
from app.core.security import utcnow
from app.schemas.api import (ActivationOut, AppAssignIn, AppCreate, AppOut, AppUpdate, ChecklistOut, DocumentDecision,
                             DocumentOut)
from app.schemas.checklist import DocType
from app.services import documents as docs
from app.services import audit, onboarding as svc, provisioning

router = APIRouter(prefix="/onboarding/applications", tags=["onboarding"])


@router.post("", response_model=AppOut, status_code=201)
def create_application(body: AppCreate, p: Principal = Depends(require_roles(*ONBOARDING)), db: Session = Depends(get_db)):
    if body.contract_value_minor and not p.is_admin:
        raise HTTPException(403, "Only an admin can set the contract value (it is the commission base)")
    if body.agent_id and not p.is_admin and body.agent_id != p.user_id:
        raise HTTPException(403, "Only an admin can assign an application to someone else")
    lead = None
    if body.lead_id:
        lead = db.get(Lead, body.lead_id)
        if not lead:
            raise HTTPException(404, "Lead not found")
        if lead.stage == LeadStage.lost:
            raise HTTPException(409, "Cannot onboard a lost lead")
        if db.scalar(select(OnboardingApplication.id).where(OnboardingApplication.lead_id == lead.id,
                                                            OnboardingApplication.status != AppStatus.cancelled)):
            raise HTTPException(409, "This lead already has an onboarding application")
    agent_id = body.agent_id or (p.user_id if p.role == Role.onboarding_agent else None)
    if agent_id:
        access.active_user(db, agent_id, Role.onboarding_agent, Role.marketing_admin)
    btypes = body.business_types
    if "business_types" not in body.model_fields_set and lead:
        btypes = lead_business_types(lead)
    app = OnboardingApplication(
        lead_id=lead.id if lead else None, agent_id=agent_id, source=AppSource.assisted,
        business_name=body.business_name or lead.business_name, business_types=btypes,
        owner_name=body.owner_name or (lead.contact_name if lead else None),
        owner_email=body.owner_email or (lead.email if lead else None),
        owner_phone=body.owner_phone or (lead.phone if lead else None),
        referral_code_id=lead.referral_code_id if lead else None,
        contract_value_minor=body.contract_value_minor, currency=(body.currency or settings.default_currency).upper(),
        created_by=p.user_id)
    db.add(app)
    db.flush()
    svc.create_checklist(db, app)
    audit.record(db, p.user_id, "onboarding.created", "onboarding_application", app.id,
                 {"lead_id": str(lead.id) if lead else None, "source": "assisted", "business_types": btypes})
    db.commit()
    return app


@router.get("", response_model=list[AppOut])
def list_applications(status: AppStatus | None = None, agent_id: uuid.UUID | None = None,
                      limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                      p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    q = select(OnboardingApplication).where(access.app_filter(p)).order_by(OnboardingApplication.created_at.desc(),
                                                                          OnboardingApplication.id)
    if status:
        q = q.where(OnboardingApplication.status == status)
    if agent_id:
        q = q.where(OnboardingApplication.agent_id == agent_id)
    return list(db.scalars(q.limit(limit).offset(offset)))


@router.get("/{app_id}", response_model=AppOut)
def get_application(app_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    return access.get_app(db, p, app_id)


@router.patch("/{app_id}", response_model=AppOut)
def update_application(app_id: uuid.UUID, body: AppUpdate, p: Principal = Depends(require_roles(*ONBOARDING)),
                       db: Session = Depends(get_db)):
    app = access.get_app(db, p, app_id)
    data = body.model_dump(exclude_unset=True)
    if "contract_value_minor" in data and not p.is_admin:
        raise HTTPException(403, "Only an admin can set the contract value (it is the commission base)")
    if app.status in svc.LOCKED:
        raise HTTPException(409, f"Application is {app.status.value} and can no longer be edited")
    for k, v in data.items():
        if v is None and k in ("business_name", "business_types", "contract_value_minor"):
            raise HTTPException(422, f"{k} cannot be cleared")
        setattr(app, k, v)
    svc.refresh_status(db, app)
    audit.record(db, p.user_id, "onboarding.updated", "onboarding_application", app.id, {"fields": sorted(data)})
    db.commit()
    return app


@router.post("/{app_id}/assign", response_model=AppOut)
def assign_application(app_id: uuid.UUID, body: AppAssignIn, p: Principal = Depends(require_roles(*ADMIN)),
                       db: Session = Depends(get_db)):
    app = access.get_app(db, p, app_id)
    if app.status == AppStatus.provisioned:
        raise HTTPException(409, "Application is already provisioned")
    if body.agent_id:
        access.active_user(db, body.agent_id, Role.onboarding_agent)
    audit.record(db, p.user_id, "onboarding.assigned", "onboarding_application", app.id,
                 {"from": str(app.agent_id) if app.agent_id else None, "to": str(body.agent_id) if body.agent_id else None})
    app.agent_id = body.agent_id
    db.commit()
    return app


@router.get("/{app_id}/checklist", response_model=list[ChecklistOut])
def get_checklist(app_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    return svc.items_of(db, access.get_app(db, p, app_id).id)


@router.put("/{app_id}/checklist/{key}", response_model=ChecklistOut)
def put_checklist_item(app_id: uuid.UUID, key: ChecklistKey, payload: dict, p: Principal = Depends(require_roles(*ONBOARDING)),
                       db: Session = Depends(get_db)):
    app = access.get_app(db, p, app_id)
    item = svc.set_item(db, app, key, payload, p.user_id)
    db.commit()
    return item


@router.get("/{app_id}/readiness")
def get_readiness(app_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    """Activation readiness: derived from the checklist, never set by hand."""
    app = access.get_app(db, p, app_id)
    return {"status": app.status.value, **svc.readiness(db, app)}


@router.post("/{app_id}/provision", response_model=AppOut)
def provision_application(app_id: uuid.UUID, p: Principal = Depends(require_roles(*ONBOARDING)),
                          db: Session = Depends(get_db),
                          client: provisioning.ProvisioningClient = Depends(provisioning.get_provisioning_client)):
    app = access.get_app(db, p, app_id)
    svc.provision(db, app, client, p.user_id)
    db.commit()
    return app


@router.post("/{app_id}/cancel", response_model=AppOut)
def cancel_application(app_id: uuid.UUID, p: Principal = Depends(require_roles(*ONBOARDING)), db: Session = Depends(get_db)):
    app = access.get_app(db, p, app_id)
    if app.status in svc.LOCKED:
        raise HTTPException(409, f"Application is already {app.status.value}")
    app.status = AppStatus.cancelled
    audit.record(db, p.user_id, "onboarding.cancelled", "onboarding_application", app.id)
    db.commit()
    return app


# ---- activation / payment status (mirrored from platform-core)
def _activation(app: OnboardingApplication) -> ActivationOut:
    ok = app.platform_status == "provisioned" and app.billing_status in ("trialing", "active")
    return ActivationOut(application_id=app.id, status=app.status, external_business_id=app.external_business_id,
                         platform_status=app.platform_status, billing_status=app.billing_status, activated=ok,
                         paying=ok and app.billing_status == "active", status_checked_at=app.status_checked_at)


@router.get("/{app_id}/activation", response_model=ActivationOut)
def get_activation(app_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    """Last known activation and subscription state (no outbound call). POST .../activation/refresh updates it."""
    return _activation(access.get_app(db, p, app_id))


@router.post("/{app_id}/activation/refresh", response_model=ActivationOut)
def refresh_activation(app_id: uuid.UUID, p: Principal = Depends(require_roles(*ONBOARDING)), db: Session = Depends(get_db),
                       client: provisioning.ProvisioningClient = Depends(provisioning.get_provisioning_client)):
    app = access.get_app(db, p, app_id)
    if not app.external_business_id:
        raise HTTPException(409, "Application has not been submitted to the platform yet")
    try:
        st = client.fetch_status(app.external_business_id)
    except provisioning.ProvisioningUnavailable as e:
        raise HTTPException(503, f"Platform status unavailable: {e}")
    except provisioning.ProvisioningError as e:
        raise HTTPException(502, f"Platform status refused: {e}")
    changed = (app.platform_status, app.billing_status) != (st.activation, st.billing)
    app.platform_status, app.billing_status, app.status_checked_at = st.activation, st.billing, utcnow()
    if changed:
        audit.record(db, p.user_id, "onboarding.activation_synced", "onboarding_application", app.id,
                     {"platform_status": st.activation, "billing_status": st.billing})
    db.commit()
    return _activation(app)


# ---- documents
def _sync_documents_item(db: Session, app: OnboardingApplication, actor_id) -> None:
    """The checklist `documents` item is derived from uploaded files: newest per type, reference = document id."""
    latest: dict[str, ApplicationDocument] = {}
    rows = db.scalars(select(ApplicationDocument).where(ApplicationDocument.application_id == app.id)
                      .order_by(ApplicationDocument.created_at))
    for d in rows:
        latest[d.doc_type] = d
    svc.set_item(db, app, ChecklistKey.documents,
                 {"documents": [{"type": t, "status": d.status.value, "reference": str(d.id)} for t, d in latest.items()]},
                 actor_id)


@router.post("/{app_id}/documents", response_model=DocumentOut, status_code=201)
async def upload_document(app_id: uuid.UUID, request: Request, type: DocType, filename: str = Query(max_length=200),
                          p: Principal = Depends(require_roles(*ONBOARDING)), db: Session = Depends(get_db),
                          store: docs.DocumentStore = Depends(docs.get_document_store)):
    """Raw-body upload (Content-Type = the file's type, `filename` and `type` as query parameters)."""
    app = access.get_app(db, p, app_id)
    if app.status in svc.LOCKED:
        raise HTTPException(409, f"Application is {app.status.value}; documents are locked")
    buf = bytearray()
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > settings.document_max_bytes:
            raise HTTPException(413, f"File too large (max {settings.document_max_bytes // (1024 * 1024)} MB)")
    data = bytes(buf)
    name, ctype = docs.validate(filename, request.headers.get("content-type"), data)
    key = docs.new_key()
    store.put(key, data)
    try:
        doc = ApplicationDocument(application_id=app.id, doc_type=type.value, filename=name, content_type=ctype,
                                  size_bytes=len(data), sha256=docs.digest(data), storage_key=key, uploaded_by=p.user_id)
        db.add(doc)
        db.flush()
        audit.record(db, p.user_id, "document.uploaded", "onboarding_application", app.id,
                     {"document_id": str(doc.id), "type": type.value, "size": len(data)})
        _sync_documents_item(db, app, p.user_id)
        db.commit()
    except Exception:
        db.rollback()
        store.delete(key)
        raise
    return doc


def _doc(db: Session, p: Principal, app_id: uuid.UUID, doc_id: uuid.UUID) -> ApplicationDocument:
    app = access.get_app(db, p, app_id)
    d = db.get(ApplicationDocument, doc_id)
    if not d or d.application_id != app.id:
        raise HTTPException(404, "Document not found")
    return d


@router.get("/{app_id}/documents", response_model=list[DocumentOut])
def list_documents(app_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    app = access.get_app(db, p, app_id)
    return list(db.scalars(select(ApplicationDocument).where(ApplicationDocument.application_id == app.id)
                           .order_by(ApplicationDocument.created_at.desc())))


@router.get("/{app_id}/documents/{doc_id}/content")
def download_document(app_id: uuid.UUID, doc_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)),
                      db: Session = Depends(get_db), store: docs.DocumentStore = Depends(docs.get_document_store)):
    d = _doc(db, p, app_id, doc_id)
    try:
        data = store.get(d.storage_key)
    except (KeyError, FileNotFoundError):
        raise HTTPException(410, "Stored file is missing")
    return Response(data, media_type=d.content_type,
                    headers={"Content-Disposition": f'attachment; filename="{d.filename}"'})


@router.post("/{app_id}/documents/{doc_id}/decision", response_model=DocumentOut)
def decide_document(app_id: uuid.UUID, doc_id: uuid.UUID, body: DocumentDecision,
                    p: Principal = Depends(require_roles(*ADMIN)), db: Session = Depends(get_db)):
    """Verify or reject a document. Admin only: an agent cannot mark their own uploads as verified."""
    d = _doc(db, p, app_id, doc_id)
    app = db.get(OnboardingApplication, d.application_id)
    if app.status in svc.LOCKED:
        raise HTTPException(409, f"Application is {app.status.value}; documents are locked")
    d.status, d.decided_by = DocStatus(body.status), p.user_id
    audit.record(db, p.user_id, "document.decided", "onboarding_application", app.id,
                 {"document_id": str(d.id), "status": body.status})
    _sync_documents_item(db, app, p.user_id)
    db.commit()
    return d


@router.delete("/{app_id}/documents/{doc_id}", status_code=204)
def delete_document(app_id: uuid.UUID, doc_id: uuid.UUID, p: Principal = Depends(require_roles(*ONBOARDING)),
                    db: Session = Depends(get_db), store: docs.DocumentStore = Depends(docs.get_document_store)):
    d = _doc(db, p, app_id, doc_id)
    app = db.get(OnboardingApplication, d.application_id)
    if app.status in svc.LOCKED:
        raise HTTPException(409, f"Application is {app.status.value}; documents are locked")
    key = d.storage_key
    db.delete(d)
    db.flush()
    audit.record(db, p.user_id, "document.deleted", "onboarding_application", app.id, {"document_id": str(doc_id)})
    _sync_documents_item(db, app, p.user_id)
    db.commit()
    store.delete(key)
