"""Owner insight reports: money leaking out, staff performance, dish food cost, profit and loss and customers.
Same conventions as services/reports.py: read-only, tenant-scoped through the Ctx, restaurant-local inclusive date range,
Decimal money (serialise with reports.to_json), `data_complete` + `warnings` when the data is partial. Lists are capped
(`limit`) so the AI tools stay compact; the PDF renderer asks for more."""
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import distinct, exists, func, select
from sqlalchemy.orm import aliased

from app.models.core import (
    Bill, BillLine, Customer, Expense, InventoryItem, Kot, MenuItem, MovementType, Order, OrderLine, OrderStatus, Payment,
    Recipe, RecipeIngredient, Refund, Restaurant, StockMovement, User,
)
from app.services import leakage_rules, mis, money, order_kinds, reports, zreport
from app.services.reports import Ctx, Z, _f

PAISA = Decimal("0.01")
TENTH = Decimal("0.1")

# ---- leakage thresholds: every flag in leakage() comes from one of these (money amounts are INR)
DISCOUNT_MIN_BILLS = 3            # a staff member needs this many discounted bills before they are flagged
DISCOUNT_PCT_FLOOR = Decimal(5)   # ... their discounts must be at least this % of their own sales ...
DISCOUNT_RATIO_MEDIUM = Decimal(2)  # ... and at least this many times the shop average (3x = high)
DISCOUNT_RATIO_HIGH = Decimal(3)
DISCOUNT_PCT_HIGH = Decimal(10)   # at or above this % of their own sales is always high
DISCOUNT_SHOP_PCT_MEDIUM = Decimal(8)  # the whole shop gives away more than this % of sales
BIG_DISCOUNT_PCT = Decimal(50)    # one bill discounted by at least this %
VOID_AFTER_KOT_STAFF_HIGH = 3     # one person cancelled this many orders AFTER the kitchen had the ticket
VOID_AFTER_KOT_VALUE_HIGH = Decimal(100)  # or the cancelled-after-kitchen value reaches this
REFUND_STAFF_MIN = 3              # a staff member issued this many refunds ...
REFUND_PCT_MEDIUM = Decimal(3)    # ... or refunds are this % of sales (high at 2x)
# unpaid-bill and payment-difference severities live in services/leakage_rules.py (one place, docs/REPORTS.md)
STOCK_LOSS_MEDIUM = Decimal(50)   # value of write-offs / negative adjustments / negative counts, high at 4x
STOCK_LOSS_HIGH = Decimal(200)
TOP_N = 10
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}

POPULARITY_FACTOR = Decimal("0.7")  # menu engineering: a dish is "popular" when it sells >= 70% of an even share


def q2(x) -> Decimal:
    return Decimal(x or 0).quantize(PAISA)


def pct(part, whole) -> Decimal | None:
    return (Decimal(part) / Decimal(whole) * 100).quantize(TENTH) if whole else None


def _names(c: Ctx) -> dict[uuid.UUID, str]:
    return {i: n for i, n in c.db.execute(select(User.id, User.full_name).where(User.restaurant_id == c.rid))}


def _n(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def _money(c: Ctx, x) -> str:
    return money.fmt_inr(q2(x))


def _reason(r: str | None, default: str = "(no reason given)") -> str:
    return " ".join((r or "").split()) or default


def _rank(rows: dict[str, dict], key: str, n: int = TOP_N) -> list[dict]:
    return sorted(rows.values(), key=lambda r: (-r[key], r["name"]))[:n]


# ------------------------------------------------------------------ a. leakage
def leakage(c: Ctx, d_from: date, d_to: date, top: int = TOP_N) -> dict:
    """Money that leaves without a clean sale: discounts, voids, refunds / corrections, unpaid bills, the Z-report
    payments-vs-takings difference and stock shrinkage, plus plain-English `flags` computed from the constants above."""
    start, end = c.window(d_from, d_to)
    names = _names(c)
    warnings: list[str] = []

    # ---- discounts (current version of each bill at its sale date; amount in the bill's price mode, like the receipt)
    before = (select(func.coalesce(func.sum(BillLine.line_total), 0)).where(BillLine.bill_id == Bill.id).scalar_subquery())
    bills = c.db.execute(select(Bill.id, Bill.invoice_number, Bill.finalized_by, Bill.cashier_name, Bill.discount_amount,
                                Bill.discount_reason, Bill.total, before, Bill.sale_at)
                         .where(Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end)).all()

    def who(uid, snapshot=None) -> str:
        return names.get(uid) or snapshot or "Unknown"

    sales_by_staff: dict[str, Decimal] = defaultdict(lambda: Z)
    d_staff: dict[str, dict] = {}
    d_reason: dict[str, dict] = {}
    disc_rows = []
    sales_before = disc_total = Z
    for b in bills:
        staff = who(b.finalized_by, b.cashier_name)
        base = _f(b[7])
        sales_by_staff[staff] += base
        sales_before += base
        if _f(b.discount_amount) > 0:
            amt = _f(b.discount_amount)
            disc_total += amt
            s = d_staff.setdefault(staff, {"name": staff, "count": 0, "amount": Z})
            s["count"] += 1
            s["amount"] += amt
            reason = _reason(b.discount_reason)
            r = d_reason.setdefault(reason.casefold(), {"name": reason, "count": 0, "amount": Z})
            r["count"] += 1
            r["amount"] += amt
            disc_rows.append((amt, b, staff, reason, base))
    disc_count = len(disc_rows)
    for s in d_staff.values():
        s["sales"] = q2(sales_by_staff[s["name"]])
        s["percent_of_sales"] = pct(s["amount"], sales_by_staff[s["name"]])
        s["amount"] = q2(s["amount"])
    biggest = sorted(disc_rows, key=lambda x: -x[0])[:top]
    shop_pct = pct(disc_total, sales_before)
    discounts = {
        "count": disc_count, "total": q2(disc_total), "sales_before_discount": q2(sales_before), "percent_of_sales": shop_pct,
        "by_staff": sorted(d_staff.values(), key=lambda s: -s["amount"])[:top],
        "by_reason": [{**r, "amount": q2(r["amount"])} for r in _rank(d_reason, "amount", top)],
        "biggest": [{"invoice": b.invoice_number, "amount": q2(a), "percent": pct(a, base), "staff": staff,
                     "reason": reason, "sale_date": b.sale_at.astimezone(_tz(c)).date()}
                    for a, b, staff, reason, base in biggest]}

    # ---- voids: orders cancelled in the range, before / after a kitchen ticket was sent
    voids = order_kinds.cancelled_orders(c, start, end)  # shared with Payments / staff sales; merged orders are not cancellations
    v_staff: dict[str, dict] = {}
    v_reason: dict[str, dict] = {}
    v = {"before": [0, Z], "after": [0, Z]}
    after_rows = []
    for oid, reason, by, created_by, was_sent, val, at in voids:
        k = "after" if was_sent else "before"
        v[k][0] += 1
        v[k][1] += _f(val)
        staff = who(by or created_by)
        s = v_staff.setdefault(staff, {"name": staff, "count": 0, "amount": Z, "after_kitchen_count": 0, "after_kitchen_amount": Z})
        s["count"] += 1
        s["amount"] += _f(val)
        if was_sent:
            s["after_kitchen_count"] += 1
            s["after_kitchen_amount"] += _f(val)
            after_rows.append({"order_ref": zreport._ref(oid), "amount": q2(val), "staff": staff,
                               "reason": _reason(reason), "cancelled_at": at.astimezone(_tz(c))})
        r = v_reason.setdefault(_reason(reason).casefold(), {"name": _reason(reason), "count": 0, "amount": Z})
        r["count"] += 1
        r["amount"] += _f(val)
    voided = {
        "count": len(voids), "value": q2(v["before"][1] + v["after"][1]),
        "before_kitchen": {"count": v["before"][0], "value": q2(v["before"][1])},
        "after_kitchen": {"count": v["after"][0], "value": q2(v["after"][1]),
                          "orders": sorted(after_rows, key=lambda x: -x["amount"])[:top]},
        "by_staff": [{**s, "amount": q2(s["amount"]), "after_kitchen_amount": q2(s["after_kitchen_amount"])}
                     for s in _rank(v_staff, "amount", top)],
        "by_reason": [{**r, "amount": q2(r["amount"])} for r in _rank(v_reason, "amount", top)]}

    # ---- refunds and corrections (credit notes)
    repl = aliased(Bill)
    cn_rows = c.db.execute(select(Refund.kind, Refund.amount, Refund.reason, Refund.created_by, Refund.payout_amount, Bill.invoice_number,
                                  Refund.credit_note_number, repl.total)
                           .join(Bill, Bill.id == Refund.bill_id).outerjoin(repl, repl.id == Refund.replacement_bill_id)
                           .where(Refund.restaurant_id == c.rid, c.sc(Refund), Refund.created_at >= start, Refund.created_at < end)).all()
    groups = {"refund": {"count": 0, "value": Z, "staff": {}, "reason": {}, "rows": []},
              "amendment": {"count": 0, "value": Z, "staff": {}, "reason": {}, "rows": [], "payout": Z, "net": Z}}
    for kind, amt, reason, by, payout, inv_no, cn_no, repl_total in cn_rows:
        g = groups["amendment" if kind == "amendment" else "refund"]
        g["count"] += 1
        g["value"] += _f(amt)
        staff = who(by)
        for bucket, name in ((g["staff"], staff), (g["reason"], _reason(reason))):
            row = bucket.setdefault(name.casefold(), {"name": name, "count": 0, "amount": Z})
            row["count"] += 1
            row["amount"] += _f(amt)
        g["rows"].append({"credit_note": cn_no, "invoice": inv_no, "amount": q2(amt), "staff": staff, "reason": _reason(reason)})
        if kind == "amendment":
            g["payout"] += _f(payout)
            g["net"] += _f(repl_total) - _f(amt)  # what the corrected invoice changed (negative = less money kept)

    def cn_out(g: dict) -> dict:
        return {"count": g["count"], "value": q2(g["value"]),
                "by_staff": [{**r, "amount": q2(r["amount"])} for r in _rank(g["staff"], "amount", top)],
                "by_reason": [{**r, "amount": q2(r["amount"])} for r in _rank(g["reason"], "amount", top)],
                "biggest": sorted(g["rows"], key=lambda x: -x["amount"])[:top]}
    refunds = cn_out(groups["refund"])
    refunds["percent_of_sales"] = pct(groups["refund"]["value"], sum((_f(b.total) for b in bills), Z))
    corrections = {**cn_out(groups["amendment"]), "payout_to_customers": q2(groups["amendment"]["payout"]),
                   "net_change": q2(groups["amendment"]["net"])}

    # ---- bills waiting for payment: the SAME query as Orders / Reports > Payments (mis.unpaid_bills), no minimum age; the age only
    # decides the severity of the flag (leakage_rules)
    now = datetime.now(timezone.utc)
    today_local = now.astimezone(_tz(c)).date()
    unpaid_rows = mis.unpaid_bills(c, start, end)
    unpaid_bills = []
    for r in unpaid_rows:
        age = now - r.sale_at
        past_day = r.sale_at.astimezone(_tz(c)).date() < today_local
        unpaid_bills.append({"invoice": r.invoice_number, "total": q2(r.total), "balance": q2(r.balance), "part_paid": bool(r.paid),
                             "age_days": age.days, "age_minutes": max(0, int(age.total_seconds() // 60)), "customer": r.customer_name,
                             "severity": leakage_rules.unpaid_bill_severity(age, past_day)})
    unpaid = {"count": len(unpaid_rows), "balance": q2(sum((_f(r.balance) for r in unpaid_rows), Z)),
              "min_age_days": 0, "bills": unpaid_bills[:top],
              "severity": leakage_rules.worst(b["severity"] for b in unpaid_bills)}

    # ---- payments vs takings: the Z report's own check; only the part unpaid bills do not explain is "missing money"
    z = zreport.compute(c.db, c.rid, start, end, "x", c.outlet_ids)
    diff = _f(z["checks_info"]["payments_minus_takings"])
    outstanding = _posted_outstanding(c, start, end)
    missing = leakage_rules.missing_money(diff, outstanding)
    # "takings" keeps its old meaning (the billed figure) for older clients; total_takings is the money received (X/Z report)
    pay_vs_takings = {"payments": z["summary"]["total_payments"], "takings": z["deductions"]["billed_total"],
                      "billed_total": z["deductions"]["billed_total"], "total_takings": z["deductions"]["total_takings"],
                      "difference": diff, "explained_by_unpaid_bills": q2(abs(diff) - missing), "missing": q2(missing),
                      "causes": z["checks_info"]["payments_gap"], "note": z["checks_info"]["note"]}

    # ---- stock shrinkage
    if c.covers_tenant():
        stock = _shrinkage(c, start, end, warnings, top)
    else:  # stock movements carry no outlet: never show the whole tenant's shrinkage to an outlet-restricted view
        stock = {"total_loss_value": Z, "by_type": [], "items": [], "usage_gap": {"available": False}, "available": False}
        warnings.append("Stock shrinkage is tenant-wide and is not shown for a single outlet or an outlet-restricted user.")

    result = {
        **c.meta("leakage", d_from, d_to), "discounts": discounts, "voids": voided, "refunds": refunds,
        "corrections": corrections, "unpaid_bills": unpaid, "payments_vs_takings": pay_vs_takings, "stock": stock,
        "sales_before_discount": q2(sales_before)}
    result["flags"] = _leakage_flags(c, result, shop_pct)
    result["warnings"] = warnings
    return result


def _posted_outstanding(c: Ctx, start: datetime, end: datetime) -> Decimal:
    """Open balance of the active bills POSTED (finalized_at) in the Z period: the amount the day report counts as takings but has
    no payment for yet."""
    paid = (select(Payment.bill_id, func.sum(Payment.amount).label("paid")).where(Payment.restaurant_id == c.rid, c.sc(Payment))
            .group_by(Payment.bill_id).subquery())
    bal = Bill.total - func.coalesce(paid.c.paid, 0)
    return _f(c.db.scalar(select(func.coalesce(func.sum(bal), 0)).outerjoin(paid, paid.c.bill_id == Bill.id).where(
        Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.finalized_at >= start, Bill.finalized_at < end, bal > 0)))


def _gap_text(c: Ctx, gap: dict) -> str:
    """The causes of a payments-vs-billed difference, each with its own amount (from the Z report check), never a generic reason."""
    parts = [f"{x['label'].split(' (')[0].lower()} {_money(c, x['amount'])}" for x in gap["causes"]]
    if not gap["explained"]:
        parts.append(f"not explained by the books {_money(c, gap['unexplained'])}")
    return "; ".join(parts) if parts else "no cause found in the books"


def _tz(c: Ctx):
    from zoneinfo import ZoneInfo
    return ZoneInfo(c.tz)


def _shrinkage(c: Ctx, start: datetime, end: datetime, warnings: list[str], top: int) -> dict:
    """Write-offs (wastage), negative adjustments and negative stock counts, valued at the weighted-average purchase
    cost. The usage gap is only reported for what a physical count proves: the ledger itself already deducts the
    recipes of every sale, so without a count there is nothing to compare the theoretical usage with."""
    not_reversal = ~func.coalesce(StockMovement.detail["amend_reversal"].as_boolean(), False)
    loss = (StockMovement.quantity < 0) & (
        (StockMovement.movement_type == MovementType.wastage)
        | ((StockMovement.movement_type == MovementType.adjustment) & not_reversal)
        | (StockMovement.movement_type == MovementType.count))
    rows = c.db.execute(select(StockMovement.item_id, StockMovement.movement_type, func.count(StockMovement.id),
                               func.sum(StockMovement.quantity))
                        .where(StockMovement.restaurant_id == c.rid, StockMovement.created_at >= start, StockMovement.created_at < end, loss)
                        .group_by(StockMovement.item_id, StockMovement.movement_type)).all()
    cost = reports.avg_unit_costs(c, end)
    items = {i.id: i for i in c.db.scalars(select(InventoryItem).where(InventoryItem.restaurant_id == c.rid))}
    by_type: dict[str, dict] = {}
    per_item: dict[uuid.UUID, dict] = {}
    uncosted: set[str] = set()
    for item_id, mtype, n, qty in rows:
        item = items.get(item_id)
        name = item.name if item else str(item_id)
        known = item_id in cost
        val = -_f(qty) * cost[item_id] if known else Z
        if not known:
            uncosted.add(name)
        t = by_type.setdefault(mtype.value, {"type": mtype.value, "movements": 0, "value": Z})
        t["movements"] += n
        t["value"] += val
        row = per_item.setdefault(item_id, {"item": name, "unit": item.base_unit if item else "", "quantity": Z, "value": Z, "types": []})
        row["quantity"] += -_f(qty)
        row["value"] += val
        row["types"].append(mtype.value)
    total = sum((t["value"] for t in by_type.values()), Z)
    if uncosted:
        warnings.append("Stock losses without a purchase cost are counted but not valued: " + ", ".join(sorted(uncosted)))

    # usage gap: theoretical usage (recipes x sold, as posted at billing) vs what physical counts found
    recipes = c.db.scalar(select(func.count(Recipe.id)).where(Recipe.restaurant_id == c.rid)) or 0
    used = c.db.execute(select(StockMovement.item_id, func.sum(-StockMovement.quantity)).where(
        StockMovement.restaurant_id == c.rid, StockMovement.created_at >= start, StockMovement.created_at < end,
        (StockMovement.movement_type == MovementType.sale)
        | ((StockMovement.movement_type == MovementType.adjustment) & ~not_reversal)).group_by(StockMovement.item_id)).all()
    theoretical = sum((_f(q) * cost[i] for i, q in used if i in cost), Z)
    counted = c.db.execute(select(func.count(distinct(StockMovement.ref_id)), func.coalesce(func.sum(StockMovement.quantity), 0))
                           .where(StockMovement.restaurant_id == c.rid, StockMovement.movement_type == MovementType.count,
                                  StockMovement.created_at >= start, StockMovement.created_at < end)).one()
    count_rows = c.db.execute(select(StockMovement.item_id, func.sum(StockMovement.quantity)).where(
        StockMovement.restaurant_id == c.rid, StockMovement.movement_type == MovementType.count,
        StockMovement.created_at >= start, StockMovement.created_at < end).group_by(StockMovement.item_id)).all()
    count_variance = sum((_f(q) * cost[i] for i, q in count_rows if i in cost), Z)
    gap: dict = {"available": False, "theoretical_usage_value": None, "stock_counts": counted[0],
                 "count_variance_value": None, "note": None}
    if not recipes:
        gap["note"] = "No recipes are set up, so theoretical usage cannot be worked out."
        warnings.append("Stock usage gap not computed: no recipes exist.")
    elif not counted[0]:
        gap["note"] = "No stock count was done in this period, so actual usage cannot be compared with theoretical usage."
        warnings.append("Stock usage gap not computed: no stock count in this period (do a count to measure shrinkage).")
    else:
        gap.update(available=True, theoretical_usage_value=q2(theoretical), count_variance_value=q2(count_variance),
                   note="count_variance_value is the net result of the counts (negative = less stock than the books expected).")
    return {"total_loss_value": q2(total), "by_type": [{**t, "value": q2(t["value"])} for t in sorted(by_type.values(), key=lambda t: t["type"])],
            "items": [{**r, "quantity": r["quantity"].quantize(Decimal("0.001")), "value": q2(r["value"])}
                      for r in sorted(per_item.values(), key=lambda r: (-r["value"], r["item"]))[:top]],
            "usage_gap": gap}


def _leakage_flags(c: Ctx, r: dict, shop_pct: Decimal | None) -> list[dict]:
    flags: list[dict] = []

    def add(sev: str, code: str, msg: str) -> None:
        flags.append({"severity": sev, "code": code, "message": msg})
    d = r["discounts"]
    for s in d["by_staff"]:
        p = s["percent_of_sales"]
        if s["count"] < DISCOUNT_MIN_BILLS or p is None or shop_pct is None:
            continue
        ratio = p / shop_pct if shop_pct else None
        sev = ("high" if p >= DISCOUNT_PCT_HIGH or (ratio is not None and ratio >= DISCOUNT_RATIO_HIGH and p >= DISCOUNT_PCT_FLOOR)
               else "medium" if p >= DISCOUNT_PCT_FLOOR and (ratio is None or ratio >= DISCOUNT_RATIO_MEDIUM) else None)
        if sev:
            add(sev, "staff_discounts", f"{s['name']} gave {_n(s['count'], 'discount')} worth {_money(c, s['amount'])} "
                                        f"({p}% of their sales, the shop average is {shop_pct}%)")
    if shop_pct is not None and shop_pct >= DISCOUNT_SHOP_PCT_MEDIUM:
        add("medium", "shop_discounts", f"Discounts are {shop_pct}% of sales ({_money(c, d['total'])}), above the {DISCOUNT_SHOP_PCT_MEDIUM}% watch level")
    for b in d["biggest"]:
        if b["percent"] is not None and b["percent"] >= BIG_DISCOUNT_PCT:
            add("high", "big_discount", f"Bill {b['invoice']} was discounted by {b['percent']}% ({_money(c, b['amount'])}) by {b['staff']}: {b['reason']}")
    v = r["voids"]
    for s in v["by_staff"]:
        if s["after_kitchen_count"] >= VOID_AFTER_KOT_STAFF_HIGH or s["after_kitchen_amount"] >= VOID_AFTER_KOT_VALUE_HIGH:
            add("high", "staff_void_after_kitchen", f"{s['name']} cancelled {_n(s['after_kitchen_count'], 'order')} after the kitchen had the ticket "
                                                    f"(worth {_money(c, s['after_kitchen_amount'])})")
    if v["after_kitchen"]["count"]:
        sev = "high" if v["after_kitchen"]["value"] >= VOID_AFTER_KOT_VALUE_HIGH else "medium"
        add(sev, "void_after_kitchen", f"{_n(v['after_kitchen']['count'], 'order')} worth {_money(c, v['after_kitchen']['value'])} "
                                       f"{'was' if v['after_kitchen']['count'] == 1 else 'were'} cancelled after the kitchen ticket was sent: "
                                       "food may have been made and not paid for")
    rf = r["refunds"]
    for s in rf["by_staff"]:
        if s["count"] >= REFUND_STAFF_MIN:
            add("medium", "staff_refunds", f"{s['name']} issued {_n(s['count'], 'refund')} worth {_money(c, s['amount'])}")
    p = rf["percent_of_sales"]
    if p is not None and p >= REFUND_PCT_MEDIUM:
        add("high" if p >= 2 * REFUND_PCT_MEDIUM else "medium", "refunds_share", f"Refunds are {p}% of sales ({_money(c, rf['value'])})")
    u = r["unpaid_bills"]
    if u["count"]:
        sev = u["severity"]  # the worst bill decides (leakage_rules.unpaid_bill_severity); a fresh bill is just information
        what = ("waiting for payment" if sev == leakage_rules.LOW else "still unpaid or part-paid, some for hours or past the end of their day")
        add(sev, "unpaid_bills", f"{_n(u['count'], 'bill')} {'is' if u['count'] == 1 else 'are'} {what}: {_money(c, u['balance'])} outstanding")
    pv = r["payments_vs_takings"]
    sev = leakage_rules.payment_difference_severity(pv["missing"])
    if sev:
        add(sev, "payments_vs_takings",
            f"Payments differ from the amount billed by {_money(c, pv['difference'])}, of which {_money(c, pv['missing'])} is not explained by unpaid bills"
            + (": " + _gap_text(c, pv["causes"]) if pv.get("causes") else " (see the Z report check)"))
    loss = r["stock"]["total_loss_value"]
    if loss >= STOCK_LOSS_MEDIUM:
        add("high" if loss >= STOCK_LOSS_HIGH else "medium", "stock_loss", f"Stock write-offs, negative adjustments and count shortages total {_money(c, loss)}")
    flags.sort(key=lambda f: SEVERITY_ORDER[f["severity"]])
    return flags


# ------------------------------------------------------------------ b. staff
def staff_sales(c: Ctx, d_from: date, d_to: date) -> dict:
    """Per user: what they billed (finalized_by), discounts they gave, orders they created, orders they cancelled and
    refunds they issued. Tips are not modelled by the POS, so there is no tip column."""
    start, end = c.window(d_from, d_to)
    users = {u.id: u for u in c.db.scalars(select(User).where(User.restaurant_id == c.rid))}
    rows: dict[uuid.UUID, dict] = {}

    def row(uid):
        u = users.get(uid)
        return rows.setdefault(uid, {"user_id": uid, "name": u.full_name if u else "Unknown", "role": u.role.value if u else None,
                                     "bills": 0, "gross": Z, "items": 0, "discount_count": 0, "discount_value": Z, "orders_created": 0,
                                     "void_count": 0, "void_value": Z, "refund_count": 0, "refund_value": Z})
    for uid, n, tot, disc_n, disc in c.db.execute(select(
            Bill.finalized_by, func.count(Bill.id), func.sum(Bill.total), func.count(Bill.id).filter(Bill.discount_amount > 0),
            func.sum(Bill.discount_amount)).where(Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start,
                                                  Bill.sale_at < end).group_by(Bill.finalized_by)):
        r = row(uid)
        r.update(bills=n, gross=_f(tot), discount_count=disc_n, discount_value=_f(disc))
    for uid, qty in c.db.execute(select(Bill.finalized_by, func.sum(BillLine.quantity)).join(BillLine, BillLine.bill_id == Bill.id)
                                 .where(Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end)
                                 .group_by(Bill.finalized_by)):
        row(uid)["items"] = int(qty or 0)
    for uid, n in c.db.execute(select(Order.created_by, func.count(Order.id)).where(
            Order.restaurant_id == c.rid, c.sc(Order), Order.created_at >= start, Order.created_at < end).group_by(Order.created_by)):
        row(uid)["orders_created"] = n
    cancels: dict = {}
    for o in order_kinds.cancelled_orders(c, start, end):
        n, val = cancels.get(o.cancelled_by or o.created_by, (0, Z))
        cancels[o.cancelled_by or o.created_by] = (n + 1, val + _f(o.value))
    for uid, (n, val) in cancels.items():
        r = row(uid)
        r.update(void_count=n, void_value=val)
    for uid, n, amt in c.db.execute(select(Refund.created_by, func.count(Refund.id), func.sum(Refund.amount)).where(
            Refund.restaurant_id == c.rid, c.sc(Refund), Refund.kind == "refund", Refund.created_at >= start, Refund.created_at < end)
            .group_by(Refund.created_by)):
        r = row(uid)
        r.update(refund_count=n, refund_value=_f(amt))
    staff = []
    for r in sorted(rows.values(), key=lambda r: (-r["gross"], r["name"])):
        staff.append({"user_id": r["user_id"], "name": r["name"], "role": r["role"], "bills": r["bills"], "gross": q2(r["gross"]),
                      "average_bill": q2(r["gross"] / r["bills"]) if r["bills"] else Z, "items": r["items"],
                      "discounts": {"count": r["discount_count"], "value": q2(r["discount_value"])},
                      "orders_created": r["orders_created"],
                      "voids": {"count": r["void_count"], "value": q2(r["void_value"])},
                      "refunds": {"count": r["refund_count"], "value": q2(r["refund_value"])}})
    totals = {"bills": sum(s["bills"] for s in staff), "gross": q2(sum((s["gross"] for s in staff), Z)),
              "discount_value": q2(sum((s["discounts"]["value"] for s in staff), Z))}
    return {**c.meta("staff_sales", d_from, d_to), "staff": staff, "totals": totals, "warnings": [],
            "note": "Bills are credited to the person who finalized them (gross = what customers paid, incl. tax and service charge). "
                    "Tips are not recorded by Chilli Agent."}


# ------------------------------------------------------------------ c. dish food cost
def dish_food_cost(c: Ctx, d_from: date, d_to: date, limit: int = 50) -> dict:
    """Per dish sold: quantity, net revenue, recipe cost per portion (weighted-average purchase cost, as profitability),
    food cost %, margin and a menu-engineering class. Dishes without a recipe (or with an uncosted ingredient) are listed
    apart and never guessed."""
    c.require_tenant_level("dish food cost")
    start, end = c.window(d_from, d_to)
    limit = min(max(limit, 1), 500)
    sold: dict = {}
    for item_id, name, qty, rev in reports.revenue_rows(c, start, end):
        a = sold.setdefault(item_id or name, {"item_id": item_id, "name": name, "quantity": 0, "revenue": Z})
        a["quantity"] += qty
        a["revenue"] += rev
    menu_names = {i: n for i, n in c.db.execute(select(MenuItem.id, MenuItem.name).where(MenuItem.restaurant_id == c.rid))}
    cost = reports.avg_unit_costs(c, end)
    inv_names = {i: n for i, n in c.db.execute(select(InventoryItem.id, InventoryItem.name).where(InventoryItem.restaurant_id == c.rid))}
    latest: dict[uuid.UUID, Recipe] = {}
    for rec in c.db.scalars(select(Recipe).where(Recipe.restaurant_id == c.rid, Recipe.effective_from < end)):
        if rec.menu_item_id not in latest or rec.version > latest[rec.menu_item_id].version:
            latest[rec.menu_item_id] = rec
    ings = defaultdict(list)
    if latest:
        for ri in c.db.scalars(select(RecipeIngredient).where(RecipeIngredient.recipe_id.in_([r.id for r in latest.values()]))):
            ings[ri.recipe_id].append(ri)

    costed, no_recipe, no_cost = [], [], []
    for key, a in sold.items():
        name = menu_names.get(a["item_id"], a["name"])
        rec = latest.get(a["item_id"]) if a["item_id"] else None
        lines = ings.get(rec.id, []) if rec else []
        if not lines:
            no_recipe.append({"item": name, "has_recipe": False, "quantity": a["quantity"], "revenue_excl_vat": q2(a["revenue"])})
            continue
        missing = sorted({inv_names.get(i.item_id, str(i.item_id)) for i in lines if i.item_id not in cost})
        if missing:
            no_cost.append({"item": name, "has_recipe": True, "cost_known": False, "quantity": a["quantity"],
                            "revenue_excl_vat": q2(a["revenue"]), "ingredients_without_cost": missing})
            continue
        per = sum((i.quantity * cost[i.item_id] for i in lines), Z).quantize(Decimal("0.0001"))
        costed.append({"item": name, "has_recipe": True, "cost_known": True, "quantity": a["quantity"], "revenue": a["revenue"], "cost_per_portion": per})
    tot_rev = sum((d["revenue"] for d in costed), Z)
    tot_cost = sum((d["cost_per_portion"] * d["quantity"] for d in costed), Z)
    tot_qty = sum(d["quantity"] for d in costed)
    avg_margin = (tot_rev - tot_cost) / tot_qty if tot_qty else None
    for d in costed:
        total_cost = d["cost_per_portion"] * d["quantity"]
        price = d["revenue"] / d["quantity"] if d["quantity"] else Z
        revenue = q2(d.pop("revenue"))
        d.update(revenue_excl_vat=revenue, revenue_per_portion=q2(price), cost_per_portion=q2(d["cost_per_portion"]),
                 food_cost_percent=pct(total_cost, revenue), margin_per_portion=q2(price - d["cost_per_portion"]),
                 total_cost=q2(total_cost), total_margin=q2(revenue - total_cost))
        # menu engineering: popular = sells >= 70% of an even share; profitable = margin per portion >= the menu's weighted average
        if len(costed) > 1 and avg_margin is not None:
            popular = Decimal(d["quantity"]) >= POPULARITY_FACTOR * Decimal(tot_qty) / len(costed)
            profitable = (price - d["cost_per_portion"]) >= avg_margin
            d["classification"] = ("star" if popular and profitable else "plowhorse" if popular
                                   else "puzzle" if profitable else "dog")
        else:
            d["classification"] = None
    costed.sort(key=lambda d: (-d["revenue_excl_vat"], d["item"]))
    no_recipe.sort(key=lambda d: (-d["revenue_excl_vat"], d["item"]))
    no_cost.sort(key=lambda d: (-d["revenue_excl_vat"], d["item"]))
    warnings = []
    if no_recipe:
        warnings.append(f"{len(no_recipe)} sold dish(es) have no recipe, so their food cost is unknown: "
                        + ", ".join(d["item"] for d in no_recipe[:8]) + (" ..." if len(no_recipe) > 8 else ""))
    if no_cost:
        warnings.append("Dishes with an ingredient that was never purchased with a cost (cost not computed): "
                        + ", ".join(d["item"] for d in no_cost[:8]))
    return {**c.meta("dish_food_cost", d_from, d_to),
            "dishes": costed[:limit], "dishes_more": max(len(costed) - limit, 0),
            "dishes_without_recipe": (no_recipe + no_cost)[:limit], "dishes_without_recipe_more": max(len(no_recipe) + len(no_cost) - limit, 0),
            "totals": {"dishes_costed": len(costed), "dishes_without_recipe": len(no_recipe) + len(no_cost), "portions": tot_qty,
                       "revenue_excl_vat": q2(tot_rev), "ingredient_cost": q2(tot_cost), "gross_margin": q2(tot_rev - tot_cost),
                       "food_cost_percent": pct(tot_cost, tot_rev),
                       "revenue_without_recipe": q2(sum((d["revenue_excl_vat"] for d in no_recipe + no_cost), Z))},
            "warnings": warnings, "cost_method": "weighted-average purchase cost",
            "classification_note": "star = popular and above-average margin; plowhorse = popular, low margin; puzzle = unpopular, high margin; "
                                   "dog = neither. Needs at least two costed dishes."}


# ------------------------------------------------------------------ d. profit and loss
def profit_and_loss(c: Ctx, d_from: date, d_to: date) -> dict:
    c.require_tenant_level("profit and loss")
    start, end = c.window(d_from, d_to)
    sales, sc = c.db.execute(select(func.coalesce(func.sum(Bill.subtotal), 0), func.count(Bill.id)).where(
        Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active", Bill.sale_at >= start, Bill.sale_at < end)).one()
    ref_net = c.db.scalar(select(func.coalesce(func.sum(Refund.amount - Refund.tax_amount - Refund.round_off), 0)).where(
        Refund.restaurant_id == c.rid, c.sc(Refund), Refund.kind == "refund", Refund.created_at >= start, Refund.created_at < end))
    net_sales = _f(sales) - _f(ref_net)
    prof = reports.profitability(c, d_from, d_to)
    cogs = prof["ingredient_cost"]
    gross_profit = net_sales - cogs
    gst = mis.gst_summary(c, d_from, d_to)  # tenant-level here, so input tax and net payable are present
    # Input tax is excluded from expenses when the restaurant can claim it (GST registered)
    recoverable = bool(c.db.get(Restaurant, c.rid).vat_registered)
    exp = c.db.execute(select(Expense.category, func.count(Expense.id), func.sum(Expense.net), func.sum(Expense.gross)).where(
        Expense.restaurant_id == c.rid, Expense.expense_date >= d_from, Expense.expense_date <= d_to).group_by(Expense.category)).all()
    cats = sorted(({"category": cat, "count": n, "amount": q2(net if recoverable else gross)} for cat, n, net, gross in exp),
                  key=lambda x: (-x["amount"], x["category"]))
    exp_total = sum((x["amount"] for x in cats), Z)
    operating = gross_profit - exp_total
    warnings = list(prof["warnings"]) + list(gst["warnings"])
    if not cats:
        warnings.append("No expenses were recorded for this period, so operating profit equals gross profit.")
    warnings.append("Expenses come from the Expenses list only (rent, utilities...); stock purchases are not expenses here, "
                    "ingredient cost is taken from recipes x sold quantities. Staff wages are included only if entered as expenses.")
    return {**c.meta("profit_and_loss", d_from, d_to),
            "net_sales_excl_vat": q2(net_sales), "bills": sc, "refunds_excl_vat": q2(ref_net),
            "ingredient_cost": cogs, "gross_profit": q2(gross_profit), "gross_margin_percent": pct(gross_profit, net_sales),
            "expenses": {"by_category": cats, "total": q2(exp_total), "vat_excluded": recoverable},
            "operating_profit": q2(operating), "operating_margin_percent": pct(operating, net_sales),
            "items_without_recipe": prof["items_without_recipe"], "ingredients_without_cost": prof["ingredients_without_cost"],
            # `vat` and its keys keep their names for API compatibility: output / input GST and the net payable.
            "vat": {"output_vat": q2(gst["totals"]["net_tax"]), "input_vat": gst["input_tax"]["total"],
                    "net_vat_due": gst["net_payable"], "authority": "GST authorities"},
            "warnings": warnings,
            "note": "Net sales = invoice totals excl. tax (service charge included) minus refunds excl. tax, by sale date."}


# ------------------------------------------------------------------ f. customers
def customer_insights(c: Ctx, d_from: date, d_to: date) -> dict:
    start, end = c.window(d_from, d_to)
    tz = _tz(c)
    base = [Bill.restaurant_id == c.rid, c.sc(Bill), Bill.status == "active"]
    linked = c.db.execute(select(Customer.id, Customer.name, Customer.phone, func.count(Bill.id), func.sum(Bill.total), func.max(Bill.sale_at))
                          .join(Order, Order.customer_id == Customer.id).join(Bill, Bill.order_id == Order.id)
                          .where(*base, Bill.sale_at >= start, Bill.sale_at < end, Customer.restaurant_id == c.rid)
                          .group_by(Customer.id)).all()
    unlinked = c.db.scalar(select(func.count(Bill.id)).join(Order, Order.id == Bill.order_id).where(
        *base, Bill.sale_at >= start, Bill.sale_at < end, Order.customer_id.is_(None))) or 0
    ids = [r[0] for r in linked]
    earlier = set(c.db.scalars(select(Order.customer_id).join(Bill, Bill.order_id == Order.id).where(
        *base, Bill.sale_at < start, Order.customer_id.in_(ids)).distinct())) if ids else set()
    returning = sum(1 for r in linked if r[0] in earlier)
    repeaters = sum(1 for r in linked if r[3] >= 2 or r[0] in earlier)
    top = sorted(linked, key=lambda r: (-_f(r[4]), r[1] or r[2] or ""))[:TOP_N]
    bills_linked = sum(r[3] for r in linked)
    warnings = []
    total_bills = bills_linked + unlinked
    if total_bills and bills_linked * 2 < total_bills:
        warnings.append(f"Only {bills_linked} of {total_bills} bills are linked to a customer, so these figures cover a minority of sales.")
    return {**c.meta("customer_insights", d_from, d_to),
            "customers": len(linked), "new_customers": len(linked) - returning, "returning_customers": returning,
            "repeat_rate_percent": pct(repeaters, len(linked)), "returning_rate_percent": pct(returning, len(linked)),
            "bills_with_customer": bills_linked, "bills_without_customer": unlinked,
            "identified_share_percent": pct(bills_linked, total_bills),
            "top_customers": [{"name": r[1], "phone": r[2], "visits": r[3], "spend": q2(r[4]), "average_bill": q2(_f(r[4]) / r[3]),
                               "last_visit": r[5].astimezone(tz).date(), "returning": r[0] in earlier} for r in top],
            "warnings": warnings,
            "note": "new = first ever bill in this period; returning = had a bill before it; repeat rate = customers who visited at least "
                    "twice in the period or had visited before. Spend is gross (what the customer paid)."}
