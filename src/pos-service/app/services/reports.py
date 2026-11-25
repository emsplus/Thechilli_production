"""Deterministic report calculations. Used by the REST API and by the AI tools (never SQL from the model)."""
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy import Date, String, case, cast, exists, func, select, true
from sqlalchemy.orm import Session

from app.models.core import (
    Bill, BillLine, Category, Device, InventoryItem, MenuItem, MovementType, Order, OrderLine, Payment, PaymentMethod, PurchaseInvoice, PurchaseStatus,
    Outlet, Recipe, Refund, Restaurant, StockMovement, Supplier,
)
from app.services import inventory, money, outlets

MAX_DAYS = 366
Z = Decimal(0)


class Ctx:
    def __init__(self, db: Session, restaurant_id: uuid.UUID, outlet_ids: list[uuid.UUID] | None = None):
        """outlet_ids: the outlets this report covers; None = every outlet of the tenant (background jobs, tests)."""
        self.db = db
        self.rid = restaurant_id
        self.outlet_ids = list(outlet_ids) if outlet_ids is not None else None
        r = db.get(Restaurant, restaurant_id)
        self.tz, self.currency = r.timezone, r.currency
        self.country, self.prices_include_tax = r.country, r.prices_include_tax
        self.currency_symbol, self.tax_number_label = r.currency_symbol, r.tax_number_label
        self.tax_word = money.tax_word(r.tax_mode)  # always GST (India only)

    @classmethod
    def for_principal(cls, db: Session, p, outlet_id: uuid.UUID | None = None, chosen: bool = False) -> "Ctx":
        """Outlet scope of a request: an explicit `outlet_id` (403 unless accessible), else the outlet picked with X-Outlet-Id
        (`chosen`), else every outlet the principal may see. Outlets of other tenants never match (tenant filter + RLS)."""
        if outlet_id is None and chosen and getattr(p, "outlet_id", None) is not None:
            outlet_id = p.outlet_id
        return cls(db, p.restaurant_id, outlets.scope(p, outlet_id, all_by_default=True)
                   if (outlet_id is not None or getattr(p, "outlet_ids", None) is not None) else None)

    def sc(self, model):
        """Outlet filter clause for a model with outlet_id (Bill, Order, Payment, Refund)."""
        return model.outlet_id.in_(self.outlet_ids) if self.outlet_ids is not None else true()

    def covers_tenant(self) -> bool:
        if self.outlet_ids is None:
            return True
        allx = set(self.db.scalars(select(Outlet.id).where(Outlet.restaurant_id == self.rid)))
        return allx <= set(self.outlet_ids)

    def require_tenant_level(self, what: str) -> None:
        """Purchases, expenses, stock and recipe costs carry no outlet, so they cannot be shown for one outlet or to a user
        restricted to some outlets: 403 instead of leaking other outlets' figures."""
        if not self.covers_tenant():
            raise HTTPException(403, f"{what} is tenant-wide and is not available for a single outlet or an outlet-restricted user")

    def window(self, d_from: date, d_to: date, tz: str | None = None) -> tuple[datetime, datetime]:
        if d_to < d_from:
            raise HTTPException(422, "to_date is before from_date")
        if (d_to - d_from).days >= MAX_DAYS:
            raise HTTPException(422, f"Date range is limited to {MAX_DAYS} days")
        z = ZoneInfo(tz or self.tz)
        start = datetime.combine(d_from, time.min, tzinfo=z).astimezone(timezone.utc)
        end = datetime.combine(d_to + timedelta(days=1), time.min, tzinfo=z).astimezone(timezone.utc)
        return start, end

    def completeness(self) -> dict:
        """Server can only know about devices that reported. Unsynced offline sales make figures understated."""
        rows = self.db.execute(select(Device.name, Device.pending_ops).where(
            Device.restaurant_id == self.rid, Device.pending_ops > 0)).all()
        return {"data_complete": not rows,
                "incomplete_reason": None if not rows else
                f"{sum(r[1] for r in rows)} offline operation(s) on {len(rows)} device(s) have not synced yet; "
                "sales shown may be understated."}

    def amendments(self, d_from: date | None, d_to: date | None) -> int:
        """Corrected bills (replacement invoices) whose SALE date is in the range."""
        if d_from is None or d_to is None or d_to < d_from or (d_to - d_from).days >= MAX_DAYS:
            return 0
        start, end = self.window(d_from, d_to)
        return self.db.scalar(select(func.count(Bill.id)).where(
            Bill.restaurant_id == self.rid, self.sc(Bill), Bill.amends_bill_id.is_not(None), Bill.status == "active",
            Bill.sale_at >= start, Bill.sale_at < end)) or 0

    def meta(self, metric: str, d_from: date | None, d_to: date | None) -> dict:
        n = self.amendments(d_from, d_to)
        return {"metric": metric, "from_date": d_from, "to_date": d_to, "timezone": self.tz,
                "currency": self.currency, "currency_symbol": self.currency_symbol, "country": self.country,
                "tax_word": self.tax_word,
                "prices_include_tax": self.prices_include_tax, "has_amendments": n > 0, "amendments_count": n,
                **self.completeness()}


def _f(x) -> Decimal:
    return Decimal(x or 0)


def daily_sales(c: Ctx, d_from: date, d_to: date) -> dict:
    start, end = c.window(d_from, d_to)
    day = cast(func.timezone(c.tz, Bill.sale_at), Date)
    rows = c.db.execute(select(day, func.count(Bill.id), func.sum(Bill.subtotal), func.sum(Bill.tax_amount),
                               func.sum(Bill.total), func.sum(Bill.discount_amount), func.sum(Bill.service_charge_amount))
                        .where(Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end)
                        .group_by(day).order_by(day)).all()
    rday = cast(func.timezone(c.tz, Refund.created_at), Date)
    refunds = dict(c.db.execute(select(rday, func.sum(Refund.amount)).where(
        Refund.restaurant_id == c.rid, c.sc(Refund), Refund.kind == "refund", Refund.created_at >= start, Refund.created_at < end)
        .group_by(rday)).all())
    days = [{"date": d, "bills": n, "subtotal": _f(sub), "vat": _f(vat), "gross_total": _f(tot),
             "discounts": _f(disc), "service_charge": _f(sc),
             "refunds": _f(refunds.get(d)), "net_total": _f(tot) - _f(refunds.get(d))}
            for d, n, sub, vat, tot, disc, sc in rows]
    totals = {k: sum((x[k] for x in days), Z) for k in ("subtotal", "vat", "gross_total", "discounts",
                                                         "service_charge", "refunds", "net_total")}
    totals["bills"] = sum(x["bills"] for x in days)
    totals["vat_by_rate"] = vat_by_rate(c, start, end)
    voided = voided_bills(c, start, end)
    pm = payments_by_method(c, start, end)
    return {**c.meta("daily_sales", d_from, d_to), "days": days, "totals": totals, "voided": voided,
            "payments_by_method": pm,
            "note": "Sales are by SALE date in the restaurant's local time; a corrected bill counts as its current version at its original date (so a correction restates that day). The end-of-day Z report is by posting time and shows corrections in the period they were made. subtotal = total excl. tax; "
                    "gross_total = what customers paid (incl. tax and service charge); net_total = gross_total - refunds."}


def voided_bills(c: Ctx, start: datetime, end: datetime) -> dict:
    """Whole-bill voids (services/void.py) by SALE date. They are NOT in any sales figure (status 'voided'); shown here so
    the day's cancelled sales stay visible."""
    day = cast(func.timezone(c.tz, Bill.sale_at), Date)
    rows = c.db.execute(select(day, func.count(Bill.id), func.sum(Bill.total)).where(
        Bill.restaurant_id == c.rid, Bill.status == "voided", Bill.sale_at >= start, Bill.sale_at < end)
        .group_by(day).order_by(day)).all()
    days = [{"date": d, "bills": n, "total": _f(t)} for d, n, t in rows]
    return {"bills": sum(x["bills"] for x in days), "total": sum((x["total"] for x in days), Z), "days": days}


def payments_by_method(c: Ctx, start: datetime, end: datetime) -> dict:
    """Money received per method (cash, card, upi, other) by the day it was taken, net of money handed back at voids
    (negative payment rows). Credit-note transfers between bill versions are excluded (net zero)."""
    day = cast(func.timezone(c.tz, Payment.created_at), Date)
    rows = c.db.execute(select(day, Payment.method, func.sum(Payment.amount)).where(
        Payment.restaurant_id == c.rid, Payment.method != PaymentMethod.credit_note,
        Payment.created_at >= start, Payment.created_at < end).group_by(day, Payment.method).order_by(day)).all()
    methods = [m.value for m in PaymentMethod if m != PaymentMethod.credit_note]
    totals = {m: Z for m in methods}
    days: dict = {}
    for d, m, a in rows:
        totals[m.value] += _f(a)
        days.setdefault(d, {k: Z for k in methods})[m.value] += _f(a)
    return {"totals": totals, "days": [{"date": d, **v} for d, v in sorted(days.items())]}


def vat_by_rate(c: Ctx, start: datetime, end: datetime) -> list[dict]:
    """Net / tax / gross per tax code and rate, from the bills' tax_breakdown snapshots. Bills finalized before the
    breakdown existed count as one standard-rate row."""
    acc: dict[tuple[str, Decimal], dict] = {}
    for brk, sub, vat, tot, rate in c.db.execute(select(
            Bill.tax_breakdown, Bill.subtotal, Bill.tax_amount, Bill.total, Bill.tax_rate_percent).where(
            Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end)):
        rows = brk or [{"code": "standard", "rate_percent": rate, "net": sub, "vat": vat, "gross": tot}]
        for r in rows:
            key = (r["code"], Decimal(str(r["rate_percent"])))
            a = acc.setdefault(key, {"code": key[0], "rate_percent": key[1], "net": Z, "vat": Z, "gross": Z})
            for k in ("net", "vat", "gross"):
                a[k] += Decimal(str(r[k]))
    order = {"standard": 0, "zero": 1, "none": 2}
    return sorted(acc.values(), key=lambda a: (order.get(a["code"], 9), a["code"]))


def item_sales(c: Ctx, d_from: date, d_to: date, limit: int = 20) -> dict:
    """Quantities and NET revenue (after discounts, excl. tax) from the finalized bill lines. Old bill lines
    (no net_amount) were tax-exclusive, so their net is the line total."""
    start, end = c.window(d_from, d_to)
    qty = func.sum(BillLine.quantity)
    rev = func.sum(func.coalesce(BillLine.net_amount, BillLine.line_total))
    rows = c.db.execute(select(BillLine.description, qty, rev).join(Bill, Bill.id == BillLine.bill_id)
                        .where(Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end)
                        .group_by(BillLine.description).order_by(rev.desc()).limit(min(max(limit, 1), 100))).all()
    return {**c.meta("item_sales", d_from, d_to),
            "items": [{"item": n, "quantity": int(q), "revenue_excl_vat": _f(r)} for n, q, r in rows],
            "note": "Revenue is net of tax and of bill discounts (service charge not included), from finalized invoices only."}


def order_summary(c: Ctx, d_from: date, d_to: date) -> dict:
    start, end = c.window(d_from, d_to)
    by_type = c.db.execute(select(Order.order_type, func.count(Bill.id), func.sum(Bill.total))
                           .join(Bill, Bill.order_id == Order.id)
                           .where(Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end)
                           .group_by(Order.order_type)).all()
    status = c.db.execute(select(Order.status, func.count(Order.id)).where(
        Order.restaurant_id == c.rid, c.sc(Order), Order.created_at >= start, Order.created_at < end).group_by(Order.status)).all()
    n = sum(x[1] for x in by_type)
    tot = sum((_f(x[2]) for x in by_type), Z)
    return {**c.meta("order_summary", d_from, d_to),
            "billed_by_order_type": [{"order_type": t.value, "bills": k, "total": _f(v)} for t, k, v in by_type],
            "orders_created_by_status": {s.value: k for s, k in status},
            "total_billed": tot, "billed_orders": n,
            "average_bill_value": (tot / n).quantize(Decimal("0.01")) if n else Z}


def inventory_balance(c: Ctx, name_contains: str | None = None) -> dict:
    q = select(InventoryItem).where(InventoryItem.restaurant_id == c.rid, InventoryItem.is_active)
    if name_contains:
        q = q.where(InventoryItem.name.ilike(f"%{name_contains.strip()}%"))
    items = c.db.scalars(q.order_by(InventoryItem.name).limit(200)).all()
    bal = inventory.balances(c.db, c.rid, [i.id for i in items])
    return {**c.meta("inventory_balance", None, None), "as_of": datetime.now(timezone.utc),
            "items": [{"item": i.name, "balance": bal.get(i.id, Z), "unit": i.base_unit,
                       "reorder_level": i.reorder_level, "low_stock": bal.get(i.id, Z) <= i.reorder_level} for i in items]}


def low_stock(c: Ctx) -> dict:
    r = inventory_balance(c)
    r["metric"] = "low_stock_items"
    r["items"] = [i for i in r["items"] if i["low_stock"]]
    return r


def purchase_summary(c: Ctx, d_from: date, d_to: date) -> dict:
    c.require_tenant_level("Purchases")
    start, end = c.window(d_from, d_to)
    rows = c.db.execute(select(Supplier.name, func.count(PurchaseInvoice.id), func.sum(PurchaseInvoice.total))
                        .join(Supplier, Supplier.id == PurchaseInvoice.supplier_id, isouter=True)
                        .where(PurchaseInvoice.restaurant_id == c.rid, PurchaseInvoice.status == PurchaseStatus.confirmed,
                               PurchaseInvoice.confirmed_at >= start, PurchaseInvoice.confirmed_at < end)
                        .group_by(Supplier.name).order_by(func.sum(PurchaseInvoice.total).desc())).all()
    return {**c.meta("purchase_summary", d_from, d_to),
            "suppliers": [{"supplier": n or "(none)", "invoices": k, "total": _f(t)} for n, k, t in rows],
            "total": sum((_f(x[2]) for x in rows), Z),
            "note": "Only confirmed purchases, by confirmation date. Totals as entered on the supplier invoice."}


def revenue_rows(c: Ctx, start: datetime, end: datetime) -> list[tuple]:
    """(menu item id, name, quantity, NET revenue excl. tax) per sold item from the finalized bills in [start, end).
    Bills without item_id snapshots (finalized before the per-line snapshots existed) fall back to their order lines (tax-exclusive prices)."""
    new_rows = c.db.execute(select(BillLine.item_id, BillLine.description, func.sum(BillLine.quantity),
                                   func.sum(func.coalesce(BillLine.net_amount, BillLine.line_total)))
                            .join(Bill, Bill.id == BillLine.bill_id)
                            .where(Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end,
                                   BillLine.item_id.is_not(None))
                            .group_by(BillLine.item_id, BillLine.description)).all()
    has_snap = exists().where(BillLine.bill_id == Bill.id, BillLine.item_id.is_not(None))
    old_rows = c.db.execute(select(OrderLine.item_id, OrderLine.item_name, func.sum(OrderLine.quantity),
                                   func.sum(OrderLine.unit_price * OrderLine.quantity))
                            .join(Order, Order.id == OrderLine.order_id).join(Bill, Bill.order_id == Order.id)
                            .where(Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end,
                                   ~has_snap)
                            .group_by(OrderLine.item_id, OrderLine.item_name)).all()
    return [(i, n, int(q), _f(r)) for i, n, q, r in list(new_rows) + list(old_rows)]


def avg_unit_costs(c: Ctx, end: datetime) -> dict[uuid.UUID, Decimal]:
    """Weighted-average purchase cost per base unit of every stock item (confirmed purchases before `end`)."""
    return {i: _f(v) for i, v in c.db.execute(
        select(StockMovement.item_id, func.sum(StockMovement.unit_cost * StockMovement.quantity) / func.nullif(func.sum(StockMovement.quantity), 0))
        .where(StockMovement.restaurant_id == c.rid, StockMovement.movement_type == MovementType.purchase,
               StockMovement.created_at < end, StockMovement.unit_cost.is_not(None)).group_by(StockMovement.item_id))}


def profitability(c: Ctx, d_from: date, d_to: date) -> dict:
    """Gross profit = revenue (excl. tax) - ingredient cost of recipes consumed.
    Cost method: weighted-average purchase cost per base unit (confirmed purchases up to the end of the range)."""
    c.require_tenant_level("Profitability")
    start, end = c.window(d_from, d_to)
    rev_rows = revenue_rows(c, start, end)
    revenue = sum((r[3] for r in rev_rows), Z)
    with_recipe = set(c.db.scalars(select(Recipe.menu_item_id).where(Recipe.restaurant_id == c.rid)))
    no_recipe = sorted({r[1] for r in rev_rows if r[0] not in with_recipe})
    avg_cost = avg_unit_costs(c, end)
    used = c.db.execute(select(StockMovement.item_id, func.sum(-StockMovement.quantity)).where(
        StockMovement.restaurant_id == c.rid,
        (StockMovement.movement_type == MovementType.sale)  # + the reversal of a corrected bill's consumption
        | ((StockMovement.movement_type == MovementType.adjustment) & (StockMovement.detail["amend_reversal"].as_boolean())),
        StockMovement.created_at >= start, StockMovement.created_at < end).group_by(StockMovement.item_id)).all()
    names = {i.id: i.name for i in c.db.scalars(select(InventoryItem).where(InventoryItem.restaurant_id == c.rid))}
    cogs, uncosted = Z, []
    for item_id, qty in used:
        if item_id in avg_cost:
            cogs += _f(qty) * avg_cost[item_id]
        else:
            uncosted.append(names.get(item_id, str(item_id)))
    cogs = cogs.quantize(Decimal("0.01"))
    gp = revenue - cogs
    warnings = []
    if no_recipe:
        warnings.append("Some sold items have no recipe, so their ingredient cost is not included: " + ", ".join(no_recipe))
    if uncosted:
        warnings.append("Ingredients used but never purchased with a recorded cost: " + ", ".join(sorted(uncosted)))
    return {**c.meta("profitability", d_from, d_to), "revenue_excl_vat": revenue, "ingredient_cost": cogs,
            "gross_profit": gp, "gross_margin_percent": (gp / revenue * 100).quantize(Decimal("0.1")) if revenue else None,
            "items_without_recipe": no_recipe, "ingredients_without_cost": sorted(uncosted), "warnings": warnings,
            "cost_method": "weighted-average purchase cost"}


# Sales channels shared by the Z report and the sales-by-category report: (key, order types, heading, sub label).
CHANNELS: tuple[tuple[str, tuple[str, ...], str, str], ...] = (
    ("table", ("indoor", "outdoor"), "IN-STORE ORDERS", "TABLE"),
    ("takeaway", ("takeaway",), "TAKE AWAY", "TAKE AWAY"),
    ("online", ("delivery",), "ONLINE ORDERS", "ONLINE"),
)
UNCATEGORISED = "Uncategorised"


def channel_of(order_type: str | None) -> str:
    for key, types, _, _ in CHANNELS:
        if order_type in types:
            return key
    return CHANNELS[0][0]  # unknown / missing type: counted with table orders so nothing is dropped


def _period(Bill_, start: datetime, end: datetime, by_sale: bool) -> list:
    """Z report (till view): bills by POSTING time, superseded originals included in their own period.
    Date reports: the CURRENT version of each bill at its SALE date (superseded originals excluded)."""
    if by_sale:
        return [Bill_.status == "active", Bill_.sale_at >= start, Bill_.sale_at < end]
    return [Bill_.finalized_at >= start, Bill_.finalized_at < end]


def category_rows(db: Session, rid: uuid.UUID, start: datetime, end: datetime, by_sale: bool = False,
                  oids: list[uuid.UUID] | None = None) -> list[dict]:
    """Bill lines of invoices finalized in [start, end), grouped by (channel, category). All amounts exact sums.
      before_discount  line amounts before the bill discount (gross if the bill's prices include tax, else net)
      discount         the lines' share of the bill discount (old bills had none)
      net / vat        after discount; gross = net + vat
    Category = the snapshot taken at sale time, else the item's current category, else 'Uncategorised'. Old rows
    without a tax snapshot (tax-exclusive) get vat = line total x the bill's rate."""
    order_type = func.coalesce(Bill.order_type, cast(Order.order_type, String))
    cat = func.coalesce(BillLine.category_name, Category.name, UNCATEGORISED)
    after = func.coalesce(case((Bill.prices_include_tax, BillLine.gross_amount), else_=BillLine.net_amount),
                          BillLine.line_total)
    net = func.coalesce(BillLine.net_amount, BillLine.line_total)
    vat = func.coalesce(BillLine.vat_amount, func.round(BillLine.line_total * Bill.tax_rate_percent / 100, 2))
    rows = db.execute(
        select(order_type, cat, func.sum(BillLine.quantity), func.sum(BillLine.line_total),
               func.sum(BillLine.line_total - after), func.sum(net), func.sum(vat))
        .select_from(BillLine).join(Bill, Bill.id == BillLine.bill_id).join(Order, Order.id == Bill.order_id)
        .outerjoin(MenuItem, MenuItem.id == BillLine.item_id).outerjoin(Category, Category.id == MenuItem.category_id)
        .where(Bill.restaurant_id == rid, Bill.outlet_id.in_(oids) if oids is not None else true(), *_period(Bill, start, end, by_sale))
        .group_by(order_type, cat)).all()
    return merge_category_rows([{"channel": channel_of(t), "category": c, "quantity": int(q), "before_discount": _f(b),
                                 "discount": _f(d), "net": _f(n), "vat": _f(v)} for t, c, q, b, d, n, v in rows])


def category_key(name: str | None) -> str:
    """Two category names are the same category when they differ only in case or surrounding / repeated spaces."""
    return " ".join((name or UNCATEGORISED).split()).casefold()


def merge_category_rows(rows: list[dict]) -> list[dict]:
    """One row per (channel, category): the query groups by ORDER TYPE, and a channel holds several (the table channel is indoor + outdoor),
    so the same category came back once per order type and was listed twice (STARTERS 3 / STARTERS 1). Names that differ only in case or
    spacing are one category too. Quantity and the amounts are summed; the label is the spelling with the most sales (then alphabetically),
    so it does not depend on the order the database returned the rows in."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for r in rows:
        groups.setdefault((r["channel"], category_key(r["category"])), []).append(r)
    out = []
    for g in groups.values():
        best = min(g, key=lambda r: (-r["before_discount"], " ".join((r["category"] or UNCATEGORISED).split())))
        out.append({"channel": g[0]["channel"], "category": " ".join((best["category"] or UNCATEGORISED).split()),
                    "quantity": sum(r["quantity"] for r in g),
                    **{k: sum((r[k] for r in g), Z) for k in ("before_discount", "discount", "net", "vat")}})
    return out


def category_sales(c: Ctx, d_from: date, d_to: date) -> dict:
    """Sales per menu category (and per channel) for restaurant-local dates, by SALE date (current version of each bill; see daily_sales)."""
    start, end = c.window(d_from, d_to)
    rows = category_rows(c.db, c.rid, start, end, by_sale=True, oids=c.outlet_ids)
    bills = c.db.execute(select(Order.order_type, func.count(Bill.id), func.coalesce(func.sum(Bill.service_charge_amount), 0))
                         .join(Bill, Bill.order_id == Order.id)
                         .where(Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end)
                         .group_by(Order.order_type)).all()

    def merge(sel: list[dict]) -> tuple[list[dict], dict]:
        acc: dict[str, dict] = {}
        for r in sel:
            a = acc.setdefault(category_key(r["category"]), {"category": r["category"], "quantity": 0, "before_discount": Z,
                                                             "discount": Z, "net": Z, "vat": Z})
            if a.get("_k") is None or (r["before_discount"], r["category"]) > a["_k"]:  # label = the spelling with the most sales
                a["category"], a["_k"] = r["category"], (r["before_discount"], r["category"])
            a["quantity"] += r["quantity"]
            for k in ("before_discount", "discount", "net", "vat"):
                a[k] += r[k]
        for a in acc.values():
            a.pop("_k", None)
        total_net = sum((a["net"] for a in acc.values()), Z)
        out = []
        for a in sorted(acc.values(), key=lambda a: (-a["net"], a["category"])):
            out.append({**a, "gross": a["net"] + a["vat"],
                        "share_percent": (a["net"] / total_net * 100).quantize(Decimal("0.01")) if total_net else Z})
        tot = {"quantity": sum(a["quantity"] for a in out)}
        for k in ("before_discount", "discount", "net", "vat", "gross"):
            tot[k] = sum((a[k] for a in out), Z)
        return out, tot

    cats, totals = merge(rows)
    by_channel = []
    for key, types, heading, sub in CHANNELS:
        sel = [r for r in rows if r["channel"] == key]
        cc, tt = merge(sel)
        by_channel.append({"channel": key, "label": heading, "orders": sum(n for t, n, _ in bills if t.value in types),
                           "categories": cc, "totals": tt})
    totals["service_charge"] = sum((_f(sc) for _, _, sc in bills), Z)
    return {**c.meta("category_sales", d_from, d_to), "categories": cats, "by_channel": by_channel, "totals": totals,
            "note": "Per category, from finalized invoices. before_discount = line amounts before the bill discount "
                    "(tax-inclusive when prices include tax); discount = the lines' share of it; net/vat/gross after "
                    "discount; share_percent is of net. The service charge is not part of any category (totals.service_charge)."}


def to_json(data: dict) -> dict:
    """Money and quantities leave the API as exact decimal strings, never floats. A report of a GST-engine restaurant (its meta
    has `tax_word` GST) gets the word Tax replaced by GST in its wording (note / warnings / labels), never in data or JSON keys."""
    out = jsonable_encoder(data, custom_encoder={Decimal: str})
    word = out.get("tax_word") if isinstance(out, dict) else None
    return _retax_wording(out, word) if word and word != "Tax" else out


_WORDING = {"note", "notes", "warnings", "labels", "label", "heading", "title", "checks_info", "direction_label"}


def _retax_wording(x, word: str, on: bool = False):
    if isinstance(x, str):
        return money.retax(x, word) if on else x
    if isinstance(x, list):
        return [_retax_wording(i, word, on) for i in x]
    if isinstance(x, dict):
        return {k: _retax_wording(v, word, on or k in _WORDING) for k, v in x.items()}
    return x
