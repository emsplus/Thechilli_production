import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import current_principal, P, Principal, require_perm
from app.core.db import get_db
from app.schemas.common import OutletIn, OutletOut, OutletPatch
from app.services import outlets

router = APIRouter(prefix="/outlets", tags=["outlets"])


@router.get("", response_model=list[OutletOut])
def list_outlets(include_inactive: bool = True, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """The tenant's outlets, default first. Every signed-in user may read them."""
    return outlets.list_outlets(db, p.restaurant_id, include_inactive)


@router.get("/{outlet_id}", response_model=OutletOut)
def get_outlet(outlet_id: uuid.UUID, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    o = outlets.get(db, p.restaurant_id, outlet_id)
    if p.outlet_ids is not None and o.id not in p.outlet_ids:  # like every other id of an outlet the user has no access to: it does not exist for them
        raise HTTPException(404, "Outlet not found")
    return o


@router.post("", response_model=OutletOut, status_code=201)
def create_outlet(data: OutletIn, p: Principal = Depends(require_perm(P.OUTLETS_MANAGE)), db: Session = Depends(get_db)):
    """Owner / manager. 409 when the code or invoice prefix is already used. Inherits country, currency and tax settings."""
    return outlets.create(db, p, data)


@router.patch("/{outlet_id}", response_model=OutletOut)
def update_outlet(outlet_id: uuid.UUID, data: OutletPatch, p: Principal = Depends(require_perm(P.OUTLETS_MANAGE)),
                  db: Session = Depends(get_db)):
    """Owner / manager. Name, address, phone, tax number, timezone, is_active. The default outlet cannot be deactivated."""
    return outlets.update(db, p, outlet_id, data)


@router.delete("/{outlet_id}", response_model=OutletOut)
def deactivate_outlet(outlet_id: uuid.UUID, p: Principal = Depends(require_perm(P.OUTLETS_MANAGE)), db: Session = Depends(get_db)):
    """Soft delete: deactivates the outlet (rows and numbering are kept). The default outlet cannot be deactivated."""
    return outlets.update(db, p, outlet_id, OutletPatch(is_active=False))
