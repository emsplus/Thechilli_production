import io
from decimal import Decimal
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo

from reportlab.lib import colors
from reportlab.lib.pagesizes import A5
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.models.core import Bill
from app.services import localisation as L, thermal as T
from app.services.money import fmt_amount, fmt_inr_ascii, tax_word as _tax_word
from app.services.thermal import Slip

ZERO = Decimal("0")


class View:
    """The facts of a bill the renderers need. Every field has a fallback, so bills finalized before the tax snapshot
    columns existed (and test doubles) still render."""

    def __init__(self, bill):
        g = lambda k, d: (getattr(bill, k, None) if getattr(bill, k, None) is not None else d)
        self.inclusive = bool(g("prices_include_tax", False))
        # A GST-registered seller = the flag AND a GSTIN on the bill. Without a GSTIN (the sign-up default is "registered", the
        # GSTIN comes later) the document is a plain BILL: no "TAX INVOICE", no GSTIN line, no GST breakdown (docs/INDIA.md).
        self.registered = bool(g("vat_registered", True)) and bool(str(g("seller_trn", "") or "").strip())
        self.tax_charged_unregistered = (not self.registered) and Decimal(g("tax_amount", 0)) > 0 and not bool(g("prices_include_tax", False))
        self.breakdown = g("tax_breakdown", None) or []
        self.discount = Decimal(g("discount_amount", 0))
        self.discount_reason = g("discount_reason", None)
        offers = g("offers", None)
        self.offers = offers if isinstance(offers, dict) and offers.get("applied") else None
        self.sc = Decimal(g("service_charge_amount", 0))
        self.sc_pct = Decimal(g("service_charge_percent", 0))
        self.title = L.INVOICE_TITLE if self.registered else L.UNREGISTERED_TITLE
        self.number_label = "Invoice No" if self.registered else "Bill No"
        self.tax_label = L.TAX_NUMBER_LABEL
        self.tax_word = _tax_word(g("tax_mode", "off"))
        self.items_total = sum((l.line_total for l in bill.lines), ZERO)
        self.gst = gst_facts(bill, self)
        if self.gst:
            self.title = self.gst["title"]

    @staticmethod
    def fmt(x) -> str:
        """An amount column / line: '12,34,567.50' (the rupee prefix goes on totals only, through fmt_inr_ascii)."""
        return fmt_amount(x)

    amt = fmt

    @staticmethod
    def signed(x) -> str:
        """A round-off: '+0.40' / '-0.30'."""
        return ("+" if Decimal(str(x)) > 0 else "") + fmt_amount(x)


def gst_facts(bill, v: "View") -> dict | None:
    """India GST bills (tax_mode gst_engine): everything the renderers print beyond the generic layout. The 'pending CA
    verification' statement is deliberately NOT here: it is an internal admin warning, never printed on a customer document."""
    if getattr(bill, "tax_mode", "off") != "gst_engine":
        return None
    from app.services import gst as G
    z = lambda k: Decimal(getattr(bill, k, 0) or 0)
    composition = getattr(bill, "document_type", "tax_invoice") == "bill_of_supply"
    rows = []
    for r in (getattr(bill, "tax_breakdown", None) or []):
        rate = Decimal(str(r["rate_percent"]))
        c, sg, ig = (Decimal(str(r.get(k) or 0)) for k in ("cgst", "sgst", "igst"))
        if c:
            rows.append((f"CGST {pct(rate / 2)}", c))
        if sg:
            rows.append((f"SGST {pct(rate / 2)}", sg))
        if ig:
            rows.append((f"IGST {pct(rate)}", ig))
    charges = []
    if z("packaging_amount") > 0:
        charges.append(("Packaging charge", z("packaging_amount")))
    if z("delivery_amount") > 0:
        charges.append(("Delivery charge", z("delivery_amount")))
    legend = None
    if composition:
        cfg = (getattr(bill, "gst_document", None) or {}).get("pos_legend")
        legend = cfg or G.DEFAULT_COMPOSITION_LEGEND
    return {"title": "BILL OF SUPPLY" if composition else "TAX INVOICE", "composition": composition, "legend": legend,
            "place_of_supply": getattr(bill, "place_of_supply", None), "customer_gstin": getattr(bill, "customer_gstin", None),
            "tax_rows": rows, "charges": charges, "round_off": z("round_off"),
            "hsn": [getattr(l, "hsn", None) for l in bill.lines]}


def pct(x) -> str:
    return f"{Decimal(x).normalize():f}%"


def rate_rows(bill) -> list[dict]:
    """Breakdown rows, or the single legacy tax line as one row."""
    rows = getattr(bill, "tax_breakdown", None)
    if rows:
        return [{"code": r["code"], "rate_percent": Decimal(str(r["rate_percent"])), "net": Decimal(str(r["net"])),
                 "vat": Decimal(str(r["vat"])), "gross": Decimal(str(r["gross"]))} for r in rows]
    return [{"code": "standard", "rate_percent": bill.tax_rate_percent, "net": bill.subtotal,
             "vat": bill.tax_amount, "gross": bill.total}]


def _discount_text(reason: str | None) -> str:
    """'Discount (Staff meal)'; no reason, or the default label stored when none was given: just 'Discount'."""
    return f"Discount ({reason})" if reason and reason.strip().casefold() != "discount" else "Discount"


def discount_label(v: "View") -> str:
    return _discount_text(v.discount_reason)


def discount_rows(v: "View") -> list[tuple[str, Decimal]]:
    """The bill's discount lines: one 'Offer: <name>' line per automatic offer, then the manual discount (docs/
    MODIFIERS_OFFERS.md). Bills without offers keep their single 'Discount (reason)' line."""
    if v.discount <= 0:
        return []
    if not v.offers:
        return [(discount_label(v), v.discount)]
    rows = [(str(a.get("label") or a.get("name")), Decimal(str(a["amount"]))) for a in v.offers["applied"]]
    manual = v.discount - sum((a for _, a in rows), ZERO)
    if manual > 0:
        mr = v.offers.get("manual_reason")
        rows.append((_discount_text(mr), manual))
    return rows


def sc_label(v: "View") -> str:
    return f"Service charge {pct(v.sc_pct)}" if v.sc_pct else "Service charge"


def render_receipt_a5(bill: Bill, tz: str, db=None) -> bytes:
    """A5 invoice PDF built purely from the finalized snapshot (reprints never recompute)."""
    v = View(bill)
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A5, leftMargin=12 * mm, rightMargin=12 * mm,
                            topMargin=12 * mm, bottomMargin=12 * mm, title=bill.invoice_number,
                            pageCompression=Slip.COMPRESS)  # tests set 0 to read the drawn text
    st = getSampleStyleSheet()
    cur = L.CURRENCY
    when = (getattr(bill, "sale_at", None) or bill.finalized_at).astimezone(ZoneInfo(tz)).strftime("%d %b %Y %H:%M")
    notes = amend_notes(db, bill, tz)
    el = []
    el.append(Paragraph(f"<b>{bill.seller_name}</b>", st["Title"]))
    if bill.seller_address:
        el.append(Paragraph(bill.seller_address, st["Normal"]))
    if getattr(bill, "seller_phone", None):
        el.append(Paragraph(f"Tel: {bill.seller_phone}", st["Normal"]))
    if bill.seller_trn and v.registered:
        el.append(Paragraph(f"{v.tax_label}: {bill.seller_trn}", st["Normal"]))
    if v.gst and v.gst["customer_gstin"]:
        el.append(Paragraph(f"Customer GSTIN: {escape(v.gst['customer_gstin'])}", st["Normal"]))
    el += [Spacer(1, 4 * mm), Paragraph(f"<b>{v.title}</b>", st["Heading3"]),
           Paragraph(f"{v.number_label}: {bill.invoice_number}<br/>Date: {when}", st["Normal"])]
    snap = snapshot_fallbacks(db, bill)
    who = [f"Customer: {escape(snap['customer_name'])}"] if snap["customer_name"] else []
    if snap["customer_phone"]:
        who.append(f"Phone: {escape(snap['customer_phone'])}")
    if snap["token_number"] is not None:
        who.append(f"Token: {snap['token_number']}")
    if snap["order_note"]:
        who.append(f"Note: {escape(snap['order_note'])}")
    if who:  # each line only when present (a customer may have only a name or only a phone)
        el.append(Paragraph("<br/>".join(who), st["Normal"]))
    if notes["voided"]:
        el.append(Paragraph(f"<b>{notes['voided']}</b> (cancelled, not valid)", st["Normal"]))
    if notes["superseded_by"]:
        el.append(Paragraph(f"<b>{notes['superseded_by']}</b> (cancelled by a correction, not valid)", st["Normal"]))
    for key in ("replaces", "corrected_on"):
        if notes[key]:
            el.append(Paragraph(notes[key], st["Normal"]))
    el.append(Spacer(1, 4 * mm))
    rows = [["Item", "Qty", "Rate", f"Amount ({cur})"]]
    for i, l in enumerate(bill.lines):
        hsn = v.gst["hsn"][i] if v.gst else None
        rows.append([l.description + (f"\nHSN/SAC {hsn}" if hsn else ""), str(l.quantity), f"{v.amt(l.unit_price)}", f"{v.amt(l.line_total)}"])
    t = Table(rows, colWidths=[55 * mm, 12 * mm, 20 * mm, 28 * mm], repeatRows=1)
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.black),
                           ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("FONTSIZE", (0, 0), (-1, -1), 8)]))
    el += [t, Spacer(1, 4 * mm)]
    extra = []  # discount / service charge lines (only when present)
    for lbl, amt in discount_rows(v):
        extra.append([lbl, f"-{v.amt(amt)}"])
    if v.sc > 0:
        extra.append([sc_label(v), f"{v.amt(v.sc)}"])
    cw = [85 * mm, 30 * mm]  # same 115 mm as the items table
    if v.gst:  # India GST: charges, taxable value, CGST / SGST / IGST, explicit round-off, total
        g = v.gst
        extra += [[lbl, f"{v.amt(amt)}"] for lbl, amt in g["charges"]]
        taxes = [[lbl, f"{v.amt(amt)}"] for lbl, amt in g["tax_rows"]]
        rows2 = list(extra)
        if not v.inclusive:
            rows2 += [["Taxable value", f"{v.amt(bill.subtotal)}"]] + taxes
        if g["round_off"]:
            rows2.append(["Round off", v.signed(g["round_off"])])
        rows2.append([f"Total ({cur})", f"{v.amt(bill.total)}"])
        tot = Table(rows2, colWidths=cw)
        last = len(rows2) - 1
        tot.setStyle(TableStyle([("ALIGN", (1, 0), (1, -1), "RIGHT"), ("FONTNAME", (0, last), (-1, last), "Helvetica-Bold"),
                                 ("LINEABOVE", (0, last), (-1, last), 0.6, colors.black)]))
        el.append(tot)
        if v.inclusive and (taxes or not g["composition"]):
            inc = [["Taxable value", f"{v.amt(bill.subtotal)}"]] + taxes
            el += [Spacer(1, 2 * mm), Paragraph(f"<font size=8>{v.tax_word} included in the total:</font>", st["Normal"]),
                   Table(inc, colWidths=cw, style=TableStyle([("ALIGN", (1, 0), (1, -1), "RIGHT"), ("FONTSIZE", (0, 0), (-1, -1), 8)]))]
        if g["place_of_supply"]:
            el.append(Paragraph(f"<font size=8>Place of supply: {g['place_of_supply']}</font>", st["Normal"]))
        if g["legend"]:
            el.append(Paragraph(f"<font size=8>{escape(g['legend'])}</font>", st["Normal"]))
    elif v.inclusive:
        rows2 = ([["Sub total", f"{v.amt(v.items_total)}"]] if extra else []) + extra
        rows2.append([f"Total ({cur})", f"{v.amt(bill.total)}"])
        tot = Table(rows2, colWidths=cw)
        last = len(rows2) - 1
        tot.setStyle(TableStyle([("ALIGN", (1, 0), (1, -1), "RIGHT"), ("FONTSIZE", (0, 0), (-1, -1), 8.5),
                                 ("FONTNAME", (0, last), (-1, last), "Helvetica-Bold"), ("FONTSIZE", (0, last), (-1, last), 10),
                                 ("LINEABOVE", (0, last), (-1, last), 0.6, colors.black)]))
        el.append(tot)
        if v.registered:
            vt = [[f"{v.tax_word} rate", "Net", v.tax_word, "Gross"]] + [
                [f"{r['code'].title()} {pct(r['rate_percent'])}", f"{v.amt(r['net'])}", f"{v.amt(r['vat'])}", f"{v.amt(r['gross'])}"]
                for r in rate_rows(bill)]
            tb = Table(vt, colWidths=[40 * mm, 25 * mm, 25 * mm, 25 * mm])
            tb.setStyle(TableStyle([("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("FONTSIZE", (0, 0), (-1, -1), 8),
                                    ("LINEBELOW", (0, 0), (-1, 0), 0.4, colors.black)]))
            el += [Spacer(1, 4 * mm), tb, Spacer(1, 2 * mm), Paragraph(f"<font size=8>Prices include {v.tax_word}</font>", st["Normal"])]
    else:
        rows2 = list(extra)
        if v.registered:
            rows2.append(["Taxable value", f"{v.amt(bill.subtotal)}"])
            brk = rate_rows(bill) if len(v.breakdown) > 1 else None
            if brk:
                rows2 += [[f"{v.tax_word} {pct(r['rate_percent'])}", f"{v.amt(r['vat'])}"] for r in brk]
            else:
                rows2.append([_tax_label(bill, v), f"{v.amt(bill.tax_amount)}"])
        elif v.tax_charged_unregistered:  # the bill added tax although no GSTIN is set: one plain line so the total adds up
            rows2 += [["Sub total", f"{v.amt(bill.subtotal)}"], ["Taxes", f"{v.amt(bill.tax_amount)}"]]
        rows2.append([f"Total payable ({cur})", f"{v.amt(bill.total)}"])
        tot = Table(rows2, colWidths=cw)
        last = len(rows2) - 1
        tot.setStyle(TableStyle([("ALIGN", (1, 0), (1, -1), "RIGHT"), ("FONTNAME", (0, last), (-1, last), "Helvetica-Bold"),
                                 ("LINEABOVE", (0, last), (-1, last), 0.6, colors.black)]))
        el.append(tot)
    doc.build(el)
    return buf.getvalue()




TYPE_LABEL = {"indoor": "Dine In", "outdoor": "Outdoor", "takeaway": "Takeaway", "delivery": "Delivery"}


def type_label(v: str | None) -> str | None:
    return TYPE_LABEL.get(v, v.title() if v else None) if v else None


def _tax_label(bill: Bill, v: "View | None" = None) -> str:
    rate = f"{bill.tax_rate_percent.normalize():f}"
    return f"{(v.tax_word if v is not None else _tax_word(getattr(bill, 'tax_mode', 'off')))} {rate}%"


def amend_notes(db, bill: Bill, tz: str) -> dict:
    """Wording for corrected bills: a replacement says what it replaces; a superseded original says by what."""
    from sqlalchemy import select
    from app.models.core import Refund
    out = {"replaces": None, "corrected_on": None, "superseded_by": None, "orig_number": None, "voided": None}
    if db is None or not isinstance(bill, Bill):
        return out
    if bill.amends_bill_id:
        orig = db.get(Bill, bill.amends_bill_id)
        cn = db.scalar(select(Refund.credit_note_number).where(Refund.bill_id == bill.amends_bill_id,
                                                                Refund.kind == "amendment"))
        if orig:
            out["orig_number"] = orig.invoice_number
            out["replaces"] = f"Replaces {orig.invoice_number}" + (f" (credit note {cn})" if cn else "")
        if bill.amended_at:
            out["corrected_on"] = "Corrected on " + bill.amended_at.astimezone(ZoneInfo(tz)).strftime("%d/%m/%Y %H:%M")
    if bill.status == "voided":
        when = f" on {bill.voided_at.astimezone(ZoneInfo(tz)).strftime('%d/%m/%Y %H:%M')}" if bill.voided_at else ""
        out["voided"] = f"VOID{when}"
    if bill.status == "superseded" and bill.superseded_by_bill_id:
        nxt = db.get(Bill, bill.superseded_by_bill_id)
        if nxt:
            out["superseded_by"] = f"SUPERSEDED by {nxt.invoice_number}"
    return out


def snapshot_fallbacks(db, bill: Bill) -> dict:
    """Print fields for bills finalized before the snapshot columns existed: live lookups, else omitted."""
    from app.models.core import Customer, DiningTable, Order, User
    out = {"customer_name": bill.customer_name, "customer_phone": bill.customer_phone,
           "table_label": bill.table_label, "order_type": bill.order_type, "cashier_name": bill.cashier_name}
    out.update(token_number=None, order_note=None)
    if db is None:
        return out
    order = db.get(Order, bill.order_id)
    if order:
        out["token_number"], out["order_note"] = order.token_number, order.note
    if all(out[k] for k in ("customer_name", "customer_phone", "table_label", "order_type", "cashier_name")):
        return out
    if order:
        if not out["customer_name"] and not out["customer_phone"] and order.customer_id and (c := db.get(Customer, order.customer_id)):
            out["customer_name"], out["customer_phone"] = c.name, c.phone
        if not out["table_label"] and order.table_id and (t := db.get(DiningTable, order.table_id)):
            out["table_label"] = t.label
        out["order_type"] = out["order_type"] or order.order_type.value
    if not out["cashier_name"] and (u := db.get(User, bill.finalized_by)):
        out["cashier_name"] = u.full_name
    return out


def render_receipt(bill: Bill, tz: str, size: str = "thermal", db=None) -> bytes:
    """Invoice / receipt PDF from the finalized snapshot (reprints never recompute). Default: 80 mm thermal roll."""
    if size == "a5":
        return render_receipt_a5(bill, tz, db)
    snap = snapshot_fallbacks(db, bill)
    v = View(bill)
    fmt = v.fmt
    cur = L.CURRENCY
    when = (getattr(bill, "sale_at", None) or bill.finalized_at).astimezone(ZoneInfo(tz))  # the sale's own date (a replacement keeps the original's)
    notes = amend_notes(db, bill, tz)
    s = Slip(bill.invoice_number)
    s.line(bill.seller_name, 13, True, extra=1)
    if bill.seller_address:
        s.line(bill.seller_address, 8)
    if getattr(bill, "seller_phone", None):
        s.line(f"Tel: {bill.seller_phone}", 8)
    if bill.seller_trn and v.registered:
        s.line(f"{v.tax_label}: {bill.seller_trn}", 8.5, True)
    s.space(3)
    s.line(v.title, 12, True)
    if notes["voided"]:
        s.line(notes["voided"], 11, True)
        s.line("Voided. Not valid.", 8, grey=True)
    if notes["superseded_by"]:
        s.line(notes["superseded_by"], 11, True)
        s.line("Cancelled by a correction. Not valid.", 8, grey=True)
    for key in ("replaces", "corrected_on"):
        if notes[key]:
            s.line(notes[key], 8.5, key == "replaces")
    s.rule(heavy=True)
    # A customer may have only a name or only a phone: print each line only when present.
    if snap["customer_name"]:
        s.labelled("Name: ", snap["customer_name"])
    if snap["customer_phone"]:
        s.labelled("Phone: ", snap["customer_phone"])
    if snap["customer_name"] or snap["customer_phone"]:
        s.space(1)
    otype = type_label(snap["order_type"])
    s.pair(f"Date: {when.strftime('%d/%m/%Y')}", f"Bill#: {bill.invoice_number}")
    if snap["table_label"]:
        s.pair(f"Time: {when.strftime('%I:%M %p').lstrip('0')}", f"Table: {snap['table_label']}")
        if otype:
            s.pair("", f"Type: {otype}")
    else:
        s.pair(f"Time: {when.strftime('%I:%M %p').lstrip('0')}", f"Type: {otype}" if otype else "")
    if snap["token_number"] is not None:
        s.pair(f"Token: {snap['token_number']}", "")
    if snap["order_note"]:
        s.labelled("Note: ", snap["order_note"])
    s.rule()
    # items table: Item | Qty | Price | Amt
    qx, px, ax = T.MARGIN + 102, T.WIDTH - T.MARGIN - 52, T.WIDTH - T.MARGIN
    name_w = 100.0
    s.text("Item", 8.5, True)
    s.text("Qty", 8.5, True, "r", x=qx + 14)
    s.text("Price", 8.5, True, "r", x=px)
    s.text("Amt", 8.5, True, "r", x=ax)
    s.advance(8.5)
    s.rule(dashed=True, pad=1.5)
    for li, l in enumerate(bill.lines):
        names = T.wrap(l.description, T.REG, 8.5, name_w)
        if v.gst and v.gst["hsn"][li]:
            names = [*names, f"HSN/SAC {v.gst['hsn'][li]}"]
        s.text(names[0], 8.5)
        for x, val in ((qx + 14, str(l.quantity)), (px, fmt(l.unit_price)), (ax, fmt(l.line_total))):
            s.text(val, 8.5, False, "r", x=x, fit_to=(50 if x != qx + 14 else 22))
        s.advance(8.5)
        for extra in names[1:]:
            s.text(extra, 8.5)
            s.advance(8.5)
        s.space(1.5)
    s.rule()
    qty = sum(l.quantity for l in bill.lines)
    s.pair("Total Qty", str(qty))
    adjusted = v.discount > 0 or v.sc > 0
    if v.gst:
        g = v.gst
        if adjusted or g["charges"]:
            s.pair("Sub Total", fmt(v.items_total))
        for lbl, amt in discount_rows(v):
            s.pair(lbl, f"-{fmt(amt)}")
        if v.sc > 0:
            s.pair(sc_label(v), fmt(v.sc))
        for lbl, amt in g["charges"]:
            s.pair(lbl, fmt(amt))
        if not v.inclusive:
            s.pair("Taxable value", fmt(bill.subtotal))
            for lbl, amt in g["tax_rows"]:
                s.pair(lbl, fmt(amt))
        if g["round_off"]:
            s.pair("Round off", v.signed(g["round_off"]))
        s.rule(heavy=True)
        s.pair("Total", fmt_inr_ascii(bill.total), size=14, bold=True)
        s.rule(pad=2)
        if v.inclusive:
            s.line(f"{v.tax_word} included in the total:", 7.5, grey=True)
            s.pair("Taxable value", fmt(bill.subtotal), size=7.5)
            for lbl, amt in g["tax_rows"]:
                s.pair(lbl, fmt(amt), size=7.5)
        if g["place_of_supply"]:
            s.line(f"Place of supply: {g['place_of_supply']}", 7.5, grey=True)
        if g["legend"]:
            s.line(g["legend"], 7.5, grey=True)
    elif v.inclusive:
        if adjusted:
            s.pair("Sub Total", fmt(v.items_total))
        for lbl, amt in discount_rows(v):
            s.pair(lbl, f"-{fmt(amt)}")
        if v.sc > 0:
            s.pair(sc_label(v), fmt(v.sc))
        s.rule(heavy=True)
        s.pair("Total", fmt_inr_ascii(bill.total), size=14, bold=True)
        s.rule(pad=2)
        if v.registered:  # compact tax summary by rate
            rows = rate_rows(bill)
            nx, vx, gx = T.MARGIN + 104, T.MARGIN + 150, T.WIDTH - T.MARGIN
            s.text(f"{v.tax_word} rate", 7.5, True)
            for x, h in ((nx, "Net"), (vx, v.tax_word), (gx, "Gross")):
                s.text(h, 7.5, True, "r", x=x)
            s.advance(7.5)
            s.rule(dashed=True, pad=1)
            for r in rows:
                s.text(f"{r['code'].title()} {pct(r['rate_percent'])}", 7.5)
                for x, val in ((nx, r["net"]), (vx, r["vat"]), (gx, r["gross"])):
                    s.text(fmt(val), 7.5, False, "r", x=x)
                s.advance(7.5, 2)
            s.rule(dashed=True, pad=1)
            s.line(f"Prices include {v.tax_word}", 7.5, grey=True)
            s.rule(pad=2)
    else:
        for lbl, amt in discount_rows(v):
            s.pair(lbl, f"-{fmt(amt)}")
        if v.sc > 0:
            s.pair(sc_label(v), fmt(v.sc))
        if v.registered:
            s.pair(f"Sub Total ({cur}, excl. {v.tax_word})", fmt(bill.subtotal))
            if len(v.breakdown) > 1:
                for r in rate_rows(bill):
                    s.pair(f"{v.tax_word} {pct(r['rate_percent'])}", fmt(r["vat"]))
            else:
                s.pair(_tax_label(bill), fmt(bill.tax_amount))
        elif v.tax_charged_unregistered:  # the bill added tax although no GSTIN is set: one plain line so the total adds up
            s.pair("Sub Total", fmt(bill.subtotal))
            s.pair("Taxes", fmt(bill.tax_amount))
        s.rule(heavy=True)
        s.pair("Grand Total", fmt_inr_ascii(bill.total), size=13, bold=True)
        s.rule(pad=2)
    paid = Decimal("0")
    for pay in bill.payments:
        paid += pay.amount
        if pay.method.value == "credit_note":
            s.pair(f"Credit from {notes['orig_number'] or 'original invoice'}", fmt(pay.amount))
        elif pay.amount < 0:
            s.pair(f"Returned {pay.method.value.upper()}", fmt(pay.amount))
        else:
            s.pair(f"Payment {pay.method.value.upper()}", fmt(pay.amount))
    for r in bill.refunds:
        if getattr(r, "kind", "refund") in ("amendment", "void"):
            s.pair(f"Credit note {r.credit_note_number}", f"-{fmt(r.amount)}")
        else:
            s.pair(f"Refund {r.credit_note_number}", f"-{fmt(r.amount)}")
        if r.tax_amount and v.registered:
            multi = len(v.breakdown) > 1
            s.pair(f"  incl. {v.tax_word}" if multi else f"  incl. {_tax_label(bill, v)}", f"-{fmt(r.tax_amount)}", size=7.5)
        if getattr(r, "payout_amount", 0) and r.payout_amount > 0:
            s.pair(f"  Returned to customer ({r.payout_method})", fmt(r.payout_amount), size=7.5)
    if paid < bill.total and getattr(bill, "status", "active") == "active":
        s.pair("Balance due", fmt_inr_ascii(bill.total - paid), size=9.5, bold=True)
    s.rule()
    s.space(2)
    s.line("Thank you for dining with us!", 9.5, True)
    s.line("Visit again.", 9.5, True)
    if snap["cashier_name"]:
        s.space(2)
        s.line(f"Served by {snap['cashier_name']}", 7, grey=True)
    s.cut_line()
    return s.render()
