"""India GST adapter: wires the pure `tax_engine_in` library (integer paise, rules UNVERIFIED) into pos-service billing.

Only for restaurants with country IN and `tax_mode = 'gst_engine'` (default 'off'; GB/AE never reach this module's
computation). This module owns the Decimal-rupees <-> integer-paise boundary: everything crossing into the engine is
converted exactly (no silent rounding) and everything coming out is converted back. The engine result is presented to the
rest of the app as the legacy `tax.Invoice` shape (net = taxable, vat = tax) plus GST extras, so the bill, report and
receipt code keep working; the engine's own `Invoice.to_dict()` is persisted on the bill (`gst_document`) so credit notes
replay against exactly what was issued.

Every legal / policy choice is explicit per-restaurant configuration (`GstConfig`, stored in `restaurants.gst_config`)
with the ENGINE's current defaults; nothing here takes a position. All of it needs CA verification
(tax-engine-in/docs/OPEN_QUESTIONS_CA.md). That statement is shown to administrators only (`ADMIN_WARNING`), never printed.
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.services import tax

MODE_ON = "gst_engine"
ADMIN_WARNING = ("GST rates and treatment are pending CA verification: the tax engine's rates, treatments, rounding and "
                 "credit-note rules are engineering defaults, not tax advice. Do not rely on these invoices for GST "
                 "returns until a CA has signed off (docs/GST_INTEGRATION.md).")
DEFAULT_COMPOSITION_LEGEND = "Composition taxable person, not eligible to collect tax on supplies"
PAISA = Decimal("0.01")


# ------------------------------------------------------------------ engine import (path dependency, see docs)
def engine():
    """The `tax_engine_in` module. Installed with `uv pip install -e ../tax-engine-in`; falls back to the sibling checkout
    (or $TAX_ENGINE_IN_PATH, a directory that contains the `tax_engine_in` package, i.e. its `src`)."""
    try:
        import tax_engine_in as E
        return E
    except ImportError:
        pass
    here = Path(__file__).resolve()
    cands = [Path(os.environ["TAX_ENGINE_IN_PATH"])] if os.environ.get("TAX_ENGINE_IN_PATH") else []
    cands += [p / "tax-engine-in" / "src" for p in here.parents]
    for c in cands:
        if (c / "tax_engine_in").is_dir():
            sys.path.insert(0, str(c))
            import tax_engine_in as E
            return E
    raise HTTPException(503, "The India GST engine (tax-engine-in) is not installed on this server")


def _wrap(fn, *a, **k):
    """Runs an engine call; its TaxError becomes the app's tax.TaxError (same message and status)."""
    E = engine()
    try:
        return fn(*a, **k)
    except E.TaxError as e:
        raise tax.TaxError(str(e), getattr(e, "status", 422)) from None


# ------------------------------------------------------------------ paise <-> rupees
def to_paise(x: Decimal | int | str) -> int:
    d = Decimal(x)
    q = d.quantize(PAISA, rounding=ROUND_HALF_UP)
    return int(q * 100)


def rupees(p: int) -> Decimal:
    return (Decimal(p) / 100).quantize(PAISA)


# ------------------------------------------------------------------ configuration
class GstConfig(BaseModel):
    """Every policy choice, explicit. Defaults = the engine's current defaults (NOT verified)."""
    state_code: str                                            # the seller's 2-digit GST state code
    treatment: str = "restaurant_5_no_itc"                     # restaurant_5_no_itc | restaurant_18_with_itc | composition | goods_only
    restaurant_sac: str = "996331"
    service_charge_code: str | None = None                     # None = the engine's rule (highest item rate)
    packaging_code: str | None = None
    delivery_code: str | None = None
    packaging_amount: Decimal = Field(default=Decimal("0"), ge=0, max_digits=10, decimal_places=2)  # per takeaway/delivery bill
    delivery_amount: Decimal = Field(default=Decimal("0"), ge=0, max_digits=10, decimal_places=2)   # per delivery bill
    round_off: bool = True
    rates: dict[str, Decimal] | None = None                    # None = the engine's default rate table
    default_place_of_supply: str | None = None                 # None = bills without a customer state are REFUSED
    composition_legend: str = Field(default=DEFAULT_COMPOSITION_LEGEND, max_length=200)

    @field_validator("state_code", "default_place_of_supply")
    @classmethod
    def _state(cls, v):
        return None if v is None else check_state(v)


def check_state(v: str) -> str:
    E = engine()
    try:
        return E.normalise_state_code(v)
    except E.TaxError as e:
        raise ValueError(str(e))


def check_gstin(v: str) -> str:
    E = engine()
    try:
        return E.validate_gstin(v)
    except E.TaxError as e:
        raise ValueError(str(e))


def applies(restaurant) -> bool:
    return restaurant.country == "IN" and restaurant.tax_mode == MODE_ON


def load_config(restaurant) -> GstConfig:
    if not restaurant.gst_config:
        raise HTTPException(409, "GST is switched on but not configured: set the seller state, treatment and place of supply "
                                 "in the GST settings")
    return GstConfig.model_validate(restaurant.gst_config)


def build_tax_config(cfg: GstConfig, seller_gstin: str | None):
    E = engine()
    kw = {}
    if cfg.rates is not None:
        kw["rates"] = dict(cfg.rates)
    return _wrap(E.TaxConfig, cfg.state_code, treatment=cfg.treatment, restaurant_sac=cfg.restaurant_sac,
                 seller_gstin=seller_gstin, **kw)


def get_settings(restaurant) -> dict:
    return {"tax_mode": restaurant.tax_mode, "country": restaurant.country, "config": restaurant.gst_config,
            "gstin": restaurant.trn, "admin_warning": ADMIN_WARNING if applies(restaurant) else None}


def set_settings(db: Session, p, restaurant, tax_mode: str, config: dict | None) -> dict:
    """Owner action. Validates everything with the engine before saving; never silently fixes anything."""
    if tax_mode not in ("off", MODE_ON):
        raise HTTPException(422, "tax_mode must be 'off' or 'gst_engine'")
    if tax_mode == MODE_ON:
        if restaurant.country != "IN":
            raise HTTPException(409, "The GST engine is available for country IN only")
        if config is None:
            raise HTTPException(422, "config is required to switch the GST engine on")
        try:
            cfg = GstConfig.model_validate(config)
        except ValueError as e:
            raise HTTPException(422, str(e))
        if not restaurant.trn:
            raise HTTPException(409, "Set the restaurant's GSTIN before switching the GST engine on")
        try:
            g = check_gstin(restaurant.trn)
        except ValueError as e:
            raise HTTPException(422, f"Restaurant GSTIN: {e}")
        try:
            build_tax_config(cfg, g)  # state / GSTIN match, treatment, rates, SAC
        except tax.TaxError as e:
            raise HTTPException(e.status if e.status != 422 else 422, str(e))
        restaurant.gst_config = cfg.model_dump(mode="json")
    restaurant.tax_mode = tax_mode
    db.flush()
    return get_settings(restaurant)


def check_trn_for_gst(restaurant, trn: str | None) -> None:
    """Called when the GSTIN changes on a restaurant that has the engine on: it must pass the engine's validation."""
    if restaurant.tax_mode == MODE_ON:
        if not trn:
            raise HTTPException(422, "A GSTIN is required while the GST engine is on")
        try:
            check_gstin(trn)
        except ValueError as e:
            raise HTTPException(422, str(e))


# ------------------------------------------------------------------ computation
def resolve_place_of_supply(cfg: GstConfig, customer_state: str | None) -> str:
    pos = customer_state or cfg.default_place_of_supply
    if not pos:
        raise tax.TaxError("Place of supply is not set: give the customer a state, or set an explicit default place of "
                           "supply in the GST settings", 409)
    return pos


def _legacy(l, shown_unit: bool = True) -> tax.LineOut:
    out = tax.LineOut(description=l.description, quantity=l.quantity, unit_price=rupees(l.unit_price),
                      tax_code=l.tax_code, rate_percent=l.rate_percent, line_total=rupees(l.line_amount),
                      discount=rupees(l.discount), gross=rupees(l.gross), net=rupees(l.taxable), vat=rupees(l.tax),
                      item_id=uuid.UUID(l.item_id) if l.item_id else None)
    out.hsn, out.cgst, out.sgst, out.igst = l.hsn, rupees(l.cgst), rupees(l.sgst), rupees(l.igst)
    return out


def breakdown_rows(inv) -> list[dict]:
    """Engine rate rows -> the tax_breakdown snapshot rows reports.vat_by_rate / Z report read (code, rate, net, vat, gross),
    plus the CGST/SGST/IGST split."""
    rows = []
    for r in sorted(inv.breakup, key=lambda r: r.rate_percent):
        rate = Decimal(r.rate_percent)
        rows.append({"code": f"gst_{rate.normalize():f}", "rate_percent": f"{rate:.2f}", "net": str(rupees(r.taxable)),
                     "vat": str(rupees(r.tax)), "gross": str(rupees(r.gross)), "cgst": str(rupees(r.cgst)),
                     "sgst": str(rupees(r.sgst)), "igst": str(rupees(r.igst))})
    return rows


def _present(einv, charge_kinds: bool = True) -> tax.Invoice:
    items = [l for l in einv.lines if l.kind == "item"]
    sc = next((l for l in einv.lines if l.kind == "service_charge"), None)
    pk = sum(l.line_amount for l in einv.lines if l.kind == "packaging")
    dl = sum(l.line_amount for l in einv.lines if l.kind == "delivery")
    inv = tax.Invoice(
        lines=[_legacy(l) for l in items], prices_include_tax=einv.prices_include_tax,
        discount_amount=rupees(einv.discount_amount), discount_reason=einv.discount_reason,
        service_charge_percent=einv.service_charge_percent.quantize(PAISA),
        service_charge_amount=rupees(sc.line_amount) if sc else Decimal("0.00"),
        service_charge=_legacy(sc) if sc else None, subtotal=rupees(einv.taxable_total),
        tax_amount=rupees(einv.tax_total), total=rupees(einv.total), tax_breakdown=breakdown_rows(einv))
    inv.gst, inv.round_off = einv, rupees(einv.round_off)
    inv.cgst, inv.sgst, inv.igst = rupees(einv.cgst), rupees(einv.sgst), rupees(einv.igst)
    inv.packaging_amount, inv.delivery_amount = rupees(pk), rupees(dl)
    inv.place_of_supply, inv.document_type = einv.place_of_supply, einv.document_type
    return inv


def compute(cfg: GstConfig, seller_gstin: str | None, specs: list[tuple], *, sc_pct: Decimal,
            discount: tax.DiscountIn | None, place_of_supply: str, prices_include_tax: bool,
            charges: list[tuple] = (), line_discounts=None, discount_reason: str | None = None) -> tax.Invoice:
    """specs: (description, quantity, unit_price Decimal rupees, MenuItem-like | None, item_id).
    charges: (kind 'packaging'|'delivery', amount Decimal rupees, tax code | None[, HSN/SAC]).
    line_discounts: per-spec Decimal-rupee discounts (tax-engine-in >= 0.2.0 `LineIn.discount`); with them `discount` must be
    None and `discount_reason` labels the bill. Returns the legacy-shaped Invoice with `.gst` (the engine Invoice) and the GST
    extras."""
    E = engine()
    tc = build_tax_config(cfg, seller_gstin)
    ld = [to_paise(d) for d in line_discounts] if line_discounts is not None else None
    if ld is not None:
        if len(ld) != len(specs) or discount is not None:
            raise tax.TaxError("line discounts must match the lines, without a bill discount")
        if "discount" not in getattr(E.LineIn, "__dataclass_fields__", {}):
            # tax-engine-in < 0.2.0 has no per-line discount: old behaviour (exact total, split by line value)
            discount, ld = (tax.DiscountIn("amount", rupees(sum(ld)), discount_reason) if sum(ld) else None), None
    lines = []
    for i, (desc, qty, price, item, item_id) in enumerate(specs):
        code = (getattr(item, "gst_rate_code", None) or None)
        extra = {"discount": ld[i]} if ld is not None and ld[i] else {}
        lines.append(E.LineIn(desc, qty, to_paise(price), getattr(item, "supply_type", None) or "restaurant", code,
                              getattr(item, "hsn", None) or None, str(item_id) if item_id else None,
                              allow_no_tax=(code == "none"), **extra))
    ch = [E.ChargeIn(kind, to_paise(c[1]), c[2], c[3] if len(c) > 3 else None, allow_no_tax=c[2] == "none")
          for c in charges for kind in [c[0]] if c[1] and c[1] > 0]
    disc = None
    if discount is not None:
        disc = E.DiscountIn(discount.type, discount.value if discount.type == "percent" else to_paise(discount.value),
                            discount.reason)
    einv = _wrap(E.compute_invoice, lines, tc, prices_include_tax, sc_pct, disc, ch, place_of_supply,
                 cfg.round_off, cfg.service_charge_code)
    if ld is not None and einv.discount_amount:
        einv.discount_reason = discount_reason  # the engine only names bill discounts; offers label the per-line ones
    return _present(einv)


def configured_charges(cfg: GstConfig, order_type: str) -> list[tuple]:
    """Packaging (takeaway, delivery) and delivery (delivery) charges from the restaurant's explicit configuration."""
    out = []
    if order_type in ("takeaway", "delivery"):
        out.append(("packaging", cfg.packaging_amount, cfg.packaging_code))
    if order_type == "delivery":
        out.append(("delivery", cfg.delivery_amount, cfg.delivery_code))
    return out


def plan_invoice(db: Session, restaurant, order, disc, sc_pct: Decimal, *, line_discounts=None,
                 discount_reason: str | None = None) -> tax.Invoice | None:
    """Single call site of billing.plan_bill: None when the GST engine is not on for this restaurant.
    line_discounts: exact Decimal-rupee discount per order line (offers + manual, from offers.combine), passed to the engine
    as per-line discounts so an item/category offer only lowers its own rate group."""
    if not applies(restaurant):
        return None
    from app.models.core import Customer, MenuItem
    from app.services import outlets
    cfg = load_config(restaurant)
    seller = outlets.seller_details(db, restaurant, order.outlet_id)["seller_trn"]
    cust = db.get(Customer, order.customer_id) if order.customer_id else None
    pos = resolve_place_of_supply(cfg, cust.state_code if cust else None)
    items = {i.id: i for i in db.scalars(select(MenuItem).where(MenuItem.id.in_({l.item_id for l in order.lines})))}
    from app.services.modifiers import describe
    # modifier price deltas are already in unit_price, so they take the item's own GST treatment
    specs = [(describe(l.item_name, l.modifiers), l.quantity, l.unit_price, items.get(l.item_id), l.item_id) for l in order.lines]
    ot = getattr(order.order_type, "value", order.order_type)
    return compute(cfg, seller, specs, sc_pct=sc_pct, discount=disc, place_of_supply=pos,
                   prices_include_tax=restaurant.prices_include_tax, charges=configured_charges(cfg, ot),
                   line_discounts=line_discounts, discount_reason=discount_reason)


def amend_invoice(db: Session, restaurant, bill, lines: list, meta: list, disc, sc_pct: Decimal) -> tax.Invoice:
    """Replacement invoice of a corrected GST bill: same place of supply, seller GSTIN and charges as the original."""
    from app.models.core import MenuItem
    cfg = load_config(restaurant)
    items = {i.id: i for i in db.scalars(select(MenuItem).where(MenuItem.id.in_({l.item_id for l in lines})))}
    specs = [(l.description, l.quantity, l.unit_price, items.get(l.item_id), l.item_id) for l in lines]
    # the original's own charge amounts are kept (the codes come from the current configuration)
    charges = [("packaging", bill.packaging_amount, cfg.packaging_code), ("delivery", bill.delivery_amount, cfg.delivery_code)]
    return compute(cfg, bill.seller_gstin, specs, sc_pct=sc_pct, discount=disc,
                   place_of_supply=bill.place_of_supply or resolve_place_of_supply(cfg, bill.customer_state_code),
                   prices_include_tax=bill.prices_include_tax, charges=charges)


# ------------------------------------------------------------------ numbering
_KIND = {"INV": "tax_invoice", "CN": "credit_note"}
_COUNTER = {"tax_invoice": "GINV", "bill_of_supply": "GBOS", "credit_note": "GCN"}


def next_number(db: Session, restaurant, kind: str, now: datetime, outlet_id: uuid.UUID) -> str:
    """Engine numbering helper (INV/26-27/000001, max 16 chars, separate series per document type, restarting 1 April) over
    the gap-free per-outlet counters. An outlet invoice prefix does not fit the engine's 16-character format: such an
    outlet is refused (409) instead of getting a number the engine would reject."""
    from app.models.core import Outlet
    from app.services import billing
    E = engine()
    cfg = load_config(restaurant)
    doctype = _KIND[kind]
    if doctype == "tax_invoice" and not build_tax_config(cfg, None).active.collects_tax:
        doctype = "bill_of_supply"
    outlet = db.get(Outlet, outlet_id)
    local = now.astimezone(ZoneInfo(outlet.timezone))
    fy = local.year if local.month >= 4 else local.year - 1
    seq = billing.next_counter(db, restaurant.id, outlet_id, _COUNTER[doctype], fy)
    try:
        return E.document_number(doctype, seq, local.date(), outlet.invoice_prefix or "")
    except E.TaxError as e:
        raise HTTPException(409, f"{e}: the GST engine's 16-character document numbers cannot carry this outlet's invoice prefix")


def local_date(db: Session, outlet_id: uuid.UUID, at: datetime) -> date:
    from app.models.core import Outlet
    return at.astimezone(ZoneInfo(db.get(Outlet, outlet_id).timezone)).date()


# ------------------------------------------------------------------ persistence on the bill / credit notes
def decorate_bill(db: Session, bill, inv: tax.Invoice, restaurant, customer=None) -> None:
    """Single call site of finalize (and of amend for the replacement): GST columns, line HSN/CGST/SGST/IGST and the
    serialised engine invoice (with its number and date, so credit notes can reference it)."""
    if getattr(inv, "gst", None) is None:
        return
    einv = inv.gst
    einv.invoice_number = bill.invoice_number
    einv.invoice_date = local_date(db, bill.outlet_id, bill.sale_at).isoformat()
    bill.tax_mode, bill.document_type = MODE_ON, einv.document_type
    bill.place_of_supply = einv.place_of_supply
    bill.seller_gstin = bill.seller_trn
    if customer is not None:
        bill.customer_gstin, bill.customer_state_code = customer.gstin, customer.state_code
    bill.cgst_amount, bill.sgst_amount, bill.igst_amount = inv.cgst, inv.sgst, inv.igst
    bill.round_off = inv.round_off
    bill.packaging_amount, bill.delivery_amount = inv.packaging_amount, inv.delivery_amount
    bill.tax_name, bill.tax_rate_percent = "GST", Decimal("0.00")
    for bl, l in zip(bill.lines, inv.lines):
        bl.hsn, bl.cgst_amount, bl.sgst_amount, bl.igst_amount = l.hsn, l.cgst, l.sgst, l.igst
    bill.gst_document = {**einv.to_dict(), "pos_legend": load_config(restaurant).composition_legend}


def attach_credit_note(db: Session, bill, refund, at: datetime, amount: Decimal | None = None) -> None:
    """Single call site of add_refund (partial, by amount) and amend (amount None = full reversal): builds the engine
    credit note against the stored invoice and the bill's earlier notes, and persists its to_dict() on the refund."""
    if bill.tax_mode != MODE_ON or not bill.gst_document:
        return
    from app.models.core import Refund
    E = engine()
    inv = _wrap(E.Invoice.from_dict, bill.gst_document)
    prev = [_wrap(E.CreditNote.from_dict, r.credit_note_doc) for r in db.scalars(
        select(Refund).where(Refund.bill_id == bill.id, Refund.credit_note_doc.is_not(None))
        .order_by(Refund.created_at, Refund.id))]
    on = local_date(db, bill.outlet_id, at).isoformat()
    try:
        if amount is None:
            note = _wrap(E.credit_note_fraction, inv, "1", prev, refund.credit_note_number, on)
        else:
            note = _wrap(E.credit_note_amount, inv, to_paise(amount), prev, refund.credit_note_number, on)
    except tax.TaxError as e:
        raise HTTPException(e.status, str(e))
    refund.tax_amount, refund.round_off = rupees(note.tax_total), rupees(note.round_off)
    refund.credit_note_doc = note.to_dict()


def preview_extras(inv: tax.Invoice) -> dict:
    if getattr(inv, "gst", None) is None:
        return {}
    return {"round_off": inv.round_off, "place_of_supply": inv.place_of_supply, "document_type": inv.document_type}
