"""End-of-day reports: X report (mid-day, not stored) and Z report (closes the trading period, stored immutably).

SEMANTICS (also in README "End of day"):
  * Period: [period_from, period_to). A Z report covers everything since the previous Z closed (its period_to), up to
    the instant it is closed - NOT midnight to midnight. The first Z starts at the restaurant's first recorded
    activity. An X report is the same period up to "now" and is never stored: it shows exactly what the next Z close will save
    (`close_period` says from when and over how many days, `period.basis` is last_z or first_activity).
  * Sales: finalized invoices, by `finalized_at`. Payments / refunds by their own `created_at`. Voids: orders
    cancelled (`cancelled_at`) in the period.
  * Amounts (INR) are in the restaurant's price basis: tax-inclusive when prices include tax, otherwise net of tax.
  * Tax table (`summary.vat`, the GST block of the slip): per rate `base` = TAXABLE VALUE (net of tax, as on the invoice),
    `vat` = the tax, `gross` = base + vat (what the customer paid), in both price modes. Returns and corrections are rows with the
    same three figures. (Before 2026-11 `base` was the gross amount on tax-inclusive bills; `upgrade_tax_table` converts old
    stored snapshots when they are read or reprinted.) NET SALES stays in the price basis.
  * grand_total (sum of the category sales, before bill discounts) - bill discounts - returns + charges = net_sales.
    Prices exclusive of tax: total_takings = net_sales + tax; inclusive (or not GST registered): takings = net_sales.
  * Payments are cash-in per method for payments created in the period; refunds are NOT netted off them but shown
    as GROSS RETURNS. So payments equal takings only when every bill is settled in the same period and nothing is
    refunded - the difference is reported in `checks_info`, never hidden.
  * Corrections (services/amend.py): a bill corrected in this period is a credit note (kind 'amendment') + a replacement
    bill, both POSTED in this period. The replacement is an ordinary bill of the period (category/channel sales, tax
    table); the cancelled original stays in the period it was posted in (closed Z reports never change) and its
    REVERSAL is deducted here ("CORRECTIONS (REVERSED)", `corrections` block with a line per amendment). So this
    period's NET SALES / TAX carry exactly the delta (replacement - original). Credit-note payments are transfers
    between versions (net zero, not counted); money handed back at a correction reduces the cash/card payments.
  * Concurrency: bill finalization, payments, refunds and order cancellation take a SHARED advisory lock and stamp
    their own time after it; a Z close takes the same lock EXCLUSIVELY, then reads the clock. Hence every record
    falls into exactly one period (see billing.lock_activity).
"""
import re
import uuid
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, literal, select, text, true, update
from sqlalchemy.orm import Session, aliased

from app.models.core import (
    AuditLog, Bill, InvoiceSequence, Order, OrderLine, OrderStatus, Outlet, Payment, PaymentMethod, Refund, Restaurant, User, ZReport,
)
from app.services import audit, billing, money, outlets, reports
from app.services import thermal as T

ZERO = Decimal("0.00")
PAISA = Decimal("0.01")
TILL = "ALL TILLS"
TOLERANCE = Decimal("0.005")


def q2(x) -> Decimal:
    return Decimal(x or 0).quantize(PAISA)


def number_label(number: int) -> str:
    return f"Z{number}"


# ------------------------------------------------------------------ period
def first_activity(db: Session, rid: uuid.UUID, oid: uuid.UUID) -> datetime:
    """Start of the very first period of an OUTLET: its earliest bill / order / payment / refund / cancellation, else
    when the outlet was created."""
    cands = [
        db.scalar(select(func.min(Bill.finalized_at)).where(Bill.restaurant_id == rid, Bill.outlet_id == oid)),
        db.scalar(select(func.min(Order.created_at)).where(Order.restaurant_id == rid, Order.outlet_id == oid)),
        db.scalar(select(func.min(Order.cancelled_at)).where(Order.restaurant_id == rid, Order.outlet_id == oid)),
        db.scalar(select(func.min(Payment.created_at)).where(Payment.restaurant_id == rid, Payment.outlet_id == oid)),
        db.scalar(select(func.min(Refund.created_at)).where(Refund.restaurant_id == rid, Refund.outlet_id == oid)),
    ]
    cands = [c for c in cands if c is not None]
    if cands:
        return min(cands)
    default = db.scalar(select(Outlet).where(Outlet.id == oid))
    # the default outlet falls back to the restaurant's creation (as before outlets); another outlet to its own creation
    return db.get(Restaurant, rid).created_at if default is None or default.is_default else default.created_at


def last_z(db: Session, rid: uuid.UUID, oid: uuid.UUID) -> ZReport | None:
    return db.scalar(select(ZReport).where(ZReport.restaurant_id == rid, ZReport.outlet_id == oid)
                     .order_by(ZReport.number.desc()).limit(1))


def current_period_start(db: Session, rid: uuid.UUID, oid: uuid.UUID) -> datetime:
    z = last_z(db, rid, oid)
    return z.period_to if z else first_activity(db, rid, oid)


def period_start(db: Session, rid: uuid.UUID, oid: uuid.UUID) -> tuple[datetime, str]:
    """(start, basis) of the open period of an outlet: since the last Z close ('last_z'); an outlet that never closed one starts at its
    first activity ('first_activity'). The X report and the next Z close use exactly this start, so what the owner reviews in the X
    report is what the Z close saves (INDEPENDENT_REVIEW_REPORT.md H2)."""
    z = last_z(db, rid, oid)
    return (z.period_to, "last_z") if z else (first_activity(db, rid, oid), "first_activity")


# ------------------------------------------------------------------ computation
def _ox(model, oid):
    """Outlet filter of a report query: one outlet id, a list of them, or None = every outlet of the restaurant."""
    if oid is None:
        return true()
    return model.outlet_id.in_(oid) if isinstance(oid, (list, tuple, set)) else model.outlet_id == oid


def _clean_reason(reason: str | None) -> str:
    r = " ".join((reason or "").split())
    if not r:
        return "Discount"
    return r.title() if (r.islower() or r.isupper()) else r


# ------------------------------------------------------------------ SQL aggregation of the period
# The X report and the Z close run the same `compute`, so both read the period through these queries. Nothing here loads a bill, a bill line or
# an order line into Python: the database sums them (exact numeric, so the figures are the same as adding the rows one by one), and only the
# per-refund / per-correction / per-void rows that the report lists one by one come back as rows.
def _oids(oid) -> list | None:
    """`oid` of compute() as a list of outlet ids; None = every outlet of the restaurant."""
    if oid is None:
        return None
    return list(oid) if isinstance(oid, (list, tuple, set)) else [oid]


def _outlet_sql(alias: str, oid, params: dict) -> str:
    oids = _oids(oid)
    if oids is None:
        return ""
    params["oids"] = oids
    return f" AND {alias}.outlet_id = ANY(CAST(:oids AS uuid[]))"


# a bill without a tax snapshot (before tax_breakdown existed; NULL, JSON null or an empty list) counts as one standard-rate row
_NO_BREAKDOWN = ("(b.tax_breakdown IS NULL OR CASE json_typeof(b.tax_breakdown) WHEN 'array' THEN json_array_length(b.tax_breakdown) = 0 "
                 "ELSE json_typeof(b.tax_breakdown) = 'null' END)")
_ORDER_TYPE = "COALESCE(b.order_type, (SELECT CAST(o.order_type AS VARCHAR) FROM orders o WHERE o.id = b.order_id))"

_BILLS_SQL = f"""
SELECT {_ORDER_TYPE} AS order_type,
       CASE WHEN b.discount_amount > 0 THEN b.discount_reason END AS reason, (b.discount_amount > 0) AS has_discount,
       count(*) AS n, COALESCE(sum(b.total), 0) AS total, COALESCE(sum(b.tax_amount), 0) AS tax, COALESCE(sum(b.round_off), 0) AS round_off,
       COALESCE(sum(b.packaging_amount + b.delivery_amount), 0) AS charges,
       count(*) FILTER (WHERE b.packaging_amount <> 0 OR b.delivery_amount <> 0) AS charges_count,
       COALESCE(sum(b.service_charge_amount) FILTER (WHERE b.service_charge_amount > 0), 0) AS sc_total,
       count(*) FILTER (WHERE b.service_charge_amount > 0) AS sc_count,
       COALESCE(sum(b.discount_amount) FILTER (WHERE b.discount_amount > 0), 0) AS disc_total,
       COALESCE(sum(b.tax_amount) FILTER (WHERE NOT b.prices_include_tax), 0) AS vat_added,
       count(*) FILTER (WHERE NOT b.prices_include_tax) AS n_exclusive, count(*) FILTER (WHERE b.prices_include_tax) AS n_inclusive,
       COALESCE(bool_or(b.vat_registered AND b.tax_amount <> 0), false) AS registered_taxed,
       count(*) FILTER (WHERE {_NO_BREAKDOWN}) AS no_breakdown, min(b.finalized_at) AS first_at
FROM bills b
WHERE b.restaurant_id = :rid AND b.finalized_at >= :start AND b.finalized_at < :end{{outlet}}
GROUP BY 1, 2, 3"""

# one row per (tax code, rate): the sum of that rate's rows over every bill's snapshot (a bill without one: its own totals as one row).
# The snapshot is converted to jsonb once per bill (the `json` column would be re-parsed for every field).
_TAX_SQL = """
SELECT x.code, x.rate_percent AS rate, sum(x.net) AS net, sum(x.vat) AS vat, sum(x.gross) AS gross,
       sum(CASE WHEN b.prices_include_tax THEN x.gross ELSE x.net END) AS basis
FROM bills b
CROSS JOIN LATERAL (SELECT b.tax_breakdown::jsonb AS j) q
CROSS JOIN LATERAL jsonb_to_recordset(
    CASE WHEN q.j IS NULL OR (CASE jsonb_typeof(q.j) WHEN 'array' THEN jsonb_array_length(q.j) = 0 ELSE jsonb_typeof(q.j) = 'null' END)
         THEN jsonb_build_array(jsonb_build_object('code', 'standard', 'rate_percent', b.tax_rate_percent, 'net', b.subtotal,
                                                   'vat', b.tax_amount, 'gross', b.total))
         ELSE q.j END)
     AS x(code text, rate_percent numeric, net numeric, vat numeric, gross numeric)
WHERE b.restaurant_id = :rid AND b.finalized_at >= :start AND b.finalized_at < :end{outlet}
GROUP BY x.code, x.rate_percent"""


def _bill_aggregates(db: Session, rid: uuid.UUID, oid, start: datetime, end: datetime) -> dict:
    """Everything `compute` needs from the bills FINALIZED in [start, end) (outlet filter as `_ox`), summed by the database."""
    params = {"rid": rid, "start": start, "end": end}
    outlet = _outlet_sql("b", oid, params)
    B = {"n": 0, "total": ZERO, "tax": ZERO, "round_off": ZERO, "charges": ZERO, "charges_count": 0, "sc_total": ZERO, "sc_count": 0,
         "disc_total": ZERO, "vat_added": ZERO, "n_exclusive": 0, "n_inclusive": 0, "registered_taxed": False, "no_breakdown": 0,
         "orders_by_type": {}}
    by_reason: list = []
    for g in db.execute(text(_BILLS_SQL.format(outlet=outlet)), params).mappings():
        B["n"] += g["n"]
        B["orders_by_type"][g["order_type"]] = B["orders_by_type"].get(g["order_type"], 0) + g["n"]
        for k in ("total", "tax", "round_off", "charges", "sc_total", "disc_total", "vat_added"):
            B[k] += g[k]
        for k in ("charges_count", "sc_count", "n_exclusive", "n_inclusive", "no_breakdown"):
            B[k] += g[k]
        B["registered_taxed"] = B["registered_taxed"] or g["registered_taxed"]
        if g["has_discount"]:
            by_reason.append((g["first_at"], g))
    # bill discounts by reason: reasons that clean to the same text are one line; its name is the first bill's (by time) spelling
    named: dict[str, dict] = {}
    for _, g in sorted(by_reason, key=lambda t: t[0]):
        name = _clean_reason(g["reason"])
        a = named.setdefault(name.casefold(), {"reason": name, "count": 0, "amount": ZERO})
        a["count"] += g["n"]
        a["amount"] += g["disc_total"]
    B["discounts"] = sorted(({**a, "amount": q2(a["amount"])} for a in named.values()), key=lambda a: a["reason"])

    # tax table: base = taxable value, vat, gross; `basis_total` the same in the restaurant's price basis
    acc: dict[tuple[str, Decimal], dict] = {}
    basis_total = ZERO
    for row in db.execute(text(_TAX_SQL.format(outlet=outlet)), params).mappings():
        key = (row["code"], Decimal(str(row["rate"])))
        a = acc.setdefault(key, {"code": key[0], "rate_percent": key[1], "base": ZERO, "vat": ZERO, "gross": ZERO})
        a["base"] += row["net"]
        a["vat"] += row["vat"]
        a["gross"] += row["gross"]
        basis_total += row["basis"]
    B["vat_rows"] = [{"code": a["code"], "rate_percent": a["rate_percent"].quantize(PAISA), "base": q2(a["base"]),
                      "vat": q2(a["vat"]), "gross": q2(a["gross"])}
                     for a in sorted(acc.values(), key=lambda a: (a["rate_percent"], a["code"]))]
    B["basis_total"] = basis_total
    return B


def _voids(db: Session, rid: uuid.UUID, oid, start: datetime, end: datetime, tz: ZoneInfo) -> list[dict]:
    """Orders cancelled in [start, end), one row each (the report lists them) with the value of their lines summed by the database."""
    rows = db.execute(
        select(Order.id, Order.order_type, Order.cancelled_at, Order.cancel_reason,
               func.coalesce(func.sum(OrderLine.unit_price * OrderLine.quantity), 0))
        .outerjoin(OrderLine, OrderLine.order_id == Order.id)
        .where(Order.restaurant_id == rid, _ox(Order, oid), Order.status == OrderStatus.cancelled,
               Order.merged_into_order_id.is_(None),  # a merge moves the lines to another order: not a void
               Order.cancelled_at >= start, Order.cancelled_at < end)
        .group_by(Order.id).order_by(Order.cancelled_at, Order.id)).all()
    return [{"order_ref": _ref(i), "order_id": str(i), "order_type": t.value, "cancelled_at": at.astimezone(tz), "reason": reason,
             "amount": q2(amount)} for i, t, at, reason, amount in rows]


def _open_orders(db: Session, rid: uuid.UUID, oid, end: datetime) -> tuple[int, Decimal]:
    """(count, value of the lines) of the orders still open / at the kitchen at `end`, whenever they were started."""
    n, value = db.execute(
        select(func.count(func.distinct(Order.id)), func.coalesce(func.sum(OrderLine.unit_price * OrderLine.quantity), 0))
        .outerjoin(OrderLine, OrderLine.order_id == Order.id)
        .where(Order.restaurant_id == rid, _ox(Order, oid), Order.created_at < end,
               Order.status.in_((OrderStatus.open, OrderStatus.sent_to_kitchen)))).one()
    return n, q2(value)


def _unpaid(db: Session, rid: uuid.UUID, oid, start: datetime, end: datetime) -> tuple[int, Decimal, int, Decimal, Decimal]:
    """(count, balance) of the ACTIVE bills finalized before `end` that still have a balance at `end` (whenever they were issued), the count and
    the part of that balance that belongs to bills of this period, and the unpaid balance of the bills of this period that a correction
    superseded (settled by its credit note, not outstanding)."""
    paid_to = (select(Payment.bill_id, func.sum(Payment.amount).label("paid"))
               .where(Payment.restaurant_id == rid, _ox(Payment, oid), Payment.created_at < end).group_by(Payment.bill_id).subquery())
    bal = Bill.total - func.coalesce(paid_to.c.paid, 0)
    active = Bill.status == "active"
    this_period = Bill.finalized_at >= start
    n, total, n_period, in_period, superseded = db.execute(
        select(func.count().filter(active), func.coalesce(func.sum(bal).filter(active), 0), func.count().filter(active & this_period),
               func.coalesce(func.sum(bal).filter(active & this_period), 0),
               func.coalesce(func.sum(bal).filter((Bill.status == "superseded") & this_period), 0))
        .select_from(Bill).outerjoin(paid_to, paid_to.c.bill_id == Bill.id)
        .where(Bill.restaurant_id == rid, _ox(Bill, oid), Bill.finalized_at < end, bal > 0,
               Bill.status.in_(("active", "superseded")))).one()
    return n, q2(total), n_period, q2(in_period), q2(superseded)



def _settlements(db: Session, rid: uuid.UUID, oid, start: datetime, end: datetime) -> tuple[int, Decimal, Decimal]:
    """(bills, amount) of the money received in [start, end) for bills finalized BEFORE `start` (settled in another period), and the credit-note
    settlements (transfers between a corrected bill and its replacement, not money) of the bills of this period."""
    n, amount = db.execute(
        select(func.count(func.distinct(Payment.bill_id)), func.coalesce(func.sum(Payment.amount), 0))
        .join(Bill, Bill.id == Payment.bill_id)
        .where(Payment.restaurant_id == rid, _ox(Payment, oid), Payment.created_at >= start, Payment.created_at < end,
               Payment.method != PaymentMethod.credit_note, Bill.finalized_at < start)).one()
    credit_notes = db.scalar(
        select(func.coalesce(func.sum(Payment.amount), 0)).join(Bill, Bill.id == Payment.bill_id)
        .where(Bill.restaurant_id == rid, _ox(Bill, oid), Bill.finalized_at >= start, Bill.finalized_at < end,
               Payment.created_at < end, Payment.method == PaymentMethod.credit_note))
    return n, q2(amount), q2(credit_notes)


_GAP_CAUSES = (  # (code, label, sign of the amount in "payments - billed")
    ("unpaid_bills", "Unpaid bills of this period (billed, not yet paid)"),
    ("settled_other_period", "Money received now for bills of an earlier period"),
    ("refunds", "Refunds paid out (the amount billed is net of them, the payments are not)"),
    ("corrections", "Corrected bills (reversed originals, money handed back, credit-note settlements)"),
    ("voided_bills", "Bills voided in this period"),
)


def _payments_gap(diff: Decimal, **parts: tuple[int, Decimal]) -> dict:
    """Why PAYMENTS differ from the amount BILLED (`diff` = payments - billed), cause by cause, each with the amount it contributes to `diff`
    (signed: unpaid bills and voids pull it negative, money for older bills and refunds push it positive) and how many bills / refunds it
    is. Only causes that exist are listed; whatever the listed causes do not add up to is `unexplained` (0 when the books are consistent),
    never blamed on a generic cause."""
    signed = {"unpaid_bills": -1, "settled_other_period": 1, "refunds": 1, "corrections": 1, "voided_bills": -1}
    key = {"unpaid_bills": "unpaid", "settled_other_period": "other_period", "refunds": "refunds", "corrections": "corrections", "voided_bills": "voided"}
    causes = []
    for code, label in _GAP_CAUSES:
        n, amount = parts[key[code]]
        amount = q2(signed[code] * amount)
        if n or amount:
            causes.append({"code": code, "label": label, "count": n, "amount": amount})
    unexplained = q2(diff - sum((c["amount"] for c in causes), ZERO))
    return {"difference": q2(diff), "causes": causes, "unexplained": unexplained, "explained": abs(unexplained) < TOLERANCE}


def compute(db: Session, rid: uuid.UUID, start: datetime, end: datetime, kind: str, oid: uuid.UUID | None = None) -> dict:
    """Pure read-only computation of the report of ONE outlet (oid; None = all outlets, used by the insight reports) for [start, end). Decimals; use reports.to_json to serialise."""
    r = db.get(Restaurant, rid)
    tz = ZoneInfo(r.timezone)

    B = _bill_aggregates(db, rid, oid, start, end)

    # ---- channels / categories
    rows = reports.category_rows(db, rid, start, end, oids=(list(oid) if isinstance(oid, (list, tuple, set)) else [oid]) if oid is not None else None)
    orders_by_channel = {k: 0 for k, *_ in reports.CHANNELS}
    for order_type, n in B["orders_by_type"].items():
        orders_by_channel[reports.channel_of(order_type)] += n
    channels = []
    grand = {"orders": B["n"], "items": 0, "disc": ZERO, "sales": ZERO}
    for key, _types, heading, sub in reports.CHANNELS:
        cats = sorted((x for x in rows if x["channel"] == key), key=lambda x: x["category"].upper())
        sub_total = {"orders": orders_by_channel[key], "items": sum(x["quantity"] for x in cats), "disc": ZERO,
                     "sales": sum((x["before_discount"] for x in cats), ZERO)}
        channels.append({
            "key": key, "heading": heading, "label": sub, "orders": orders_by_channel[key],
            "categories": [{"category": x["category"], "items": x["quantity"], "disc": ZERO,
                            "sales": q2(x["before_discount"])} for x in cats],
            "sub_total": {"items": sub_total["items"], "disc": ZERO, "sales": q2(sub_total["sales"])}})
        grand["items"] += sub_total["items"]
        grand["sales"] += sub_total["sales"]
    grand["sales"] = q2(grand["sales"])

    # ---- deductions
    discounts = B["discounts"]
    disc_total, sc_total, sc_count = B["disc_total"], B["sc_total"], B["sc_count"]

    refunds = db.execute(
        select(Refund.id, Refund.credit_note_number, Refund.amount, Refund.tax_amount, Refund.reason,
               Refund.created_at, Bill.prices_include_tax, Bill.invoice_number, Refund.round_off)
        .join(Bill, Bill.id == Refund.bill_id)
        .where(Refund.restaurant_id == rid, _ox(Refund, oid), Refund.kind == "refund", Refund.created_at >= start, Refund.created_at < end)
        .order_by(Refund.created_at)).all()
    corr = _corrections(db, rid, start, end, tz, oid)
    ret_incl = sum((x.amount for x in refunds), ZERO)                   # tax-inclusive, as paid out
    ret_vat = sum((x.tax_amount for x in refunds), ZERO)
    ret_ro = sum((x.round_off for x in refunds), ZERO)                  # India GST credit notes carry their round-off share
    ret_basis = sum(((x.amount if x.prices_include_tax else x.amount - x.tax_amount) - x.round_off for x in refunds), ZERO)
    ret_taxable = ret_incl - ret_vat - ret_ro                           # taxable value of the returns (the amount is tax-inclusive in both modes)
    ro_bills = B["round_off"]                                           # explicit GST round-off line (0 on every other bill)
    chg_total = B["charges"]                                            # GST packaging / delivery charges
    chg_count = B["charges_count"]
    ro_net = ro_bills - ret_ro - corr["rev_ro"]
    ret_vat_added = sum((x.tax_amount for x in refunds if not x.prices_include_tax), ZERO)  # tax on top (exclusive)

    net_sales = grand["sales"] - disc_total - ret_basis - corr["rev_basis"] + sc_total + chg_total
    vat_added = B["vat_added"] - ret_vat_added - corr["rev_vat_added"]
    exclusive_vat = B["n_exclusive"] > 0 or not r.prices_include_tax
    registered = bool(r.vat_registered) or B["registered_taxed"]
    show_vat_line = registered and exclusive_vat
    billed = net_sales + (vat_added if registered else ZERO) + ro_net     # what was INVOICED (net of returns): unpaid bills are in it

    # ---- payments (cash-in by method, created in the period)
    pay = {m: [0, ZERO] for m in PaymentMethod}
    for method, n, amt in db.execute(
            select(Payment.method, func.count(Payment.id), func.sum(Payment.amount))
            .where(Payment.restaurant_id == rid, _ox(Payment, oid), Payment.created_at >= start, Payment.created_at < end,
                   Payment.method != PaymentMethod.credit_note)  # credit-note transfers between versions are net zero
            .group_by(Payment.method)):
        pay[method] = [n, Decimal(amt)]
    for m, amt in corr["payouts"].items():  # money handed back at a correction is a real cash/card movement
        pay[PaymentMethod(m)][1] -= amt
    payments = [{"method": m.value, "count": pay[m][0], "amount": q2(pay[m][1])}
                for m in (PaymentMethod.cash, PaymentMethod.card, PaymentMethod.upi, PaymentMethod.other)
                if m not in (PaymentMethod.other, PaymentMethod.upi) or pay[m][0] or pay[m][1]]
    total_payments = q2(sum((v[1] for v in pay.values()), ZERO))

    # ---- tax table (from the bills' tax_breakdown snapshots; old bills = one standard-rate row).
    # Per rate: base = TAXABLE VALUE (net of tax, as on the invoice), vat = the tax, gross = base + vat (what the customer paid).
    # `basis_total` is the same figure in the restaurant's price basis (gross when prices include tax) and is only used for the
    # check against NET SALES, which is stated in that basis.
    vat_rows = B["vat_rows"]
    basis_total = B["basis_total"]
    vat_returns = {"base": -q2(ret_taxable), "vat": -q2(ret_vat), "gross": -q2(ret_taxable + ret_vat)}
    vat_corrections = {"base": -q2(corr["rev_taxable"]), "vat": -q2(corr["rev_vat"]), "gross": -q2(corr["rev_taxable"] + corr["rev_vat"])}
    vat_total = {k: q2(sum((x[k] for x in vat_rows), ZERO) + vat_returns[k] + vat_corrections[k]) for k in ("base", "vat", "gross")}
    basis_total = q2(basis_total - ret_basis - corr["rev_basis"])

    # ---- voids (orders cancelled in the period) and unsettled items
    void_list = _voids(db, rid, oid, start, end, tz)
    void_total = q2(sum((v["amount"] for v in void_list), ZERO))
    open_count, open_value = _open_orders(db, rid, oid, end)
    unpaid_count, unpaid_total, unpaid_period_count, outstanding_period, sup_unpaid = _unpaid(db, rid, oid, start, end)
    other_period_bills, paid_other_period, credit_note_settled = _settlements(db, rid, oid, start, end)
    paid_period_bills = q2(db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).join(Bill, Bill.id == Payment.bill_id).where(
        Bill.restaurant_id == rid, _ox(Bill, oid), Bill.finalized_at >= start, Bill.finalized_at < end, Payment.created_at < end)))

    # ---- integrity checks (independent sources: bill headers vs line aggregates)
    bills_total = q2(B["total"])
    bills_vat = q2(B["tax"])
    takings_before_returns = q2(grand["sales"] - disc_total + sc_total + chg_total - corr["rev_basis"]
                                + (vat_added + ret_vat_added if registered else ZERO) + ro_bills - corr["rev_ro"])
    bills_total_net = bills_total - corr["rev_total"]
    voided_n, voided_in_period = db.execute(select(func.count(Bill.id), func.coalesce(func.sum(Bill.total), 0)).where(
        Bill.restaurant_id == rid, _ox(Bill, oid), Bill.finalized_at >= start, Bill.finalized_at < end,
        Bill.status == "voided", Bill.voided_at < end)).one()  # sale and void inside the as-of window: net zero
    voided_in_period = q2(voided_in_period)
    price_modes = ({True} if B["n_inclusive"] else set()) | ({False} if B["n_exclusive"] else set())
    checks = {
        "categories_add_up_to_total": sum((c["sub_total"]["sales"] for c in channels), ZERO) == grand["sales"],
        "takings_match_bill_totals": abs(takings_before_returns - bills_total_net) < TOLERANCE,
        "vat_matches_bills": abs(sum((x["vat"] for x in vat_rows), ZERO) - bills_vat) < TOLERANCE,
        "vat_base_equals_net_sales": abs(basis_total - q2(net_sales)) < TOLERANCE,  # tax table (price basis) = net sales
        "net_equals_payments_plus_outstanding": abs(bills_total - (paid_period_bills + outstanding_period + sup_unpaid + voided_in_period)) < TOLERANCE,
        "corrections_match_credit_notes": corr["rev_total"] == corr["cn_total"],
        "single_price_mode": len(price_modes) <= 1 and all(v == r.prices_include_tax for v in price_modes),
    }
    checks["all_ok"] = all(checks.values())
    names = {"categories_add_up_to_total": "category sales do not add up to the total",
             "takings_match_bill_totals": "takings differ from the sum of the invoice totals",
             "vat_matches_bills": "Tax table differs from the tax on the invoices",
             "vat_base_equals_net_sales": "Tax table differs from net sales",
             "net_equals_payments_plus_outstanding": "net sales differ from payments + outstanding balance",
             "corrections_match_credit_notes": "reversed originals differ from the correction credit notes",
             "single_price_mode": "invoices in this period use different price modes (tax inclusive / exclusive)"}
    warnings = [f"CHECK FAILED: {names[k]}" for k, ok in checks.items() if k != "all_ok" and not ok]
    payments_gap = _payments_gap(
        q2(total_payments - billed),
        unpaid=(unpaid_period_count, outstanding_period),
        other_period=(other_period_bills, paid_other_period),
        refunds=(len(refunds), q2(ret_incl)),
        corrections=(len(corr["items"]), q2(corr["rev_total"] - sum(corr["payouts"].values(), ZERO) - sup_unpaid - credit_note_settled)),
        voided=(voided_n, voided_in_period))
    checks_info = {
        "payments_minus_takings": q2(total_payments - billed),   # payments - TOTAL BILLED (kept name); the causes are in payments_gap
        "note": "Payments are cash-in created in this period; refunds are shown under GROSS RETURNS, not netted off. "
                "payments_gap lists, with its own amount, every cause of a difference between the payments and the amount billed.",
        "billed_total": q2(billed),
        "payments_gap": payments_gap,
        "bills_without_tax_breakdown": B["no_breakdown"],
        "bills_total": bills_total,
    }

    empty = not (B["n"] or refunds or void_list or total_payments or corr["items"])
    return {
        "kind": kind, "empty": bool(empty),
        "restaurant": {"name": r.name, "address": r.address, "phone": r.phone, "country": r.country,
                       "tax_number_label": r.tax_number_label, "tax_number": r.trn if r.vat_registered else None,
                       "currency": r.currency, "currency_symbol": r.currency_symbol, "timezone": r.timezone,
                       "prices_include_tax": r.prices_include_tax, "vat_registered": r.vat_registered,
                       "tax_word": money.tax_word(r.tax_mode)},
        "till": TILL,
        "period": {"from": start, "to": end, "from_local": start.astimezone(tz), "to_local": end.astimezone(tz),
                   "timezone": r.timezone},
        "channels": channels, "grand_total": {"orders": grand["orders"], "items": grand["items"], "disc": ZERO,
                                              "sales": grand["sales"]},
        "deductions": {
            "item_discount": ZERO,
            "bill_discounts": {"count": sum(a["count"] for a in discounts), "amount": q2(disc_total), "by_reason": discounts},
            "amendment_reversals": {"count": len(corr["items"]), "amount": q2(corr["rev_basis"])},
            "bill_voids": {"count": sum(1 for i in corr["items"] if i["kind"] == "void"),
                           "amount": q2(sum((i["original_total"] for i in corr["items"] if i["kind"] == "void"), ZERO))},
            "gross_returns": {"count": len(refunds), "amount": q2(ret_basis), "amount_incl_tax": q2(ret_incl),
                              "items": [{"credit_note": x.credit_note_number, "invoice": x.invoice_number,
                                         "amount": q2(x.amount), "reason": x.reason,
                                         "created_at": x.created_at.astimezone(tz)} for x in refunds]},
            "card_commission": ZERO,
            "other_charges": {"service_charge": {"count": sc_count, "amount": q2(sc_total)},
                              "delivery_charge": {"count": 0, "amount": ZERO},
                              "packaging_delivery": {"count": chg_count, "amount": q2(chg_total)},
                              "total": q2(sc_total + chg_total)},
            "round_off": q2(ro_net),
            "net_sales": q2(net_sales),
            "vat": q2(vat_added) if show_vat_line else None,
            "billed_total": q2(billed),
            "total_takings": q2(total_payments - ret_incl),
            "takings": {"payments": total_payments, "refunds_paid": q2(ret_incl), "billed_not_received": q2(billed - (total_payments - ret_incl))},
        },
        "deposits": {"sub_total": ZERO},
        "summary": {
            "gross_sales": grand["sales"], "net_sales": q2(net_sales),
            "service_charge": {"count": sc_count, "amount": q2(sc_total)},
            "delivery_charge": {"count": 0, "amount": ZERO},
            "total_charges": q2(sc_total + chg_total), "round_off": q2(ro_net), "payments": payments, "total_payments": total_payments,
            "vat": {"shown": bool(registered), "rows": vat_rows, "returns": vat_returns, "corrections": vat_corrections,
                    "total": vat_total}
            if registered else {"shown": False, "rows": [], "returns": None, "total": None},
            "voids": {"count": len(void_list), "amount": void_total},
            "deposit_sales": ZERO,
        },
        "corrections": {
            "count": len(corr["items"]), "items": corr["items"],
            "reversed": {"base": q2(corr["rev_basis"]), "taxable": q2(corr["rev_taxable"]), "vat": q2(corr["rev_vat"]),
                         "total": q2(corr["rev_total"])},
            "replacements": {"base": q2(corr["new_basis"]), "taxable": q2(corr["new_taxable"]), "vat": q2(corr["new_vat"]),
                             "total": q2(corr["new_total"])},
            "delta": {"base": q2(corr["new_basis"] - corr["rev_basis"]), "taxable": q2(corr["new_taxable"] - corr["rev_taxable"]),
                      "vat": q2(corr["new_vat"] - corr["rev_vat"]), "total": q2(corr["new_total"] - corr["rev_total"])},
            "payments": [{"method": m, "amount": -q2(a)} for m, a in sorted(corr["payouts"].items())],
        },
        "voids": {"count": len(void_list), "amount": void_total, "orders": void_list},
        "open_items": {"open_orders": {"count": open_count, "amount": open_value},
                       "unpaid_bills": {"count": unpaid_count, "balance": unpaid_total}},
        "checks": checks, "warnings": warnings, "checks_info": checks_info,
    }


def _rate_rows(b) -> dict[tuple[str, Decimal], list[Decimal]]:
    """{(code, rate): [base, vat]} of a bill (base = the taxable value, i.e. net of tax, in both price modes)."""
    brk = b.tax_breakdown or [{"code": "standard", "rate_percent": b.tax_rate_percent, "net": b.subtotal,
                               "vat": b.tax_amount, "gross": b.total}]
    out: dict[tuple[str, Decimal], list[Decimal]] = {}
    for row in brk:
        a = out.setdefault((row["code"], Decimal(str(row["rate_percent"])).quantize(PAISA)), [ZERO, ZERO])
        a[0] += Decimal(str(row["net"]))
        a[1] += Decimal(str(row["vat"]))
    return out


def _corrections(db: Session, rid: uuid.UUID, start: datetime, end: datetime, tz: ZoneInfo, oid: uuid.UUID | None) -> dict:
    """Bill corrections POSTED in [start, end): credit note + replacement (services/amend.py). The period's totals
    carry the replacement bills in full (they are bills posted now) and the REVERSAL of each cancelled original (its
    own sale stays in the old period's report, which is never touched)."""
    Orig, Repl = aliased(Bill), aliased(Bill)
    rows = db.execute(
        select(Refund, Orig, Repl).join(Orig, Orig.id == Refund.bill_id).outerjoin(Repl, Repl.id == Refund.replacement_bill_id)
        .where(Refund.restaurant_id == rid, _ox(Refund, oid), Refund.kind.in_(("amendment", "void")), Refund.created_at >= start, Refund.created_at < end)
        .order_by(Refund.created_at, Refund.credit_note_number)).all()
    # price basis of a bill = its item value after discount + charges, WITHOUT the GST round-off line (the round-off is
    # reversed separately through rev_ro / new_ro): an inclusive bill's total includes it (BREAK_BACKEND_REPORT.md D5)
    basis = lambda b: (b.total - (b.round_off or ZERO)) if b.prices_include_tax else b.subtotal
    c = {"items": [], "rev_ro": ZERO, "new_ro": ZERO, "rev_basis": ZERO, "rev_taxable": ZERO, "new_taxable": ZERO, "rev_vat": ZERO, "rev_total": ZERO, "rev_vat_added": ZERO, "cn_total": ZERO,
         "new_basis": ZERO, "new_vat": ZERO, "new_total": ZERO, "payouts": {}}
    for cn, o, n in rows:
        c["rev_basis"] += basis(o)
        c["rev_taxable"] += o.subtotal  # taxable value (net of tax) in both price modes
        c["rev_vat"] += o.tax_amount
        c["rev_total"] += o.total
        c["rev_ro"] += o.round_off
        c["cn_total"] += cn.amount
        if not o.prices_include_tax:
            c["rev_vat_added"] += o.tax_amount
        if n is not None:  # a void has no replacement invoice: its reversal stands alone
            c["new_ro"] += n.round_off
            c["new_basis"] += basis(n)
            c["new_taxable"] += n.subtotal
            c["new_vat"] += n.tax_amount
            c["new_total"] += n.total
        n_total, n_vat, n_basis = (n.total, n.tax_amount, basis(n)) if n is not None else (ZERO, ZERO, ZERO)
        ro, rn = _rate_rows(o), (_rate_rows(n) if n is not None else {})
        by_rate = []
        for k in sorted(set(ro) | set(rn), key=lambda k: (k[1], k[0])):
            bo, bn = ro.get(k, [ZERO, ZERO]), rn.get(k, [ZERO, ZERO])
            by_rate.append({"code": k[0], "rate_percent": k[1], "base_delta": q2(bn[0] - bo[0]), "vat_delta": q2(bn[1] - bo[1]),
                             "gross_delta": q2(bn[0] + bn[1] - bo[0] - bo[1])})
        payout = None
        if cn.kind == "void":  # the money handed back is already in the period's payments (negative payment rows)
            payout = {"method": cn.payout_method, "amount": q2(cn.payout_amount)} if cn.payout_amount > 0 else None
        elif cn.payout_amount and cn.payout_amount > 0 and cn.payout_method:
            c["payouts"][cn.payout_method] = c["payouts"].get(cn.payout_method, ZERO) + cn.payout_amount
            payout = {"method": cn.payout_method, "amount": q2(cn.payout_amount)}
        c["items"].append({
            "credit_note": cn.credit_note_number, "original_invoice": o.invoice_number, "replacement_invoice": n.invoice_number if n is not None else None,
            "kind": cn.kind,
            "reason": cn.reason, "original_total": q2(o.total), "new_total": q2(n_total), "delta_total": q2(n_total - o.total),
            "original_vat": q2(o.tax_amount), "new_vat": q2(n_vat), "vat_delta": q2(n_vat - o.tax_amount),
            "base_delta": q2(n_basis - basis(o)), "by_rate": by_rate, "payout": payout,
            "sale_at": o.sale_at.astimezone(tz), "created_at": cn.created_at.astimezone(tz)})
    return c


def _ref(order_id: uuid.UUID) -> str:
    return f"ORD-{str(order_id)[:8].upper()}"


def x_report(db: Session, rid: uuid.UUID, oid: uuid.UUID) -> dict:
    start, basis = period_start(db, rid, oid)
    end = max(billing.db_now(db), start)
    rep = compute(db, rid, start, end, "X", oid)
    rep.update(number=None, number_label=None, id=None, closed_by=None, generated_at=end)
    rep["period"]["basis"] = basis  # 'last_z' | 'first_activity': why the period starts where it does
    # What the next Z close will cover (always this same period) so the screen can say it, above all for the first-ever close, which
    # covers every day since the first sale, not just today.
    tz = ZoneInfo(rep["period"]["timezone"])
    rep["close_period"] = {"from": start, "from_local": start.astimezone(tz), "days": (end.astimezone(tz).date() - start.astimezone(tz).date()).days + 1,
                           "first_close": basis == "first_activity"}
    # Preview-only warning (not stored in Z snapshots): devices that still hold unsynced offline sales would put
    # those bills into the NEXT Z, so the UI asks for confirmation before closing the day when this is false.
    rep["completeness"] = reports.Ctx(db, rid).completeness()
    return rep


# ------------------------------------------------------------------ Z close / history
def _next_number(db: Session, o: Outlet) -> int:
    """Next Z number of the OUTLET (its own counter; `z_report_next_number` of the outlet continues an old till's sequence)."""
    n = billing.next_counter(db, o.restaurant_id, o.id, "Z", 0)
    if n == 1 and o.z_report_next_number > 1:
        db.execute(update(InvoiceSequence).where(
            InvoiceSequence.outlet_id == o.id, InvoiceSequence.kind == "Z", InvoiceSequence.year == 0)
            .values(last_number=o.z_report_next_number))
        n = o.z_report_next_number
    return n


def close_day(db: Session, p, key: uuid.UUID) -> tuple[ZReport, bool]:
    """Closes the trading period. Returns (report, created). Same key = same report (created False)."""
    def existing() -> ZReport | None:
        return db.scalar(select(ZReport).where(ZReport.restaurant_id == p.restaurant_id,
                                               ZReport.idempotency_key == key))
    if (z := existing()):
        return z, False
    oid = outlets.outlet_of(db, p)
    billing.lock_close(db, oid)  # waits for in-flight bills/payments/refunds/cancellations, blocks new ones
    if (z := existing()):  # a concurrent request with the same key won the lock first
        db.rollback()
        return z, False
    r = db.scalar(select(Restaurant).where(Restaurant.id == p.restaurant_id).execution_options(populate_existing=True))
    outlet = db.scalar(select(Outlet).where(Outlet.id == oid).execution_options(populate_existing=True))
    number = _next_number(db, outlet)
    start = current_period_start(db, r.id, oid)
    end = max(billing.db_now(db), start)  # read AFTER the lock: later activity is stamped later, so it is the next Z's
    rep = compute(db, r.id, start, end, "Z", oid)
    user = db.get(User, p.user_id)
    zid = uuid.uuid4()
    rep.update(id=zid, number=number, number_label=number_label(number),
               closed_by={"id": p.user_id, "name": user.full_name if user else None}, generated_at=end)
    z = ZReport(id=zid, restaurant_id=r.id, outlet_id=oid, number=number, period_from=start, period_to=end, closed_by=p.user_id,
                data=reports.to_json(rep), idempotency_key=key)
    db.add(z)
    db.flush()
    from app.services import waiter  # end-of-day lock policy: the day's open shifts end with it (same transaction)
    waiter.close_shifts_for_day(db, p, oid, end)
    audit.record(db, p, "zreport.close", "z_report", z.id,
                 {"number": number, "orders": rep["grand_total"]["orders"], "net_sales": str(rep["deductions"]["net_sales"]),
                  "total_takings": str(rep["deductions"]["total_takings"]), "empty": rep["empty"],
                  "period_from": start.isoformat(), "period_to": end.isoformat()})
    from app.services import daily_report  # end of day report email after the commit (docs/EMAIL.md)
    daily_report.note_z_close(db, z)
    db.commit()
    db.refresh(z)
    return z, True


def upgrade_tax_table(data: dict) -> dict:
    """Z reports stored before the tax table showed the TAXABLE value had base = the price basis (the gross amount when prices
    include tax) and no `gross`. Returns a copy whose tax table has base = taxable value, vat and gross = base + vat, so a reprint
    and the JSON agree with the invoices. The stored snapshot itself is never modified. Reports that already have `gross` pass
    through unchanged."""
    vat = (data.get("summary") or {}).get("vat")
    if not isinstance(vat, dict) or not vat.get("shown") or "gross" in (vat.get("total") or {}):
        return data
    incl = bool((data.get("restaurant") or {}).get("prices_include_tax"))

    def fix(x):
        if not isinstance(x, dict):
            return x
        base, tax = _d(x["base"]), _d(x["vat"])
        return {**x, "base": str(base - tax if incl else base), "gross": str(base if incl else base + tax)}

    new_vat = {**vat, "rows": [fix(x) for x in vat["rows"]], "returns": fix(vat.get("returns")),
               "corrections": fix(vat.get("corrections")), "total": fix(vat["total"])}
    return {**data, "summary": {**data["summary"], "vat": new_vat}}


def upgrade_takings(data: dict) -> dict:
    """Z reports stored before TOTAL TAKINGS meant money received held the amount BILLED (unpaid bills included) under `total_takings`.
    Returns a copy where `billed_total` is that stored figure and `total_takings` is the money received (payments - refunds paid out, both
    stored in the snapshot), so the field means the same in every report. The stored snapshot is never modified; reports that already have
    `billed_total` pass through unchanged."""
    dd = data.get("deductions")
    if not isinstance(dd, dict) or "billed_total" in dd or "total_takings" not in dd:
        return data
    paid = _d((data.get("summary") or {}).get("total_payments", 0))
    refunds = _d(((dd.get("gross_returns") or {}).get("amount_incl_tax")) or 0)
    received = paid - refunds
    return {**data, "deductions": {**dd, "billed_total": dd["total_takings"], "total_takings": str(q2(received)),
                                   "takings": {"payments": str(q2(paid)), "refunds_paid": str(q2(refunds)),
                                               "billed_not_received": str(q2(_d(dd["total_takings"]) - received))}}}


def upgrade_stored(data: dict) -> dict:
    return upgrade_takings(upgrade_tax_table(data))


def stored_out(z: ZReport) -> dict:
    """The stored snapshot plus row facts. Everything numeric is a string. The money labels are always INR / IN (owner
    decision 2026-10-31): a snapshot stored before that shows the same numbers, labelled INR."""
    data = dict(upgrade_stored(z.data))
    if isinstance(data.get("restaurant"), dict):
        data["restaurant"] = {**data["restaurant"], "currency": "INR", "currency_symbol": "\u20b9", "country": "IN"}
    return {**data, "id": str(z.id), "created_at": z.created_at.isoformat()}


def list_reports(db: Session, rid: uuid.UUID, limit: int = 30, cursor: str | None = None,
                 outlet_ids: list[uuid.UUID] | None = None) -> dict:
    q = select(ZReport).where(ZReport.restaurant_id == rid)
    if outlet_ids is not None:
        q = q.where(ZReport.outlet_id.in_(outlet_ids))
    if cursor:
        try:
            q = q.where(ZReport.number < int(cursor))
        except ValueError:
            raise HTTPException(422, "Invalid cursor")
    rows = db.scalars(q.order_by(ZReport.number.desc()).limit(limit + 1)).all()
    page = rows[:limit]
    items = [{"id": str(z.id), "outlet_id": str(z.outlet_id), "number": z.number, "number_label": number_label(z.number),
              "period_from": z.period_from.isoformat(), "period_to": z.period_to.isoformat(),
              "orders": z.data["grand_total"]["orders"], "net_sales": z.data["deductions"]["net_sales"],
              "total_takings": dd["total_takings"], "billed_total": dd["billed_total"], "empty": z.data.get("empty", False),
              "closed_by_name": (z.data.get("closed_by") or {}).get("name"), "created_at": z.created_at.isoformat()}
             for z in page for dd in [upgrade_takings(z.data)["deductions"]]]
    return {"items": items, "next_cursor": str(page[-1].number) if len(rows) > limit else None}


def get_report(db: Session, rid: uuid.UUID, zid: uuid.UUID, p=None) -> ZReport:
    """A stored Z report; with `p`, one of an outlet the principal cannot see is 404 (its existence is not disclosed)."""
    z = db.get(ZReport, zid)
    if not z or z.restaurant_id != rid or (p is not None and not outlets.visible(p, z)):
        raise HTTPException(404, "Z report not found")
    return z


def print_count(db: Session, rid: uuid.UUID, zid: uuid.UUID) -> int:
    return db.scalar(select(func.count(AuditLog.id)).where(
        AuditLog.restaurant_id == rid, AuditLog.action == "zreport.print", AuditLog.entity_id == str(zid))) or 0


# ------------------------------------------------------------------ 80 mm slip
COLS = 42  # Courier 8 pt = 4.8 pt per character; 42 x 4.8 = 201.6 pt of the 204.8 pt printable width
SIZE = 8.0


class MonoSlip(T.Slip):
    FONT, FONT_BOLD = "Courier", "Courier-Bold"
    MAX_PAGE_H = 2500.0


def _d(x) -> Decimal:
    return Decimal(str(x))


def _m(x) -> str:
    return money.fmt_amount(_d(x))


def _fmt_dt(iso: str) -> str:
    return datetime.fromisoformat(iso).strftime("%d/%m/%Y %I:%M:%S %p")


def _two(left: str, right: str) -> str:
    left = left[: max(COLS - len(right) - 1, 1)]
    return left + " " * (COLS - len(left) - len(right)) + right


def _wrap_cols(text_: str, width: int) -> list[str]:
    out, cur = [], ""
    for word in T.safe(text_).split():
        while len(word) > width:  # hard split
            if cur:
                out.append(cur)
                cur = ""
            out.append(word[:width])
            word = word[width:]
        trial = f"{cur} {word}".strip()
        if len(trial) <= width:
            cur = trial
        else:
            out.append(cur)
            cur = word
    if cur:
        out.append(cur)
    return out or [""]


def _norm(report: dict) -> dict:
    """Stored snapshots are JSON (strings); fresh X reports hold Decimals/datetimes. The slip handles both."""
    out = reports.to_json(report) if report.get("kind") == "X" and not isinstance(report.get("period", {}).get("from"), str) else report
    return upgrade_stored(out)


def render_pdf(report: dict, printed_by: str | None, reprint: int = 0) -> bytes:
    """80 mm thermal slip in the style of the till's Z-REPORT. `reprint` > 0 marks a reprint of a stored Z."""
    rep = _norm(report)
    rs = rep["restaurant"]
    word = money.tax_word(rs.get("tax_mode"))  # always GST, also for a stored Z report whose snapshot says "Tax"
    s = MonoSlip(f"{rep['kind']}-REPORT {rep.get('number_label') or ''}".strip())

    def L(text_: str = "", bold: bool = False, align: str = "l", size: float = SIZE) -> None:
        s.text(money.retax(text_, word), size, bold, align)
        s.advance(size)

    def C(text_: str, bold: bool = False, size: float = SIZE) -> None:
        for part in _wrap_cols(text_, COLS):
            L(part, bold, "c", size)

    def rule(heavy: bool = False) -> None:
        s.rule(dashed=not heavy, pad=2.5, heavy=heavy)

    def title(text_: str) -> None:
        s.space(2)
        rule()
        C(text_, True)
        rule()

    logo = T.logo()
    if logo:
        s.image(logo, T.LOGO_WIDTH_MM * 72 / 25.4)
    C(f"{rep['kind']}-REPORT", True, 12)
    if reprint:
        C("*** REPRINT ***", True, 10)
    if rep["kind"] == "X":
        C("(X-READING - day not closed)", False)
    s.space(2)
    C(rs["name"].upper(), True, 10)
    parts = [x.strip().upper() for x in (rs.get("address") or "").split(",") if x.strip()]
    if len(parts) > 2:  # the till keeps the commas and puts the last two parts (area, postcode) on one line
        parts = parts[:-2] + [f"{parts[-2]}, {parts[-1]}"]
    for i, part in enumerate(parts):
        C(part + ("," if i < len(parts) - 1 else ""))
    if rs.get("phone"):
        C(f"TEL: {rs['phone']}")
    if rs.get("tax_number") and rs.get("vat_registered"):
        C(f"{rs['tax_number_label']}: {rs['tax_number']}")
    s.space(3)
    per = rep["period"]
    L(f"REPORT NO   : {rep['number_label'] or 'X (not stored)'}")
    L(f"PRINTED USER: {(printed_by or 'AUTOMATIC (EMAIL)').upper()}")  # no signed-in user: the scheduled / Z-close report email
    L(f"TILL NO     : {rep['till']}")
    L(f"FROM        : {_fmt_dt(per['from_local'])}")
    L(f"TO          : {_fmt_dt(per['to_local'])}")
    if rep.get("closed_by") and rep["closed_by"].get("name"):
        L(f"CLOSED BY   : {rep['closed_by']['name'].upper()}")
    L(f"AMOUNTS IN  : INR ({'TAX INCL.' if rs['prices_include_tax'] else 'EXCL. TAX'})"
      if rs["vat_registered"] else "AMOUNTS IN  : INR")
    for w in rep.get("warnings") or []:
        s.space(2)
        for part in _wrap_cols("** " + w + " **", COLS):
            L(part, True)

    title("SALES SUMMARY BY CATEGORY")
    L(f"{'DEPARTMENT':<20}{'ITEM':>7}{'DISC':>6}{'SALES':>9}", True)
    for ch in rep["channels"]:
        title(f"SUMMARY BY CATEGORY - {ch['heading']}")
        if ch["key"] == "online" and not ch["categories"]:
            L(_two("TOTAL", f"{_m(ch['sub_total']['disc'])} {_m(ch['sub_total']['sales']):>9}"), True)
            continue
        C(f"{ch['label']}-({ch['orders']} ORDERS)", True)
        s.space(1)
        for c in ch["categories"]:
            name = _wrap_cols(c["category"].upper(), 19)
            L(f"{name[0]:<20}{c['items']:>7.3f}{_m(c['disc']):>6}{_m(c['sales']):>9}")
            for more in name[1:]:
                L("  " + more)
        s.space(1)
        st = ch["sub_total"]
        L(f"{'SUB TOTAL':<20}{st['items']:>7.3f}{_m(st['disc']):>6}{_m(st['sales']):>9}", True)
    gt = rep["grand_total"]
    s.space(1)
    rule(True)
    L(f"{'GRAND TOTAL':<20}{gt['items']:>7.3f}{_m(gt['disc']):>6}{_m(gt['sales']):>9}", True)

    dd = rep["deductions"]
    title("TOTAL DEDUCTIONS")
    L(_two("ITEM DISCOUNT", _m(dd["item_discount"])))
    L(_two("DISCOUNTS-", _m(dd["bill_discounts"]["amount"])))
    for d in dd["bill_discounts"]["by_reason"]:
        for i, part in enumerate(_wrap_cols(f"DISCOUNT- {d['reason']}", COLS - 10)):
            L(_two(part, f"({d['count']}) {_m(d['amount'])}" if i == 0 else ""))
    L(_two("GROSS RETURNS-", _m(dd["gross_returns"]["amount"]) + (f" ({dd['gross_returns']['count']})" if dd["gross_returns"]["count"] else "")))
    ar = dd.get("amendment_reversals") or {"count": 0, "amount": "0.00"}
    if ar["count"]:  # old snapshots have no such line
        L(_two("CORRECTIONS (REVERSED)-", _m(ar["amount"]) + f" ({ar['count']})"))
    L(_two("CARD COMMISSION+", _m(dd["card_commission"])))
    oc = dd["other_charges"]
    L(_two("TOTAL OTHER CHARGES+", _m(oc["total"])))
    L(_two("  Service Charge", _m(oc["service_charge"]["amount"])))
    L(_two("  Delivery Charge", _m(oc["delivery_charge"]["amount"])))
    pd = oc.get("packaging_delivery")
    if pd and pd["count"]:  # India GST bills only
        L(_two("  Packaging/Delivery", _m(pd["amount"])))
    rule(True)
    ro = Decimal(str(dd.get("round_off") or 0))
    if dd["vat"] is not None:
        L(_two("NET SALES (EXCL. TAX)", _m(dd["net_sales"])), True)
        L(_two("TAX", _m(dd["vat"])))
        if ro:
            L(_two("ROUND OFF", _m(ro)))
        L(_two("TOTAL BILLED", money.fmt_inr_ascii(dd["billed_total"])), True)
    else:
        L(_two("NET SALES", _m(dd["net_sales"])), True)
        if ro:
            L(_two("ROUND OFF", _m(ro)))
        L(_two("TOTAL BILLED", _m(dd["billed_total"])), True)

    title("DEPOSIT DETAILS")
    L(_two("SUB TOTAL", _m(rep["deposits"]["sub_total"])))

    sm = rep["summary"]
    title("SUMMARY")
    L(_two("DESCRIPTION", "AMNT"), True)
    L(_two("GROSS SALES", _m(sm["gross_sales"])))
    L(_two("NET SALES", _m(sm["net_sales"])))
    s.space(2)
    L(_two(f"SERVICE CHARGE  {sm['service_charge']['count']}", _m(sm["service_charge"]["amount"])))
    L(_two(f"DELIVERY CHARGE {sm['delivery_charge']['count']}", _m(sm["delivery_charge"]["amount"])))
    rule()
    L(_two("TOTAL CHARGES", _m(sm["total_charges"])), True)
    s.space(2)
    for pm in sm["payments"]:
        L(_two(pm["method"].upper(), _m(pm["amount"])))
    rule()
    L(_two("TOTAL PAYMENTS", _m(sm["total_payments"])), True)
    tk = dd.get("takings") or {}
    if _d(tk.get("refunds_paid", 0)):
        L(_two("REFUNDS PAID-", _m(tk["refunds_paid"])))
    L(_two("TOTAL TAKINGS (RECEIVED)", money.fmt_inr_ascii(dd["total_takings"])), True)
    diff = _d(rep["checks_info"]["payments_minus_takings"])
    if diff != 0:
        L(_two("  PAYMENTS - BILLED", _m(diff)))
        for c in (rep["checks_info"].get("payments_gap") or {}).get("causes", []):
            for i, part in enumerate(_wrap_cols(f"  {c['label'].split(' (')[0]}", COLS - 14)):
                L(_two(part, f"({c['count']}) {_m(c['amount'])}" if i == 0 else ""))
    if sm["vat"]["shown"]:
        s.space(2)
        row = lambda label, base, tax, total: f"{label:<11}{_m(base):>11}{_m(tax):>9}{_m(total):>11}"  # = COLS (42)
        L(f"{'TAX':<11}{'BASE':>11}{'TAX':>9}{'TOTAL':>11}", True)  # BASE = taxable value, TOTAL = base + tax (as billed)
        for v in sm["vat"]["rows"]:
            label = "NO TAX" if v["code"] == "none" else f"TAX {_d(v['rate_percent']).normalize():f}%"
            L(row(label, v["base"], v["vat"], v["gross"]))
        if sm["vat"]["returns"] and _d(sm["vat"]["returns"]["base"]) != 0:
            rt = sm["vat"]["returns"]
            L(row("RETURNS", rt["base"], rt["vat"], rt["gross"]))
        vc = sm["vat"].get("corrections")
        if vc and _d(vc["base"]) != 0:
            L(row("CORRECTIONS", vc["base"], vc["vat"], vc["gross"]))
        rule()
        tt = sm["vat"]["total"]
        L(row("TOTAL TAX", tt["base"], tt["vat"], tt["gross"]), True)
    s.space(2)
    L(f"{'VOIDS':<12}{sm['voids']['count']:>14}{_m(sm['voids']['amount']):>16}")
    rule()
    L(f"{'TOTAL VOIDS':<12}{sm['voids']['count']:>14}{_m(sm['voids']['amount']):>16}", True)
    s.space(2)
    L(_two("DEPOSIT-SALES", _m(sm["deposit_sales"])))
    rule()
    L(_two("TOTAL DEPOSIT-SALES", _m(sm["deposit_sales"])), True)

    co = rep.get("corrections") or {"count": 0}
    if co["count"]:
        title("CORRECTIONS (bills amended)")
        for it in co["items"]:
            L(f"{it['replacement_invoice']}" if it["replacement_invoice"] else f"VOID {it['original_invoice']}", True)
            if it["replacement_invoice"]:
                L(f"  replaces {it['original_invoice']}")
            L(f"  credit note {it['credit_note']}")
            L(f"  sale {_fmt_dt(it['sale_at'])}")
            for part in _wrap_cols("Reason: " + it["reason"], COLS - 2):
                L("  " + part)
            L(_two("  TOTAL", f"{_m(it['original_total'])} > {_m(it['new_total'])} ({_m(it['delta_total'])})"))
            if it["kind"] == "void" and it["payout"]:
                L(_two("  RETURNED BY HAND", _m(it["payout"]["amount"])))
            if sm["vat"]["shown"]:
                L(_two("  TAX", f"{_m(it['original_vat'])} > {_m(it['new_vat'])} ({_m(it['vat_delta'])})"))
                for r_ in it["by_rate"]:
                    if _d(r_["base_delta"]) != 0 or _d(r_["vat_delta"]) != 0:
                        label = "NO TAX" if r_["code"] == "none" else f"TAX {_d(r_['rate_percent']).normalize():f}%"
                        L(_two(f"   {label}", f"base {_m(r_['base_delta'])} vat {_m(r_['vat_delta'])}"))
            if it["payout"] and it["kind"] != "void":
                L(_two("  REFUND " + it["payout"]["method"].upper(), "-" + _m(it["payout"]["amount"])))
            s.space(1)
        rule()
        L(_two("NET CHANGE TO SALES", _m(co["delta"]["base"])), True)
        if sm["vat"]["shown"]:
            L(_two("NET CHANGE TO TAX", _m(co["delta"]["vat"])), True)
        for pm in co["payments"]:
            L(_two("PAYMENT " + pm["method"].upper(), _m(pm["amount"])))

    oi = rep["open_items"]
    title("OPEN ITEMS (not in the totals above)")
    L(_two(f"OPEN ORDERS {oi['open_orders']['count']}", _m(oi["open_orders"]["amount"])))
    L(_two(f"UNPAID BILLS {oi['unpaid_bills']['count']}", _m(oi["unpaid_bills"]["balance"])))
    rule()
    s.space(1)
    C(f"Printed {datetime.now(ZoneInfo(rs['timezone'])).strftime('%d/%m/%Y %I:%M %p')}")
    s.cut_line()
    return s.render()
