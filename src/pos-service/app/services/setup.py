"""First-run setup checklist (docs/RESERVATIONS_ATTENDANCE_SETUP_API.md).

Every step's completion is DERIVED from the data the rest of the app already keeps (restaurant, outlets, tables, menu,
printers, tax settings, users, UPI id / payment account); nothing here stores "done". The only stored choice is that the owner
skipped a step (setup_step_skips). A skipped step whose data later appears reports done."""
import re
from dataclasses import dataclass
from typing import Callable

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.core import (
    Category, DiningTable, MenuItem, Outlet, PaymentProviderAccount, PrintHub, Printer, Restaurant, TaxRate, User,
)
from app.models.frontdesk import SetupStepSkip
from app.schemas.frontdesk import SetupAction, SetupStatusOut, SetupStep
from app.services import audit, business_type

VPA = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,255}@[A-Za-z][A-Za-z0-9.-]{1,63}$")


def _business(db: Session, r: Restaurant) -> tuple[bool, dict]:
    missing = [f for f in ("name", "address", "phone") if not (getattr(r, f) or "").strip()]
    if r.vat_registered and not r.trn:
        missing.append("trn")
    return not missing, {"missing": missing, "tax_number_label": r.tax_number_label, "has_tax_number": bool(r.trn),
                         "gst_registered": r.vat_registered}


def _outlet(db: Session, r: Restaurant) -> tuple[bool, dict]:
    rows = db.scalars(select(Outlet).where(Outlet.restaurant_id == r.id, Outlet.is_active)
                      .order_by(Outlet.is_default.desc(), Outlet.created_at)).all()
    items = [{"id": str(o.id), "name": o.name, "is_default": o.is_default,
              "missing": [f for f in ("address", "phone") if not (getattr(o, f) or "").strip()]} for o in rows]
    return bool(items) and not any(i["missing"] for i in items), {"outlets": items}


def _tables(db: Session, r: Restaurant) -> tuple[bool, dict]:
    by_area = {a.value if hasattr(a, "value") else str(a): n for a, n in db.execute(
        select(DiningTable.area, func.count()).where(DiningTable.restaurant_id == r.id, DiningTable.is_active)
        .group_by(DiningTable.area)).all()}
    n = sum(by_area.values())
    return n > 0, {"tables": n, "by_area": by_area}


def _menu(db: Session, r: Restaurant) -> tuple[bool, dict]:
    cats = db.scalar(select(func.count()).select_from(Category).where(Category.restaurant_id == r.id, Category.is_active))
    items = db.scalar(select(func.count()).select_from(MenuItem).where(MenuItem.restaurant_id == r.id, MenuItem.is_active))
    return cats > 0 and items > 0, {"categories": cats, "items": items}


def _printer(db: Session, r: Restaurant) -> tuple[bool, dict]:
    printers = db.scalar(select(func.count()).select_from(Printer).where(Printer.restaurant_id == r.id, Printer.is_active))
    hubs = db.scalar(select(func.count()).select_from(PrintHub).where(PrintHub.restaurant_id == r.id, PrintHub.revoked_at.is_(None)))
    return printers > 0, {"printers": printers, "print_hubs": hubs}


def _tax(db: Session, r: Restaurant) -> tuple[bool, dict]:
    rates = db.scalar(select(func.count()).select_from(TaxRate).where(TaxRate.restaurant_id == r.id))
    if r.country == "IN":
        # India: the owner either switched the GST engine on or declared the restaurant not GST-registered. Keeping the
        # simple tax mode is a valid choice too: skip the step.
        done = r.tax_mode == "gst_engine" or not r.vat_registered
    else:
        done = rates > 0
    return done, {"country": r.country, "tax_mode": r.tax_mode, "gst_registered": r.vat_registered, "tax_rates": rates}


def _staff(db: Session, r: Restaurant) -> tuple[bool, dict]:
    n = db.scalar(select(func.count()).select_from(User).where(User.restaurant_id == r.id, User.is_active))
    return n > 1, {"active_users": n}


def _upi(db: Session, r: Restaurant) -> tuple[bool, dict]:
    acct = db.scalar(select(func.count()).select_from(PaymentProviderAccount).where(
        PaymentProviderAccount.restaurant_id == r.id, PaymentProviderAccount.active))
    return bool(r.upi_vpa) or acct > 0, {"upi_vpa": r.upi_vpa, "payment_provider_accounts": acct}


def _delivery(db: Session, r: Restaurant) -> tuple[bool, dict]:
    """Done when "Take delivery orders" is on and the status webhook to delivery-service is set (the ordering link works once
    both are in place). A kitchen that never saved the settings has the default (on) but no webhook yet."""
    from app.services import delivery
    cfg = delivery.get_settings(db, r.id)
    return bool(cfg.enabled and cfg.webhook_url), {"enabled": bool(cfg.enabled), "has_webhook": bool(cfg.webhook_url),
                                                    "manage_in": "Manage > Delivery"}


@dataclass(frozen=True)
class Step:
    id: str
    title: str
    description: str
    check: Callable[[Session, Restaurant], tuple[bool, dict]]
    actions: tuple[tuple[str, str], ...]
    needs: str | None = None  # business-type capability the step applies to (docs/BUSINESS_TYPES.md); None = every business


STEPS: tuple[Step, ...] = (
    Step("business", "Business details", "Restaurant name, address, phone (the restaurant phone customers call, e.g. the delivery tracking page's Call restaurant button) and GSTIN (or mark the restaurant as not GST-registered).",
         _business, (("PUT", "/api/v1/restaurant"),)),
    Step("outlet", "Outlet", "Address and phone of every active outlet (the first outlet is created for you).",
         _outlet, (("GET", "/api/v1/outlets"), ("PATCH", "/api/v1/outlets/{outlet_id}"))),
    Step("tables", "Tables and areas", "Add your tables (indoor, outdoor) so dine-in orders can be taken.",
         _tables, (("POST", "/api/v1/tables"),), needs="tables"),
    Step("delivery", "Turn on delivery", "Take delivery orders: switch on Take delivery orders and connect your ordering link (the delivery "
         "webhook) in Manage > Delivery, so online orders reach the kitchen.",
         _delivery, (("GET", "/api/v1/delivery/settings"), ("PUT", "/api/v1/delivery/settings")), needs="delivery_kitchen"),
    Step("menu", "Menu", "Add your first menu category and items.",
         _menu, (("POST", "/api/v1/menu/categories"), ("POST", "/api/v1/menu/items"))),
    Step("printer", "Printer", "Add a receipt or kitchen printer.",
         _printer, (("POST", "/api/v1/print/printers"), ("POST", "/api/v1/print/hubs/pairing"))),
    Step("tax", "GST mode", "Choose how GST is charged: switch on the GST engine, or keep the simple GST mode by skipping this step.",
         _tax, (("GET", "/api/v1/restaurant/gst"), ("PUT", "/api/v1/restaurant/gst"))),
    Step("staff", "Staff", "Add your staff so each person signs in with their own account.",
         _staff, (("POST", "/api/v1/auth/users"),)),
    Step("upi", "UPI", "Add the UPI id customers pay to.",
         _upi, (("PUT", "/api/v1/restaurant/upi"),)),
)
STEP_IDS = tuple(s.id for s in STEPS)


def status(db: Session, p) -> SetupStatusOut:
    r = db.get(Restaurant, p.restaurant_id)
    skips = {s.step: s for s in db.scalars(select(SetupStepSkip).where(SetupStepSkip.restaurant_id == p.restaurant_id))}
    types, caps = business_type.for_restaurant(db, p.restaurant_id)  # delivery follows the entitlement when it is enforced
    # the "Turn on delivery" step is for cloud / hotel kitchens (restaurants are unchanged) whose delivery module is on
    caps["delivery_kitchen"] = bool(caps["delivery_orders"] and set(types) & business_type.KITCHEN_TYPES)
    steps = []
    for s in STEPS:
        if s.needs and not caps.get(s.needs):
            continue  # e.g. no "Tables" step for a cloud kitchen
        done, detail = s.check(db, r)
        sk = skips.get(s.id)
        st = "done" if done else ("skipped" if sk else "todo")
        steps.append(SetupStep(id=s.id, title=s.title, description=s.description, status=st, done=done, skipped=sk is not None,
                               skipped_at=sk.created_at if sk else None, detail=detail,
                               actions=[SetupAction(method=m, path=pth) for m, pth in s.actions]))
    n_done = sum(1 for x in steps if x.status == "done")
    n_skip = sum(1 for x in steps if x.status == "skipped")
    total = len(steps)
    nxt = next((x.id for x in steps if x.status == "todo"), None)
    return SetupStatusOut(steps=steps, total=total, done=n_done, skipped=n_skip, remaining=total - n_done - n_skip,
                          percent=round(100 * (n_done + n_skip) / total), complete=nxt is None, next_step=nxt)


def _known(step_id: str) -> str:
    if step_id not in STEP_IDS:
        raise HTTPException(404, "Unknown setup step")
    return step_id


def skip(db: Session, p, step_id: str) -> SetupStatusOut:
    """Idempotent."""
    _known(step_id)
    exists = db.scalar(select(SetupStepSkip).where(SetupStepSkip.restaurant_id == p.restaurant_id, SetupStepSkip.step == step_id))
    if not exists:
        db.add(SetupStepSkip(restaurant_id=p.restaurant_id, step=step_id, skipped_by=p.user_id))
        audit.record(db, p, "setup.skip", "setup_step", None, {"step": step_id})
        try:
            db.commit()
        except IntegrityError:  # a concurrent skip of the same step
            db.rollback()
    return status(db, p)


def unskip(db: Session, p, step_id: str) -> SetupStatusOut:
    """Idempotent."""
    _known(step_id)
    row = db.scalar(select(SetupStepSkip).where(SetupStepSkip.restaurant_id == p.restaurant_id, SetupStepSkip.step == step_id))
    if row:
        db.delete(row)
        audit.record(db, p, "setup.unskip", "setup_step", None, {"step": step_id})
        db.commit()
    return status(db, p)


def set_upi(db: Session, p, value: str | None) -> str | None:
    v = (value or "").strip() or None
    if v is not None and not VPA.match(v):
        raise HTTPException(422, "A UPI id looks like name@bank")
    r = db.get(Restaurant, p.restaurant_id, with_for_update=True)
    if r.upi_vpa != v:
        audit.record(db, p, "restaurant.upi", "restaurant", r.id, {"before": r.upi_vpa, "after": v})
        r.upi_vpa = v
    db.commit()
    return r.upi_vpa


__all__ = ["STEPS", "STEP_IDS", "status", "skip", "unskip", "set_upi"]
