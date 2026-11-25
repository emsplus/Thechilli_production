"""Supplier re-order emails: settings, a preview + manual send, the history list and "Resend" for failed ones.
Owner / manager only. Sending happens in a background task; the row is written first so the history always shows it."""
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import require_feature, P, Principal, require_perm
from app.core.db import get_db
from app.models.core import Restaurant, Supplier, SupplierEmail
from app.schemas.reorder import (
    EmailSettingsIn, EmailSettingsOut, ReorderEmailIn, ReorderPreviewOut, SupplierEmailOut,
)
from app.services import audit, manage, reorder

router = APIRouter(tags=["reorder"], dependencies=[Depends(require_feature("inventory"))])


def _settings_out(r: Restaurant) -> EmailSettingsOut:
    return EmailSettingsOut(configured=reorder.configured(), auto_enabled=r.auto_reorder_emails,
                            window_hours=r.reorder_email_window_hours)


def _out(rows: list[SupplierEmail], db: Session) -> list[SupplierEmailOut]:
    names = {s.id: s.name for s in db.scalars(select(Supplier).where(Supplier.id.in_({r.supplier_id for r in rows})))} if rows else {}
    out = []
    for r in rows:
        o = SupplierEmailOut.model_validate(r)
        o.supplier_name = names.get(r.supplier_id)
        out.append(o)
    return out


def _supplier(db: Session, p: Principal, supplier_id: uuid.UUID) -> Supplier:
    s = db.get(Supplier, supplier_id)
    if not s or s.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Supplier not found")
    return s


@router.get("/email/settings", response_model=EmailSettingsOut)
def get_email_settings(p: Principal = Depends(require_perm(P.SETTINGS_MANAGE)), db: Session = Depends(get_db)):
    return _settings_out(db.get(Restaurant, p.restaurant_id))


@router.put("/email/settings", response_model=EmailSettingsOut)
def put_email_settings(data: EmailSettingsIn, p: Principal = Depends(require_perm(P.SETTINGS_MANAGE)), db: Session = Depends(get_db)):
    r = db.get(Restaurant, p.restaurant_id, with_for_update=True)
    changes = {k: getattr(data, k) for k in data.model_fields_set if getattr(data, k) is not None}
    diff = {}
    for k, new in changes.items():
        if getattr(r, k) != new:
            diff[k] = {"old": getattr(r, k), "new": new}
            setattr(r, k, new)
    if diff:
        audit.record(db, p, "restaurant.email_settings", "restaurant", r.id, diff)
    db.commit()
    return _settings_out(r)


@router.post("/suppliers/{supplier_id}/emails/preview", response_model=ReorderPreviewOut)
def preview_email(supplier_id: uuid.UUID, data: ReorderEmailIn, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)),
                  db: Session = Depends(get_db)):
    """What the email would say (recipient, subject, text) for these items and quantities; sends nothing."""
    return reorder.draft(db, p, _supplier(db, p, supplier_id), data.items, data.note)


@router.post("/suppliers/{supplier_id}/emails", response_model=SupplierEmailOut, status_code=202)
def send_email(supplier_id: uuid.UUID, data: ReorderEmailIn, background: BackgroundTasks,
               p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    """Queues a manual re-order email (logged as `manual`) and sends it in the background; poll the history for the outcome."""
    row = reorder.queue_manual(db, p, _supplier(db, p, supplier_id), data.items, data.note)
    background.add_task(reorder.deliver, p.restaurant_id, row.id)
    return _out([row], db)[0]


@router.get("/supplier-emails", response_model=list[SupplierEmailOut])
def list_emails(supplier_id: uuid.UUID | None = None, limit: int = Query(50, ge=1, le=200),
                p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    q = select(SupplierEmail).where(SupplierEmail.restaurant_id == p.restaurant_id)
    if supplier_id:
        q = q.where(SupplierEmail.supplier_id == supplier_id)
    return _out(list(db.scalars(q.order_by(SupplierEmail.created_at.desc(), SupplierEmail.id).limit(limit))), db)


@router.post("/supplier-emails/{email_id}/resend", response_model=SupplierEmailOut, status_code=202)
def resend_email(email_id: uuid.UUID, background: BackgroundTasks, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)),
                 db: Session = Depends(get_db)):
    row = reorder.requeue(db, p, email_id)
    background.add_task(reorder.deliver, p.restaurant_id, row.id)
    return _out([row], db)[0]
