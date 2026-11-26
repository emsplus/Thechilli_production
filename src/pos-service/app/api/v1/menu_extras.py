"""Modifier groups, combos and offers (docs/MODIFIERS_OFFERS.md). Reads are open to every signed-in user (the POS and the
waiter app need the definitions); writes need `menu.manage` (groups, combos) or `offers.manage` (offers)."""
import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, current_principal, require_perm
from app.core.db import get_db
from app.models.menu_extras import ModifierGroup, Offer
from app.schemas.menu_extras import (
    ActiveIn, ApplyGroupIn, ApplyGroupOut, ComboIn, ComboOut, ItemGroupsIn, ItemGroupsOut, ModifierGroupIn, ModifierGroupOut, OfferIn, OfferOut,
)
from app.services import feature_access
from app.services import modifiers as svc
from app.services import offers as offer_svc
from app.services import outlets

router = APIRouter(tags=["menu-extras"])


def _group_out(g: ModifierGroup, item_ids: list[uuid.UUID], include_inactive: bool = False) -> ModifierGroupOut:
    out = ModifierGroupOut.model_validate(g)
    out.options = [o for o in out.options if include_inactive or o.is_active]
    out.item_ids = item_ids
    return out


@router.get("/menu/modifier-groups", response_model=list[ModifierGroupOut])
def list_groups(include_inactive: bool = False, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Active groups with their active options and the items that offer them. `include_inactive` needs menu.manage."""
    inc = include_inactive and p.can(P.MENU_MANAGE)
    items = svc.group_item_ids(db, p.restaurant_id)
    return [_group_out(g, items.get(g.id, []), inc) for g in svc.list_groups(db, p, inc)]


@router.post("/menu/modifier-groups", response_model=ModifierGroupOut, status_code=201)
def create_group(data: ModifierGroupIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)), db: Session = Depends(get_db)):
    return _group_out(svc.create_group(db, p, data), [])


@router.put("/menu/modifier-groups/{group_id}", response_model=ModifierGroupOut)
def update_group(group_id: uuid.UUID, data: ModifierGroupIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)),
                 db: Session = Depends(get_db)):
    """Replaces the group: options matched by id, new ones without id, active options not listed are deactivated."""
    g = svc.update_group(db, p, group_id, data)
    return _group_out(g, svc.group_item_ids(db, p.restaurant_id).get(g.id, []))


@router.patch("/menu/modifier-groups/{group_id}/active", response_model=ModifierGroupOut)
def set_group_active(group_id: uuid.UUID, data: ActiveIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)),
                     db: Session = Depends(get_db)):
    """A deactivated group disappears from every item (its links stay, so reactivating restores it)."""
    g = svc.set_group_active(db, p, group_id, data.is_active)
    return _group_out(g, svc.group_item_ids(db, p.restaurant_id).get(g.id, []))


@router.post("/menu/modifier-groups/{group_id}/apply", response_model=ApplyGroupOut)
def apply_group(group_id: uuid.UUID, data: ApplyGroupIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)),
                db: Session = Depends(get_db)):
    """Attach (or detach) the group to every dish, or to every dish of the given categories, in one step (e.g. an "Add on" group on a
    whole menu). Idempotent; an item's other groups and their order are untouched."""
    return ApplyGroupOut(**svc.apply_group(db, p, group_id, attach=data.mode == "attach", all_items=data.all_items,
                                           category_ids=data.category_ids))


@router.put("/menu/items/{item_id}/modifier-groups", response_model=ItemGroupsOut)
def set_item_groups(item_id: uuid.UUID, data: ItemGroupsIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)),
                    db: Session = Depends(get_db)):
    return ItemGroupsOut(item_id=item_id, group_ids=svc.set_item_groups(db, p, item_id, data.group_ids))


@router.get("/menu/combos", response_model=list[ComboOut])
def list_combos(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return svc.list_combos(db, p)


@router.put("/menu/items/{item_id}/combo", response_model=ComboOut)
def set_combo(item_id: uuid.UUID, data: ComboIn, p: Principal = Depends(require_perm(P.MENU_MANAGE)),
              db: Session = Depends(get_db)):
    """Makes the item a combo of these components (its own price is the bundle price). `components: []` = plain item."""
    svc.set_combo(db, p, item_id, data.components)
    found = next((c for c in svc.list_combos(db, p) if c["item_id"] == item_id), None)
    if found is None:
        from app.models.core import MenuItem
        item = db.get(MenuItem, item_id)
        found = {"item_id": item.id, "name": item.name, "price": item.price, "is_active": item.is_active, "components": []}
    return found


def _offer_out(o: Offer) -> OfferOut:
    out = OfferOut.model_validate(o)
    out.label = offer_svc.label_of(o.name)
    return out


@router.get("/offers", response_model=list[OfferOut])
def list_offers(include_inactive: bool = False, p: Principal = Depends(require_perm(P.OFFERS_MANAGE)),
                db: Session = Depends(get_db)):
    return [_offer_out(o) for o in offer_svc.list_offers(db, p, include_inactive)]


@router.get("/offers/active", response_model=list[OfferOut])
def active_offers(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Offers running right now at the request's outlet (X-Outlet-Id), for a hint on the order screen. The bill applies them by itself."""
    if not feature_access.allowed(db, p.restaurant_id, "billing.offers"):  # Manage > Features: Automatic offers is off, the bill applies none
        return []
    return [_offer_out(o) for o in offer_svc.active_now(db, p, outlets.outlet_of(db, p))]


@router.post("/offers", response_model=OfferOut, status_code=201)
def create_offer(data: OfferIn, p: Principal = Depends(require_perm(P.OFFERS_MANAGE)), db: Session = Depends(get_db)):
    return _offer_out(offer_svc.create(db, p, data))


@router.put("/offers/{offer_id}", response_model=OfferOut)
def update_offer(offer_id: uuid.UUID, data: OfferIn, p: Principal = Depends(require_perm(P.OFFERS_MANAGE)),
                 db: Session = Depends(get_db)):
    return _offer_out(offer_svc.update(db, p, offer_id, data))


@router.patch("/offers/{offer_id}/active", response_model=OfferOut)
def set_offer_active(offer_id: uuid.UUID, data: ActiveIn, p: Principal = Depends(require_perm(P.OFFERS_MANAGE)),
                     db: Session = Depends(get_db)):
    return _offer_out(offer_svc.set_active(db, p, offer_id, data.is_active))
