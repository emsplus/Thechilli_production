from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import current_principal, P, Principal, require_perm
from app.core.db import get_db
from app.models.core import Restaurant
from app.schemas.common import BusinessTypesIn, FeatureAccessOut, FeaturesIn, RestaurantIn, RestaurantOut
from app.services import audit, business_type, entitlements, feature_access, gst, manage

router = APIRouter(tags=["restaurant"])


def restaurant_out(db: Session, p: Principal, r: Restaurant | None = None) -> RestaurantOut:
    out = RestaurantOut.model_validate(r or db.get(Restaurant, p.restaurant_id))
    out.business_types, out.capabilities = business_type.for_restaurant(db, p.restaurant_id, p.outlet_id)
    e = entitlements.current(p.restaurant_id)
    if e is not None:
        out.entitlement_warning = e.warning or ("suspended" if e.suspended else None)
    out.features = feature_access.effective(r or db.get(Restaurant, p.restaurant_id), e)
    return out


@router.get("/restaurant", response_model=RestaurantOut)
def get_restaurant(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """The caller's restaurant. Clients use `timezone` for restaurant-local dates (e.g. report "Today"), and
    `business_types` / `capabilities` to show only what the business runs (docs/BUSINESS_TYPES.md)."""
    return restaurant_out(db, p)


@router.get("/business-types", tags=["business-types"])
def business_types_catalogue() -> list[dict]:
    """Public (no login): the business types a sign-up wizard offers ('What do you run? (choose one or more)'), each with
    its label, description and the capabilities it gives on its own. A selection's capabilities are the union."""
    return business_type.catalogue()


@router.put("/restaurant/business-types", response_model=RestaurantOut)
def set_business_types(data: BusinessTypesIn, p: Principal = Depends(require_perm(P.SETTINGS_OWNER)),
                       db: Session = Depends(get_db)):
    """LOCKED (owner decision 2026-11-25): the business type (restaurant / cloud kitchen / hotel kitchen) is chosen when the business is
    created and afterwards changed ONLY by platform staff (super admin, PUT /internal/provision/tenants/{id}/business-types). A
    business can never switch its own mode, so even the owner gets 403 `business_type_locked` here. The route stays so old clients get
    a clear refusal instead of a 404."""
    raise entitlements.EntitlementError(403, "business_type_locked",
                                        "The business type can only be changed by Chilli Agent support. Please contact support.")


@router.get("/restaurant/features", response_model=list[FeatureAccessOut])
def get_features(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """What this restaurant may use and what its owner has switched on (Manage > Features). Per feature: `granted` (super admin
    allows it: plan or per-restaurant override), `switched_on` (the owner's switch) and `available` (both). Any signed-in user."""
    return feature_access.view(db.get(Restaurant, p.restaurant_id), entitlements.current(p.restaurant_id))


@router.put("/restaurant/features", response_model=list[FeatureAccessOut])
def set_features(data: FeaturesIn, p: Principal = Depends(require_perm(P.SETTINGS_OWNER)), db: Session = Depends(get_db)):
    """Owner only. `{"features": {code: true|false}}` switches granted features on or off. 403 `feature_not_entitled` when asked to
    switch on something super admin has not granted; 409 `at_least_one_order_type` when no order type would stay on; 422 for an
    unknown code. Audit-logged (restaurant.features)."""
    r = db.get(Restaurant, p.restaurant_id, with_for_update=True)
    feature_access.update(db, p, r, data.features)
    db.commit()
    return feature_access.view(r, entitlements.current(p.restaurant_id))


@router.put("/restaurant", response_model=RestaurantOut)
def update_restaurant(data: RestaurantIn, p: Principal = Depends(require_perm(P.SETTINGS_OWNER)),
                      db: Session = Depends(get_db)):
    """Owner only. Replaces name / GSTIN (`trn`) / address (GSTIN and address may be null; the GSTIN is validated) and
    optionally changes vat_registered (GST registered), service_charge_percent (0-30),
    max_cashier_discount_percent (0-100), prices_include_tax and kitchen_target_minutes (5-120, default 15: the lateness
    target the KDS / order list colours use; also in GET /auth/me) and kitchen_status_mode ("kot_only", the default, or
    "track"; docs/KOT_ONLY_KITCHEN.md; also in GET /auth/me order_rules). Invoices already issued keep the seller details and
    the tax mode they were finalized with. Every change is audited (restaurant.update, old/new per field)."""
    return restaurant_out(db, p, manage.update_restaurant(db, p, data))


class GstSettingsIn(BaseModel):
    tax_mode: str
    config: dict | None = None


@router.get("/restaurant/gst")
def get_gst_settings(p: Principal = Depends(require_perm(P.SETTINGS_OWNER)), db: Session = Depends(get_db)):
    """Owner only. GST engine mode and its explicit policy configuration, plus the internal 'pending CA verification'
    admin warning (never printed on customer documents)."""
    return gst.get_settings(db.get(Restaurant, p.restaurant_id))


@router.put("/restaurant/gst")
def set_gst_settings(data: GstSettingsIn, p: Principal = Depends(require_perm(P.SETTINGS_OWNER)),
                     db: Session = Depends(get_db)):
    """Owner only. `tax_mode` off | gst_engine; `config` is validated by the tax engine (state, GSTIN
    match, treatment, rates, SAC). Issued bills keep the mode they were finalized with."""
    r = db.get(Restaurant, p.restaurant_id, with_for_update=True)
    if data.tax_mode != "off" and not r.vat_registered:
        raise HTTPException(422, "GST is switched off for this business. Turn on GST registration first.")
    out = gst.set_settings(db, p, r, data.tax_mode, data.config)
    audit.record(db, p, "restaurant.gst_settings", "restaurant", r.id, {"tax_mode": r.tax_mode, "config": r.gst_config})
    db.commit()
    return out


@router.get("/manage/summary")
def manage_summary(p: Principal = Depends(require_perm(P.REPORTS_VIEW)), db: Session = Depends(get_db)) -> dict[str, int]:
    """Counts for the Manage overview cards (active rows only, except staff_inactive)."""
    return manage.summary(db, p)
