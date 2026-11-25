"""Server-side invariant checks over one restaurant's data. Read-only; every query is tenant-scoped.
Each check returns {name, ok, severity, detail, sample}. `severity` is "error" (ok=false means data is wrong)
or "warning" (ok stays true; worth a human look). Run via GET /api/v1/system/reconciliation."""
import uuid
from decimal import Decimal

from sqlalchemy import text
from sqlalchemy.orm import Session

SAMPLE = 10


def _rows(db: Session, sql: str, rid: uuid.UUID, **kw) -> list:
    return db.execute(text(sql), {"rid": rid, **kw}).all()


def _violations(name: str, rows: list, ok_msg: str, bad_msg: str, severity: str = "error") -> dict:
    ids = [str(r[0]) for r in rows[:SAMPLE]]
    if not rows:
        return {"name": name, "ok": True, "severity": severity, "detail": ok_msg, "sample": []}
    return {"name": name, "ok": severity == "warning", "severity": severity,
            "detail": f"{len(rows)} {bad_msg}", "sample": ids}


def _gapless(db: Session, rid, name: str, table: str, column: str, kind: str) -> dict:
    """Generic-engine numbers (financial year Apr-Mar): INV/2526/000042 (default outlet) or I<prefix>-2526-000042 (other
    outlet). Per outlet and financial year: unique, starting at 1, no holes, and equal to the counter (invoice_sequences
    kind INV / CN, year = first year of the financial year). GST-engine numbers (INV/25-26/...) have their own check."""
    pat = f"^({kind}/|{kind[0]}[A-Za-z0-9]+-)[0-9]{{4}}[/-][0-9]+$"
    rows = _rows(db, f"""
        SELECT outlet_id, 2000 + (regexp_match({column}, '^[A-Za-z0-9]+[/-]([0-9]{{2}})[0-9]{{2}}[/-]'))[1]::int AS yr,
               count(*), count(DISTINCT {column}), min((regexp_match({column}, '([0-9]+)$'))[1]::int),
               max((regexp_match({column}, '([0-9]+)$'))[1]::int)
        FROM {table} WHERE restaurant_id = :rid AND {column} ~ '{pat}' GROUP BY 1, 2 ORDER BY 1, 2""", rid)
    seq = {(o, y): n for o, y, n in _rows(db, "SELECT outlet_id, year, last_number FROM invoice_sequences "
                                              "WHERE restaurant_id = :rid AND kind = :k", rid, k=kind)}
    bad = [f"{o}/{y}: count={n} distinct={dn} range={lo}..{hi}" for o, y, n, dn, lo, hi in rows
           if not (n == dn == hi and lo == 1)]
    bad += [f"{o}/{y}: highest number {hi} != counter {seq.get((o, y))}" for o, y, n, dn, lo, hi in rows
            if seq.get((o, y)) != hi]
    return {"name": name, "ok": not bad, "severity": "error", "sample": bad[:SAMPLE],
            "detail": f"{kind} numbers are gapless and unique" if not bad else f"{len(bad)} year(s) with gaps/duplicates"}


def _gapless_gst(db: Session, rid, name: str, table: str, column: str, extra: str, kinds: dict[str, str]) -> dict:
    """India GST engine numbers (PREFIX/26-27/NNNNNN): per outlet, series and financial year unique, starting at 1, no
    holes, and equal to the counter (invoice_sequences kinds GINV / GBOS / GCN, year = first year of the FY)."""
    rows = _rows(db, f"""
        SELECT outlet_id, split_part({column}, '/', 1) AS series, 2000 + left(split_part({column}, '/', 2), 2)::int AS yr,
               count(*), count(DISTINCT {column}), min(right({column}, 6)::int), max(right({column}, 6)::int)
        FROM {table} WHERE restaurant_id = :rid AND {column} ~ '^[A-Z]+/[0-9]{{2}}-[0-9]{{2}}/[0-9]{{6}}$' {extra}
        GROUP BY 1, 2, 3""", rid)
    seq = {(o, k, y): n for o, k, y, n in _rows(db, "SELECT outlet_id, kind, year, last_number FROM invoice_sequences "
                                                     "WHERE restaurant_id = :rid", rid)}
    bad = [f"{o}/{s}/{y}: count={n} distinct={dn} range={lo}..{hi}" for o, s, y, n, dn, lo, hi in rows
           if not (n == dn == hi and lo == 1)]
    bad += [f"{o}/{s}/{y}: highest {hi} != counter {seq.get((o, kinds.get(s), y))}" for o, s, y, n, dn, lo, hi in rows
            if seq.get((o, kinds.get(s), y)) != hi]
    return {"name": name, "ok": not bad, "severity": "error", "sample": bad[:SAMPLE],
            "detail": "GST document numbers are gapless and unique" if not bad else f"{len(bad)} series with gaps/duplicates"}


def _breakdown_checks(db: Session, rid: uuid.UUID) -> dict:
    """Bills with a tax_breakdown: the rows add up to the bill totals, every row's tax is consistent with its rate
    (within 0.01 per rate group), and the line nets + service charge net add up to the subtotal (within 0.02)."""
    paisa, tol2 = Decimal("0.01"), Decimal("0.02")
    bad: list[str] = []
    bills = _rows(db, """SELECT id, subtotal, tax_amount, total, tax_breakdown, prices_include_tax, service_charge_amount,
                                round_off, tax_mode
                         FROM bills WHERE restaurant_id = :rid AND tax_breakdown IS NOT NULL""", rid)
    line_nets = {b: Decimal(n) for b, n in _rows(db, """
        SELECT l.bill_id, SUM(l.net_amount) FROM bill_lines l JOIN bills b ON b.id = l.bill_id
        WHERE b.restaurant_id = :rid AND b.tax_breakdown IS NOT NULL AND l.net_amount IS NOT NULL
        GROUP BY l.bill_id""", rid)}
    for bid, sub, tax, tot, brk, inclusive, sc, ro, mode in bills:
        if not brk:  # JSON 'null' written by some other client: treat like a legacy bill
            continue
        rows = [{k: (Decimal(str(r[k])) if k != "code" else r[k]) for k in ("code", "rate_percent", "net", "vat", "gross")}
                for r in brk]
        problems = []
        if (sum(r["net"] for r in rows), sum(r["vat"] for r in rows), sum(r["gross"] for r in rows)) != (sub, tax, tot - ro):  # GST bills: total includes the explicit round-off line
            problems.append("breakdown != totals")
        for r in rows:
            rate = r["rate_percent"]
            exp = (r["gross"] * rate / (100 + rate)) if inclusive else (r["net"] * rate / 100)
            if abs(r["vat"] - exp) > paisa or r["net"] + r["vat"] != r["gross"]:
                problems.append(f"{r['code']} vat inconsistent")
        if bid in line_nets and sc is not None and mode != "gst_engine":  # GST: charges + CGST/SGST rounding, see the GST check
            std = next((r["rate_percent"] for r in rows if r["code"] == "standard"), Decimal(0))
            sc_net = (sc - sc * std / (100 + std)) if inclusive else sc
            if abs(line_nets[bid] + sc_net - sub) > tol2:
                problems.append("line nets + service charge != subtotal")
        if problems:
            bad.append(f"{bid}: {', '.join(problems)}")
    return {"name": "bill_breakdown_consistent", "ok": not bad, "severity": "error", "sample": bad[:SAMPLE],
            "detail": "tax breakdown rows add up to every bill's totals and agree with their rates" if not bad
            else f"{len(bad)} bill(s) with an inconsistent tax breakdown"}


def _z_report_checks(db: Session, rid: uuid.UUID) -> list[dict]:
    """Stored Z snapshots: internally consistent; numbering gapless; periods contiguous (so no bill is in two
    periods or in a gap between them); each snapshot's bill count / total equals the live bills of its period."""
    z0 = Decimal(0)
    d = lambda x: Decimal(str(x))
    zs = _rows(db, "SELECT id, number, period_from, period_to, data FROM z_reports WHERE restaurant_id = :rid "
                   "ORDER BY number", rid)
    arith, chain, live = [], [], []
    for i, (zid, number, pf, pt, data) in enumerate(zs):
        try:
            ch = data["channels"]
            gt, dd, sm = data["grand_total"], data["deductions"], data["summary"]
            probs = []
            if sum((d(c["sub_total"]["sales"]) for c in ch), z0) != d(gt["sales"]):
                probs.append("sub totals != grand total")
            for c in ch:
                if sum((d(x["sales"]) for x in c["categories"]), z0) != d(c["sub_total"]["sales"]):
                    probs.append(f"{c['key']} categories != sub total")
            if sum((c["orders"] for c in ch)) != gt["orders"]:
                probs.append("order counts")
            rev = d((dd.get("amendment_reversals") or {"amount": "0"})["amount"])  # absent in older snapshots
            net = (d(gt["sales"]) - d(dd["bill_discounts"]["amount"]) - d(dd["gross_returns"]["amount"]) - rev
                   + d(dd["other_charges"]["total"]))
            if net != d(dd["net_sales"]):
                probs.append("net != gross - discounts - returns - corrections + charges")
            co = data.get("corrections")
            if co and co["count"]:
                if sum((d(x["original_total"]) for x in co["items"]), z0) != d(co["reversed"]["total"]):
                    probs.append("corrections: originals != reversed total")
                if sum((d(x["delta_total"]) for x in co["items"]), z0) != d(co["delta"]["total"]):
                    probs.append("corrections: item deltas != delta total")
                if d(co["replacements"]["total"]) - d(co["reversed"]["total"]) != d(co["delta"]["total"]):
                    probs.append("corrections: replacements - reversed != delta")
            if sum((d(x["amount"]) for x in sm["payments"]), z0) != d(sm["total_payments"]):
                probs.append("payments != total payments")
            if sum((d(x["amount"]) for x in dd["bill_discounts"]["by_reason"]), z0) != d(dd["bill_discounts"]["amount"]):
                probs.append("discount reasons != total")
            v = sm["vat"]
            vc = v.get("corrections") or {"base": "0", "vat": "0"}
            if v.get("shown") and (sum((d(x["base"]) for x in v["rows"]), z0) + d(v["returns"]["base"]) + d(vc["base"]) != d(v["total"]["base"])
                                   or sum((d(x["vat"]) for x in v["rows"]), z0) + d(v["returns"]["vat"]) + d(vc["vat"]) != d(v["total"]["vat"])):
                probs.append("tax rows != tax total")
            if probs:
                arith.append(f"Z{number}: {', '.join(probs)}")
        except (KeyError, TypeError, ValueError) as e:
            arith.append(f"Z{number}: unreadable snapshot ({type(e).__name__})")
            continue
        if i and zs[i - 1][3] != pf:
            chain.append(f"Z{number}: starts {pf} but Z{zs[i - 1][1]} ended {zs[i - 1][3]}")
        if i and number != zs[i - 1][1] + 1:
            chain.append(f"Z{number}: follows Z{zs[i - 1][1]} (gap in numbering)")
        if pt < pf:
            chain.append(f"Z{number}: period ends before it starts")
        n, tot = _rows(db, "SELECT count(*), COALESCE(sum(total), 0) FROM bills WHERE restaurant_id = :rid "
                           "AND finalized_at >= :a AND finalized_at < :b", rid, a=pf, b=pt)[0]
        if n != data["grand_total"]["orders"] or Decimal(tot) != d(data["checks_info"]["bills_total"]):
            live.append(f"Z{number}: snapshot has {data['grand_total']['orders']} bills / {data['checks_info']['bills_total']}, "
                        f"live data has {n} / {tot}")
    seq = _rows(db, "SELECT last_number FROM invoice_sequences WHERE restaurant_id = :rid AND kind = 'Z' AND year = 0", rid)
    if zs and (not seq or seq[0][0] != zs[-1][1]):
        chain.append(f"highest Z number {zs[-1][1]} != counter {seq[0][0] if seq else None}")
    first = zs[0][2] if zs else None
    early = _rows(db, "SELECT id FROM bills WHERE restaurant_id = :rid AND finalized_at < :f", rid, f=first) if first else []
    chain += [f"bill {r[0]} finalized before the first Z period" for r in early[:SAMPLE]]
    last_to = zs[-1][3] if zs else None
    return [
        {"name": "z_reports_internally_consistent", "ok": not arith, "severity": "error", "sample": arith[:SAMPLE],
         "detail": "every stored Z report's totals add up" if not arith else f"{len(arith)} Z report(s) inconsistent"},
        {"name": "z_periods_contiguous_no_bill_in_two_or_none", "ok": not chain, "severity": "error",
         "sample": chain[:SAMPLE], "detail": "Z numbers gapless; each period starts where the previous ended"
         if not chain else f"{len(chain)} problem(s) with Z numbering/periods"},
        {"name": "z_snapshot_matches_live_bills", "ok": not live, "severity": "error", "sample": live[:SAMPLE],
         "detail": "each Z report's bill count/total equals the bills finalized in its period" if not live
         else f"{len(live)} Z report(s) differ from the live bills of their period"},
    ]


def _amendment_checks(db: Session, rid: uuid.UUID) -> list[dict]:
    """Bill corrections (credit note + replacement, services/amend.py): chains are well formed, each original is
    cancelled in full by exactly one credit note (original + credit note net to zero), and the replacement is settled
    from the original's payments (credit-note payment = min(paid, new total); the rest is paid out or still due)."""
    chain = _rows(db, """
        SELECT b.id FROM bills b WHERE b.restaurant_id = :rid AND (
            (b.status = 'superseded' AND (b.superseded_by_bill_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM bills n WHERE n.id = b.superseded_by_bill_id AND n.amends_bill_id = b.id
                  AND n.order_id = b.order_id AND n.restaurant_id = b.restaurant_id)))
            OR (b.status = 'active' AND b.superseded_by_bill_id IS NOT NULL)
            OR (b.amends_bill_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM bills o WHERE o.id = b.amends_bill_id AND o.superseded_by_bill_id = b.id
                  AND o.status = 'superseded' AND o.order_id = b.order_id AND o.restaurant_id = b.restaurant_id
                  AND o.sale_at = b.sale_at AND o.finalized_at <= b.finalized_at))
            OR b.status NOT IN ('active', 'superseded', 'voided')
            OR (b.status = 'voided' AND (b.voided_at IS NULL OR b.superseded_by_bill_id IS NOT NULL)))
        UNION ALL
        SELECT o.order_id FROM bills o WHERE o.restaurant_id = :rid
          GROUP BY o.order_id HAVING count(*) FILTER (WHERE o.status = 'active') > 1
             OR (count(*) FILTER (WHERE o.status = 'active') = 0 AND count(*) FILTER (WHERE o.status = 'voided') = 0)""", rid)
    cn = _rows(db, """
        SELECT b.id FROM bills b WHERE b.restaurant_id = :rid AND b.status = 'superseded' AND (
            SELECT count(*) FROM refunds r WHERE r.bill_id = b.id AND r.kind = 'amendment') <> 1
        UNION ALL
        SELECT r.bill_id FROM refunds r JOIN bills b ON b.id = r.bill_id WHERE r.restaurant_id = :rid AND r.kind = 'amendment'
          AND (b.status <> 'superseded' OR r.amount <> b.total OR r.tax_amount <> b.tax_amount OR r.round_off <> b.round_off
               OR r.replacement_bill_id IS DISTINCT FROM b.superseded_by_bill_id)""", rid)
    pay = _rows(db, """
        SELECT r.replacement_bill_id FROM refunds r JOIN bills o ON o.id = r.bill_id JOIN bills n ON n.id = r.replacement_bill_id
        WHERE r.restaurant_id = :rid AND r.kind = 'amendment' AND (
            COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.bill_id = n.id AND p.method = 'credit_note'), 0)
              <> LEAST(COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.bill_id = o.id), 0), n.total)
            OR r.payout_amount <> GREATEST(COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.bill_id = o.id), 0) - n.total, 0)
            OR (r.payout_amount > 0 AND r.payout_method IS NULL))""", rid)
    void = _rows(db, """
        SELECT b.id FROM bills b WHERE b.restaurant_id = :rid AND b.status = 'voided' AND (
            SELECT count(*) FROM refunds r WHERE r.bill_id = b.id AND r.kind = 'void') <> 1
        UNION ALL
        SELECT r.bill_id FROM refunds r JOIN bills b ON b.id = r.bill_id WHERE r.restaurant_id = :rid AND r.kind = 'void'
          AND (b.status <> 'voided' OR r.amount <> b.total OR r.tax_amount <> b.tax_amount
               OR r.payout_amount <> COALESCE((SELECT -sum(p.amount) FROM payments p WHERE p.bill_id = b.id AND p.amount < 0), 0))""", rid)
    stray = _rows(db, """
        SELECT p.id FROM payments p JOIN bills b ON b.id = p.bill_id WHERE b.restaurant_id = :rid AND p.method = 'credit_note'
          AND b.amends_bill_id IS NULL""", rid)
    return [
        _violations("amendment_chains_wellformed", chain,
                    "every correction chain is linked both ways, keeps the sale date and has exactly one current version",
                    "bill(s) with a broken correction chain"),
        _violations("amendment_credit_notes_cancel_originals", cn,
                    "every corrected original is cancelled in full by exactly one credit note (net zero)",
                    "corrected bill(s) whose credit note is missing, duplicated or not equal to the original"),
        _violations("void_credit_notes_cancel_bills", void,
                    "every voided bill is cancelled in full by exactly one credit note and the money to return equals the cash-out rows",
                    "voided bill(s) whose credit note is missing, duplicated or not equal to the bill"),
        _violations("amendment_payments_reconcile", pay + stray,
                    "replacement payments = min(paid on the original, new total); any excess was paid out",
                    "correction(s) whose payments / payout do not reconcile"),
    ]


def run(db: Session, rid: uuid.UUID) -> list[dict]:
    out: list[dict] = []
    add = out.append

    add(_violations("bill_total_equals_subtotal_plus_tax", _rows(db, """
        SELECT id FROM bills WHERE restaurant_id = :rid AND total <> subtotal + tax_amount + round_off""", rid),
        "every bill total = subtotal + tax + round-off (round-off is 0 outside GST bills)", "bill(s) where total <> subtotal + tax + round-off"))
    # sum(line amounts) - discount + service charge == total (prices incl. tax) or subtotal (prices excl. tax).
    # Old bills have no discount/service charge and are tax-exclusive, so this is the original check for them.
    add(_violations("bill_subtotal_equals_lines", _rows(db, """
        SELECT b.id FROM bills b LEFT JOIN bill_lines l ON l.bill_id = b.id WHERE b.restaurant_id = :rid
        GROUP BY b.id, b.subtotal, b.total, b.discount_amount, b.service_charge_amount, b.prices_include_tax, b.round_off,
                 b.packaging_amount, b.delivery_amount
        HAVING COALESCE(SUM(l.line_total), 0) - b.discount_amount + b.service_charge_amount + b.packaging_amount
               + b.delivery_amount <> CASE WHEN b.prices_include_tax THEN b.total - b.round_off ELSE b.subtotal END""", rid),
        "every bill: sum(lines) - discount + service charge = total (inclusive prices) / subtotal (exclusive)",
        "bill(s) where lines, discount and service charge do not add up"))
    add(_violations("bill_tax_matches_snapshot_rate", _rows(db, """
        SELECT id FROM bills WHERE restaurant_id = :rid AND NOT prices_include_tax
          AND (tax_breakdown IS NULL OR (json_typeof(tax_breakdown) = 'array' AND json_array_length(tax_breakdown) = 1
                                         AND tax_breakdown->0->>'code' = 'standard'))
          AND tax_amount <> ROUND(subtotal * tax_rate_percent / 100, 2)""", rid),
        "every single-rate tax-exclusive bill's tax = subtotal x its snapshot rate (multi-rate and inclusive bills: "
        "see bill_breakdown_consistent)",
        "single-rate bill(s) with tax not matching the snapshot rate"))
    add(_breakdown_checks(db, rid))
    add(_violations("payments_within_bill_total", _rows(db, """
        SELECT b.id FROM bills b JOIN payments p ON p.bill_id = b.id WHERE b.restaurant_id = :rid
        GROUP BY b.id, b.total HAVING SUM(p.amount) > b.total""", rid),
        "payments never exceed the bill total", "bill(s) overpaid"))
    add(_violations("refunds_within_payments", _rows(db, """
        SELECT b.id FROM bills b JOIN refunds r ON r.bill_id = b.id WHERE b.restaurant_id = :rid AND r.kind = 'refund'
        GROUP BY b.id HAVING SUM(r.amount) > COALESCE(
            (SELECT SUM(p.amount) FROM payments p WHERE p.bill_id = b.id), 0)""", rid),
        "refunds never exceed payments", "bill(s) refunded beyond what was paid"))
    add(_violations("tenant_consistent_financials", _rows(db, """
        SELECT p.id FROM payments p JOIN bills b ON b.id = p.bill_id
          WHERE (p.restaurant_id = :rid OR b.restaurant_id = :rid) AND p.restaurant_id <> b.restaurant_id
        UNION ALL SELECT r.id FROM refunds r JOIN bills b ON b.id = r.bill_id
          WHERE (r.restaurant_id = :rid OR b.restaurant_id = :rid) AND r.restaurant_id <> b.restaurant_id
        UNION ALL SELECT b.id FROM bills b JOIN orders o ON o.id = b.order_id
          WHERE (b.restaurant_id = :rid OR o.restaurant_id = :rid) AND b.restaurant_id <> o.restaurant_id""", rid),
        "payments, refunds and bills all belong to their bill's / order's restaurant",
        "record(s) pointing at another restaurant's bill/order"))
    add(_gapless(db, rid, "invoice_numbers_gapless", "bills", "invoice_number", "INV"))
    add(_gapless(db, rid, "credit_notes_gapless", "refunds", "credit_note_number", "CN"))
    add(_gapless_gst(db, rid, "gst_invoice_numbers_gapless", "bills", "invoice_number", "",
                     {"INV": "GINV", "BOS": "GBOS"}))
    add(_gapless_gst(db, rid, "gst_credit_notes_gapless", "refunds", "credit_note_number", "", {"CN": "GCN"}))

    kot = _rows(db, "SELECT count(*), count(DISTINCT number), COALESCE(min(number), 1), COALESCE(max(number), 0) "
                    "FROM kot_tickets WHERE restaurant_id = :rid", rid)[0]
    counter = _rows(db, "SELECT last_number FROM invoice_sequences WHERE restaurant_id = :rid AND kind = 'KOT' "
                        "AND year = 0", rid)
    kot_ok = kot[0] == kot[1] == kot[3] and kot[2] == 1 and (counter[0][0] if counter else 0) == kot[3]
    add({"name": "kot_numbers_gapless", "ok": kot_ok, "severity": "error", "sample": [],
         "detail": "KOT numbers are gapless and unique" if kot_ok else
         f"KOT numbering broken: count={kot[0]} distinct={kot[1]} range={kot[2]}..{kot[3]} "
         f"counter={counter[0][0] if counter else None}"})

    add(_violations("order_status_consistent", _rows(db, """
        SELECT o.id FROM orders o LEFT JOIN bills b ON b.order_id = o.id WHERE o.restaurant_id = :rid AND (
            (o.status = 'billed') <> (b.id IS NOT NULL)
            OR (o.status = 'cancelled' AND (o.cancel_reason IS NULL OR o.cancelled_at IS NULL))
            OR (o.status = 'cancelled' AND EXISTS (SELECT 1 FROM kot_tickets k WHERE k.order_id = o.id
                                                    AND k.status IN ('pending', 'preparing'))))""", rid),
        "billed <=> has a bill; cancelled orders carry a reason and have no open KOTs, never a bill",
        "order(s) with inconsistent status (billed/cancelled mix, missing bill, open KOT on cancelled)"))

    # --- stock ---
    per_type = _rows(db, """SELECT item_id, movement_type::text, SUM(quantity) FROM stock_movements
                            WHERE restaurant_id = :rid GROUP BY 1, 2""", rid)
    totals = {i: Decimal(b) for i, b in _rows(db, """SELECT item_id, SUM(quantity) FROM stock_movements
                                                     WHERE restaurant_id = :rid GROUP BY 1""", rid)}
    recomputed: dict = {}
    for item_id, _t, q in per_type:
        recomputed[item_id] = recomputed.get(item_id, Decimal(0)) + Decimal(q)
    drift = [i for i in totals if totals[i] != recomputed.get(i)]
    add({"name": "stock_balance_recomputes", "ok": not drift, "severity": "error",
         "detail": "ledger balance equals the sum of its sale/purchase/adjustment/wastage/count parts" if not drift
         else f"{len(drift)} item(s) with balance drift", "sample": [str(i) for i in drift[:SAMPLE]]})
    add(_violations("stock_movement_signs", _rows(db, """
        SELECT id FROM stock_movements WHERE restaurant_id = :rid AND (
            (movement_type IN ('sale', 'wastage') AND quantity > 0) OR (movement_type = 'purchase' AND quantity <= 0))""", rid),
        "sale/wastage only reduce stock; purchases only add", "movement(s) with the wrong sign"))
    add(_violations("stock_movements_tenant_consistent", _rows(db, """
        SELECT m.id FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id
        WHERE (m.restaurant_id = :rid OR i.restaurant_id = :rid) AND m.restaurant_id <> i.restaurant_id""", rid),
        "every movement belongs to its item's restaurant", "movement(s) pointing at another restaurant's item"))
    add(_violations("negative_stock_balance", _rows(db, """
        SELECT i.id FROM inventory_items i JOIN stock_movements m ON m.item_id = i.id
        WHERE i.restaurant_id = :rid GROUP BY i.id HAVING SUM(m.quantity) < 0""", rid),
        "no item has a negative balance", "item(s) with a negative balance (sales exceeded recorded stock)",
        severity="warning"))
    add(_violations("sale_movements_for_recipe_bills", _rows(db, """
        SELECT DISTINCT b.id FROM bills b JOIN bill_lines ol ON ol.bill_id = b.id
        JOIN recipes r ON r.menu_item_id = ol.item_id AND r.effective_from <= b.finalized_at
                      AND (r.effective_to IS NULL OR r.effective_to > b.finalized_at)
        WHERE b.restaurant_id = :rid AND NOT EXISTS (
            SELECT 1 FROM stock_movements m WHERE m.ref_id = b.id AND m.movement_type = 'sale')""", rid),
        "every finalized bill with recipes has its sale movements", "finalized bill(s) with recipes but no sale movements"))
    add(_violations("sale_movements_belong_to_bills", _rows(db, """
        SELECT m.id FROM stock_movements m LEFT JOIN bills b ON b.id = m.ref_id AND b.restaurant_id = m.restaurant_id
        WHERE m.restaurant_id = :rid AND m.movement_type = 'sale' AND b.id IS NULL""", rid),
        "every sale movement references a finalized bill (cancelled/unbilled orders never consume stock)",
        "sale movement(s) without a finalized bill"))
    add(_violations("confirmed_purchases_have_movements", _rows(db, """
        SELECT p.id FROM purchase_invoices p WHERE p.restaurant_id = :rid AND p.status = 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.ref_id = p.id AND m.movement_type = 'purchase')""", rid),
        "every confirmed purchase posted stock", "confirmed purchase(s) without stock movements"))
    add(_violations("purchase_movements_have_confirmed_invoice", _rows(db, """
        SELECT m.id FROM stock_movements m LEFT JOIN purchase_invoices p
            ON p.id = m.ref_id AND p.restaurant_id = m.restaurant_id AND p.status = 'confirmed'
        WHERE m.restaurant_id = :rid AND m.movement_type = 'purchase' AND p.id IS NULL""", rid),
        "every purchase movement comes from a confirmed purchase", "purchase movement(s) without a confirmed purchase"))
    add(_violations("open_alerts_only_for_low_items", _rows(db, """
        SELECT a.id FROM alerts a JOIN inventory_items i ON i.id = a.item_id
        WHERE a.restaurant_id = :rid AND a.status = 'open' AND a.kind = 'low_stock' AND NOT (
            i.reorder_level > 0 AND COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                                              WHERE m.item_id = i.id), 0) <= i.reorder_level)""", rid),
        "no open low-stock alert for an item above its reorder level", "open alert(s) for items above reorder level"))
    out += _amendment_checks(db, rid)
    out += _z_report_checks(db, rid)
    return out
