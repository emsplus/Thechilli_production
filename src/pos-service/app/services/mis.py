"""MIS reports (docs/REPORTS.md, docs/REPORTS_MIS_PLAN.md): GST summary, payments by method / cashier, period sales,
item ranking and outlet comparison. Same conventions as services/reports.py: read-only, tenant + outlet scoped through the
Ctx, inclusive local dates, half-open UTC windows, exact Decimal sums, only active bills are sales."""
import uuid
from datetime import date, datetime
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import Date, String, and_, cast, func, or_, select

from app.models.core import (
    Bill, BillLine, Expense, Order, OrderLine, OrderStatus, Outlet, Payment, PurchaseInvoice, PurchaseStatus, Refund, Restaurant, User,
)
from app.services import order_kinds, reports
from app.services.reports import Ctx, Z, _f

PAISA = Decimal("0.01")
TRANSFER_METHODS = ("credit_note",)  # settles a replacement bill from the original's payments: not cash-in


def q2(x) -> Decimal:
    return _f(x).quantize(PAISA)


def _pct(part, whole) -> Decimal | None:
    return (_f(part) / _f(whole) * 100).quantize(PAISA) if whole else None


def _names(c: Ctx, ids) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {i: n for i, n in c.db.execute(select(User.id, User.full_name).where(User.restaurant_id == c.rid, User.id.in_(ids)))}


# ------------------------------------------------------------------------------------------------ 1. GST / tax summary
def input_tax(c: Ctx, d_from: date, d_to: date, registered: bool, warnings: list[str]) -> dict:
    """Input tax (GST paid) on confirmed stock purchases (by invoice date) and expenses (by expense date); expense-type scans
    are in Expense. Tenant-level: purchases and expenses carry no outlet. A seller that is not GST registered cannot claim it
    (total 0). Appends what the owner should know to `warnings`."""
    inv_date = func.coalesce(PurchaseInvoice.invoice_date, cast(func.timezone(c.tz, PurchaseInvoice.confirmed_at), Date))
    p_n, p_tax, p_missing = c.db.execute(select(
        func.count(PurchaseInvoice.id), func.coalesce(func.sum(PurchaseInvoice.vat), 0),
        func.count(PurchaseInvoice.id).filter(PurchaseInvoice.vat.is_(None))).where(
        PurchaseInvoice.restaurant_id == c.rid, PurchaseInvoice.status == PurchaseStatus.confirmed,
        PurchaseInvoice.document_type == "stock_purchase", inv_date >= d_from, inv_date <= d_to)).one()
    e_n, e_tax = c.db.execute(select(func.count(Expense.id), func.coalesce(func.sum(Expense.vat), 0)).where(
        Expense.restaurant_id == c.rid, Expense.expense_date >= d_from, Expense.expense_date <= d_to)).one()
    total = _f(p_tax) + _f(e_tax)
    if not registered:
        warnings.append("The restaurant is not GST registered: no output tax is charged and input tax cannot be claimed.")
        total = Z
    if p_missing:
        warnings.append(f"{p_missing} confirmed purchase invoice(s) have no tax amount recorded, so their input tax is not included.")
    if _f(p_tax) == 0 and _f(e_tax) == 0 and (p_n or e_n):
        warnings.append("No input tax is recorded on the purchases / expenses of this period.")
    return {"purchases": q2(p_tax), "expenses": q2(e_tax), "total": q2(total), "invoices_missing_tax": p_missing,
            "purchase_invoices": p_n, "expense_count": e_n}


def gst_summary(c: Ctx, d_from: date, d_to: date) -> dict:
    """Output tax by rate from the bills' tax snapshots (current version of each bill, by sale date), less tax on credit notes.
    CGST / SGST / IGST columns exist for the GSTR-style layout but the POS does not store the intra-/inter-state split, HSN/SAC
    or place of supply today, so they are null (never derived or guessed); `tax` is the total tax at that rate.

    Input tax (`input_tax`: GST paid on confirmed purchases and expenses) and `net_payable` (net output tax - input tax) are
    tenant-level: for a single outlet or an outlet-restricted user both are null and `warnings` says why."""
    start, end = c.window(d_from, d_to)
    rows = reports.vat_by_rate(c, start, end)
    by_rate = [{"code": x["code"], "rate_percent": x["rate_percent"].quantize(PAISA), "taxable_value": q2(x["net"]),
                "tax": q2(x["vat"]), "cgst": None, "sgst": None, "igst": None, "gross": q2(x["gross"])} for x in rows]
    n_bills = c.db.scalar(select(func.count(Bill.id)).where(
        Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end)) or 0
    ref_tax, ref_base = c.db.execute(select(func.coalesce(func.sum(Refund.tax_amount), 0),
                                            func.coalesce(func.sum(Refund.amount - Refund.tax_amount), 0)).where(
        Refund.restaurant_id == c.rid, c.sc(Refund), Refund.kind == "refund", Refund.created_at >= start, Refund.created_at < end)).one()
    totals = {k: sum((r[k] for r in by_rate), Z) for k in ("taxable_value", "tax", "gross")}
    totals.update(cgst=None, sgst=None, igst=None, bills=n_bills, credit_note_tax=q2(ref_tax),
                  credit_note_taxable_value=q2(ref_base), net_tax=totals["tax"] - q2(ref_tax))
    warnings: list[str] = []
    registered = bool(c.db.get(Restaurant, c.rid).vat_registered)
    if c.covers_tenant():
        inp = input_tax(c, d_from, d_to, registered, warnings)
        net_payable = q2(totals["net_tax"] - inp["total"])
    else:
        inp, net_payable = None, None
        warnings.append("Input tax is recorded for the whole restaurant (purchases and expenses carry no outlet), so it and the "
                        "net payable are not shown for a single outlet.")
    return {**c.meta("gst_summary", d_from, d_to), "tax_label": c.tax_number_label, "by_rate": by_rate, "totals": totals,
            "split_available": False, "input_tax": inp, "net_payable": net_payable, "warnings": warnings,
            "note": "Tax by rate from invoice snapshots; credit-note tax is shown apart (by credit-note date, not netted per rate). "
                    "CGST/SGST/IGST are null: the split, HSN/SAC codes and place of supply are not recorded. net_payable = net "
                    "output tax - input tax (negative: more input tax than output tax). Indicative only; confirm with your "
                    "accountant before filing."}


# ------------------------------------------------------------------------------------------------ 2. payments
def unpaid_bills(c: Ctx, start: datetime, end: datetime) -> list:
    """THE definition of "a bill waiting for payment", shared by Orders, Reports > Payments and Reports > Leakage: a bill that was
    generated (status active: not voided, not replaced by an amendment) and is not fully paid (total - payments > 0), sold inside
    [start, end) (the restaurant-local day window of Ctx.window), in the outlets of the report. Rows: id, invoice_number, total,
    balance, paid (None when nothing was paid), sale_at, finalized_at, finalized_by, customer_name; biggest balance first."""
    paid = (select(Payment.bill_id, func.sum(Payment.amount).label("paid")).where(Payment.restaurant_id == c.rid, c.sc(Payment))
            .group_by(Payment.bill_id).subquery())
    bal = (Bill.total - func.coalesce(paid.c.paid, 0)).label("balance")
    return c.db.execute(select(Bill.id, Bill.invoice_number, Bill.total, bal, paid.c.paid, Bill.sale_at, Bill.finalized_at,
                               Bill.finalized_by, Bill.customer_name)
                        .outerjoin(paid, paid.c.bill_id == Bill.id)
                        .where(Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start,
                               Bill.sale_at < end, bal > 0).order_by(bal.desc(), Bill.invoice_number)).all()


def payments_report(c: Ctx, d_from: date, d_to: date) -> dict:
    """Money in by payment method and by cashier (the user who took the payment), from Payment.created_at. Sales, voids and
    unpaid bills are reported apart (they are not takings): `sales_by_cashier` (active bills by sale date, by the biller),
    `voided` (cancelled orders) and `unpaid` (active bills with an open balance). Unknown methods (e.g. 'upi') are listed as
    they are stored; credit_note settlements are transfers, not takings."""
    start, end = c.window(d_from, d_to)
    method = cast(Payment.method, String)
    pay = c.db.execute(select(Payment.created_by, method, func.count(Payment.id), func.count(func.distinct(Payment.bill_id)),
                              func.sum(Payment.amount))
                       .where(Payment.restaurant_id == c.rid, c.sc(Payment), Payment.created_at >= start, Payment.created_at < end)
                       .group_by(Payment.created_by, method)).all()
    ref = c.db.execute(select(Refund.created_by, func.count(Refund.id), func.sum(Refund.amount)).where(
        Refund.restaurant_id == c.rid, c.sc(Refund), Refund.kind == "refund", Refund.created_at >= start, Refund.created_at < end)
        .group_by(Refund.created_by)).all()
    # money handed back to the customer when a bill was corrected (kept on the credit note, not as a negative payment): the X / Z report nets it off
    payouts = c.db.scalar(select(func.coalesce(func.sum(Refund.payout_amount), 0)).where(
        Refund.restaurant_id == c.rid, c.sc(Refund), Refund.kind == "amendment", Refund.payout_amount > 0,
        Refund.created_at >= start, Refund.created_at < end))
    sales = c.db.execute(select(Bill.finalized_by, func.count(Bill.id), func.sum(Bill.total)).where(
        Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end)
        .group_by(Bill.finalized_by)).all()
    by_biller: dict = {}
    for r in unpaid_bills(c, start, end):
        n, v = by_biller.get(r.finalized_by, (0, Z))
        by_biller[r.finalized_by] = (n + 1, v + _f(r.balance))
    unpaid = [(u, n, v) for u, (n, v) in by_biller.items()]
    void_by: dict = {}
    for o in order_kinds.cancelled_orders(c, start, end):  # the shared definition (merged orders are not cancellations)
        n, v = void_by.get(o.cancelled_by, (0, Z))
        void_by[o.cancelled_by] = (n + 1, v + _f(o.value))
    void = [(u, n, v) for u, (n, v) in void_by.items()]
    names = _names(c, [r[0] for r in pay] + [r[0] for r in ref] + [r[0] for r in sales] + [r[0] for r in unpaid] + [r[0] for r in void])

    by_method: dict[str, dict] = {}
    cashiers: dict = {}
    transfers = Z
    for uid, m, n, nb, amt in pay:
        if m in TRANSFER_METHODS:
            transfers += _f(amt)
            continue
        a = by_method.setdefault(m, {"method": m, "payments": 0, "amount": Z})
        a["payments"] += n
        a["amount"] += _f(amt)
        k = cashiers.setdefault(uid, {"user_id": uid, "name": names.get(uid, "(unknown)"), "payments": 0, "total": Z, "by_method": {}})
        k["payments"] += n
        k["total"] += _f(amt)
        k["by_method"][m] = k["by_method"].get(m, Z) + _f(amt)
    refunds_by = {uid: (n, _f(a)) for uid, n, a in ref}
    for uid in refunds_by:
        cashiers.setdefault(uid, {"user_id": uid, "name": names.get(uid, "(unknown)"), "payments": 0, "total": Z, "by_method": {}})
    total_in = sum((a["amount"] for a in by_method.values()), Z)
    total_ref = sum((v[1] for v in refunds_by.values()), Z)
    out_cashiers = []
    for k in sorted(cashiers.values(), key=lambda k: (-k["total"], k["name"], str(k["user_id"]))):
        rn, ra = refunds_by.get(k["user_id"], (0, Z))
        out_cashiers.append({**k, "user_id": str(k["user_id"]), "total": q2(k["total"]),
                             "by_method": {m: q2(v) for m, v in sorted(k["by_method"].items())},
                             "refunds_count": rn, "refunds": q2(ra), "net_collected": q2(k["total"] - ra)})

    def per_user(rows, label):
        return sorted(({"user_id": str(u), "name": names.get(u, "(unknown)"), "count": n, label: q2(v)} for u, n, v in rows),
                      key=lambda x: (-x[label], x["name"], x["user_id"]))
    return {**c.meta("payments", d_from, d_to),
            "by_method": [{**a, "amount": q2(a["amount"]), "share_percent": _pct(a["amount"], total_in)}
                          for a in sorted(by_method.values(), key=lambda a: (-a["amount"], a["method"]))],
            "by_cashier": out_cashiers,
            "totals": {"collected": q2(total_in), "refunds": q2(total_ref), "correction_payouts": q2(payouts),
                       "net_collected": q2(total_in - total_ref - _f(payouts)), "credit_note_transfers": q2(transfers)},
            "sales_by_cashier": per_user(sales, "gross_total"),
            "voided": {"orders": sum(n for _, n, _ in void), "value": q2(sum((_f(v) for _, _, v in void), Z)),
                       "by_user": per_user(void, "value")},
            "unpaid": {"bills": sum(n for _, n, _ in unpaid), "balance": q2(sum((_f(v) for _, _, v in unpaid), Z)),
                       "by_user": per_user(unpaid, "balance")},
            "note": "Payments by the payment's own time and the user who took it; sales by sale date and the biller. Voided "
                    "(cancelled orders) and unpaid (open balance) are not takings and not in collected. credit_note settlements "
                    "are transfers between a corrected bill and its replacement and are excluded from collected."}


# ------------------------------------------------------------------------------------------------ 3. period sales
def period_sales(c: Ctx, d_from: date, d_to: date, group_by: str = "day") -> dict:
    """Daily or monthly sales summary (local calendar): bills, subtotal, tax, gross, discounts, service charge, refunds by their
    own date, net = gross - refunds, average bill."""
    if group_by not in ("day", "month"):
        raise HTTPException(422, "group_by must be day or month")
    start, end = c.window(d_from, d_to)
    fmt = "YYYY-MM-DD" if group_by == "day" else "YYYY-MM"
    key = func.to_char(func.timezone(c.tz, Bill.sale_at), fmt)
    rows = c.db.execute(select(key, func.count(Bill.id), func.sum(Bill.subtotal), func.sum(Bill.tax_amount), func.sum(Bill.total),
                               func.sum(Bill.discount_amount), func.sum(Bill.service_charge_amount))
                        .where(Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end)
                        .group_by(key).order_by(key)).all()
    rkey = func.to_char(func.timezone(c.tz, Refund.created_at), fmt)
    refunds = dict(c.db.execute(select(rkey, func.sum(Refund.amount)).where(
        Refund.restaurant_id == c.rid, c.sc(Refund), Refund.kind == "refund", Refund.created_at >= start, Refund.created_at < end)
        .group_by(rkey)).all())
    keys = sorted({r[0] for r in rows} | set(refunds))
    by = {r[0]: r for r in rows}
    periods = []
    for k in keys:
        _, n, sub, vat, tot, disc, sc = by.get(k, (k, 0, 0, 0, 0, 0, 0))
        periods.append({"period": k, "bills": n, "subtotal": q2(sub), "tax": q2(vat), "gross_total": q2(tot), "discounts": q2(disc),
                        "service_charge": q2(sc), "refunds": q2(refunds.get(k)), "net_total": q2(_f(tot) - _f(refunds.get(k))),
                        "average_bill": q2(_f(tot) / n) if n else Z})
    totals = {f: sum((p[f] for p in periods), Z) for f in ("subtotal", "tax", "gross_total", "discounts", "service_charge", "refunds", "net_total")}
    totals["bills"] = sum(p["bills"] for p in periods)
    totals["average_bill"] = q2(totals["gross_total"] / totals["bills"]) if totals["bills"] else Z
    return {**c.meta("period_sales", d_from, d_to), "group_by": group_by, "periods": periods, "totals": totals,
            "note": "By sale date in the restaurant's local time; refunds by refund date (a month with only refunds still appears)."}


# ------------------------------------------------------------------------------------------------ 4. item ranking
def item_ranking(c: Ctx, d_from: date, d_to: date, direction: str = "top", by: str = "revenue", limit: int = 20,
                 offset: int = 0) -> dict:
    """Items ranked by quantity or net revenue (excl. tax, after discount). Grouped by menu item id (a renamed item stays one
    row, shown with its latest description); lines without an item id group by description. `bottom` ranks only items that
    sold in the period (an unsold item has no bill line). Paged: limit 1-200, offset."""
    if direction not in ("top", "bottom") or by not in ("revenue", "quantity"):
        raise HTTPException(422, "direction must be top|bottom and by must be revenue|quantity")
    start, end = c.window(d_from, d_to)
    qty = func.sum(BillLine.quantity)
    rev = func.sum(func.coalesce(BillLine.net_amount, BillLine.line_total))
    gkey = func.coalesce(cast(BillLine.item_id, String), "d:" + BillLine.description)
    metric = rev if by == "revenue" else qty
    order = (metric.desc() if direction == "top" else metric.asc(), gkey)
    base = [Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end]
    total_items = c.db.scalar(select(func.count(func.distinct(gkey))).select_from(BillLine).join(Bill, Bill.id == BillLine.bill_id).where(*base)) or 0
    limit, offset = min(max(limit, 1), 200), max(offset, 0)
    rows = c.db.execute(select(gkey, func.max(BillLine.description), qty, rev).join(Bill, Bill.id == BillLine.bill_id).where(*base)
                        .group_by(gkey).order_by(*order).limit(limit).offset(offset)).all()
    return {**c.meta("item_ranking", d_from, d_to), "direction": direction, "by": by, "limit": limit, "offset": offset,
            "total_items": total_items,
            "items": [{"rank": offset + i + 1, "item": n, "quantity": int(q), "revenue_excl_tax": q2(r)} for i, (_, n, q, r) in enumerate(rows)],
            "note": "Net revenue excludes tax and bill discounts (service charge not included), from finalized invoices only."}


# ------------------------------------------------------------------------------------------------ 5. outlet comparison
def outlet_comparison(c: Ctx, d_from: date, d_to: date) -> dict:
    """Per outlet the user can access: bills, gross, refunds, net, average bill, discount %, refund %, rank by net. Each outlet's
    range is its OWN local calendar (Outlet.timezone). All amounts are INR."""
    q = select(Outlet).where(Outlet.restaurant_id == c.rid)
    if c.outlet_ids is not None:
        q = q.where(Outlet.id.in_(c.outlet_ids))
    outs = list(c.db.scalars(q.order_by(Outlet.is_default.desc(), Outlet.created_at, Outlet.code)))
    wins = {o.id: c.window(d_from, d_to, o.timezone) for o in outs}
    if not outs:
        return {**c.meta("outlet_comparison", d_from, d_to), "outlets": [], "totals": None}
    b_cond = or_(*[and_(Bill.outlet_id == o, Bill.sale_at >= s, Bill.sale_at < e) for o, (s, e) in wins.items()])
    r_cond = or_(*[and_(Refund.outlet_id == o, Refund.created_at >= s, Refund.created_at < e) for o, (s, e) in wins.items()])
    bills = {o: (n, g, d) for o, n, g, d in c.db.execute(select(Bill.outlet_id, func.count(Bill.id), func.sum(Bill.total), func.sum(Bill.discount_amount))
                                                          .where(Bill.restaurant_id == c.rid, Bill.status == "active", b_cond).group_by(Bill.outlet_id))}
    refs = dict(c.db.execute(select(Refund.outlet_id, func.sum(Refund.amount)).where(
        Refund.restaurant_id == c.rid, Refund.kind == "refund", r_cond).group_by(Refund.outlet_id)).all())
    rows = []
    for o in outs:
        n, g, d = bills.get(o.id, (0, 0, 0))
        rf = _f(refs.get(o.id))
        rows.append({"outlet_id": str(o.id), "outlet": o.name, "code": o.code, "timezone": o.timezone, "currency": o.currency,
                     "bills": n, "gross_total": q2(g), "refunds": q2(rf), "net_total": q2(_f(g) - rf),
                     "average_bill": q2(_f(g) / n) if n else Z, "discounts": q2(d),
                     "discount_percent": _pct(d, _f(g) + _f(d)), "refund_percent": _pct(rf, g)})
    rows.sort(key=lambda r: (-r["net_total"], r["outlet"], r["outlet_id"]))
    for i, r in enumerate(rows):
        r["rank"] = i + 1
    totals = {k: sum((r[k] for r in rows), Z) for k in ("gross_total", "refunds", "net_total", "discounts")}
    totals["bills"] = sum(r["bills"] for r in rows)
    return {**c.meta("outlet_comparison", d_from, d_to), "outlets": rows, "totals": totals,
            "note": "Gross = what customers paid per active bill (sale date); net = gross - refunds (refund date). discount_percent "
                    "is discounts / (gross + discounts). Food cost and margin are not shown: stock and recipes carry no outlet."}
