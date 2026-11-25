"""A4 report PDFs (reportlab platypus): logo + restaurant header, KPI boxes, zebra tables that split across pages with a
repeated header row, simple bar charts, a "Things to look at" box for flags / warnings and a "page X of Y" footer.

`collect(c, kind, d_from, d_to)` gathers the data of a report kind from services/reports.py and services/insights.py,
`render(kind, data, restaurant, period, generated_at)` turns it into PDF bytes. The PDF is rendered when it is downloaded,
from current data; nothing is stored. Text is Helvetica (cp1252): characters it cannot draw print as '?', like the slips."""
import io
from contextvars import ContextVar
from datetime import date, datetime
from decimal import Decimal
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from reportlab.graphics.charts.barcharts import HorizontalBarChart, VerticalBarChart
from reportlab.graphics.shapes import Drawing
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import Image as RLImage, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.models.core import Restaurant
from app.services import insights, mis, money, reports
from app.services.thermal import LOGO_PATH, safe

COMPRESS = 1  # tests set 0 to grep the drawn text in the raw PDF bytes (like Slip.COMPRESS)

PAGE_W, PAGE_H = A4
MARGIN = 36.0
AVAIL = PAGE_W - 2 * MARGIN
REG, BOLD, OBL = "Helvetica", "Helvetica-Bold", "Helvetica-Oblique"
INK, MUTED, BRAND = colors.HexColor("#111827"), colors.HexColor("#6B7280"), colors.HexColor("#14532D")
HEAD_BG, ZEBRA, LINE = colors.HexColor("#1F2937"), colors.HexColor("#F3F4F6"), colors.HexColor("#D1D5DB")
WARN_BG, WARN_LINE = colors.HexColor("#FFF7E6"), colors.HexColor("#F59E0B")
SEVERITY_COLOR = {"high": "#B91C1C", "medium": "#B45309", "low": "#4B5563", "note": "#4B5563"}
NO_DATA = "No data for this period"

# kind -> title. The order is the order the API / AI list them in.
KINDS: dict[str, str] = {
    "sales_summary": "Sales Summary", "item_sales": "Item Sales", "category_sales": "Sales by Category",
    "purchases": "Purchases", "profit_and_loss": "Profit and Loss", "food_cost": "Dish Food Cost",
    "gst_summary": "GST Summary", "leakage": "Leakage Report", "staff_sales": "Staff Sales",
    "customers": "Customer Insights", "stock": "Stock Report",
}
ITEM_ROWS = 100  # item / dish lists in the PDF are longer than the compact AI-tool versions


def check_kind(kind: str) -> str:
    if kind not in KINDS:
        raise HTTPException(422, "Unknown report kind '%s'; use one of: %s" % (kind, ", ".join(KINDS)))
    return kind


def collect(c: reports.Ctx, kind: str, d_from: date, d_to: date) -> dict:
    """The data of one report kind (raw Decimals; the renderer formats them)."""
    check_kind(kind)
    if kind == "sales_summary":
        return {"daily": reports.daily_sales(c, d_from, d_to), "orders": reports.order_summary(c, d_from, d_to)}
    if kind == "item_sales":
        return reports.item_sales(c, d_from, d_to, ITEM_ROWS)
    if kind == "category_sales":
        return reports.category_sales(c, d_from, d_to)
    if kind == "purchases":
        return reports.purchase_summary(c, d_from, d_to)
    if kind == "profit_and_loss":
        return insights.profit_and_loss(c, d_from, d_to)
    if kind == "food_cost":
        return insights.dish_food_cost(c, d_from, d_to, ITEM_ROWS)
    if kind == "gst_summary":
        return mis.gst_summary(c, d_from, d_to)
    if kind == "leakage":
        return insights.leakage(c, d_from, d_to)
    if kind == "staff_sales":
        return insights.staff_sales(c, d_from, d_to)
    if kind == "customers":
        return insights.customer_insights(c, d_from, d_to)
    return {"balances": reports.inventory_balance(c), "low": reports.low_stock(c)}  # stock


def restaurant_info(r: Restaurant) -> dict:
    return {"name": r.name, "address": r.address, "phone": r.phone, "country": r.country, "currency": r.currency,
            "currency_symbol": r.currency_symbol, "tax_number_label": r.tax_number_label,
            "tax_number": r.trn if r.vat_registered else None, "timezone": r.timezone, "prices_include_tax": r.prices_include_tax,
            "tax_word": money.tax_word(r.tax_mode)}


# ------------------------------------------------------------------ formatting
def D(x) -> Decimal:
    return Decimal(str(x)) if x not in (None, "") else Decimal(0)


def _day(x) -> str:
    d = x if isinstance(x, date) else date.fromisoformat(str(x)[:10])
    return d.strftime("%d %b %Y")


def _style(name: str, **kw) -> ParagraphStyle:
    return ParagraphStyle(name, fontName=kw.pop("fontName", REG), fontSize=kw.pop("fontSize", 8), leading=kw.pop("leading", 10),
                          textColor=kw.pop("textColor", INK), **kw)


S_TITLE = _style("title", fontName=BOLD, fontSize=17, leading=21, textColor=BRAND)
S_SUB = _style("sub", fontSize=9, leading=12, textColor=MUTED)
S_H = _style("h", fontName=BOLD, fontSize=11, leading=14, spaceBefore=10, spaceAfter=4, keepWithNext=1)
S_CELL = _style("cell")
S_CELL_R = _style("cellr", alignment=TA_RIGHT)
S_HEAD = _style("head", fontName=BOLD, textColor=colors.white)
S_HEAD_R = _style("headr", fontName=BOLD, textColor=colors.white, alignment=TA_RIGHT)
S_NOTE = _style("note", fontName=OBL, textColor=MUTED, fontSize=7.5, leading=9.5)
S_NODATA = _style("nodata", fontName=OBL, textColor=MUTED, fontSize=8.5, leading=11, spaceAfter=4)
S_KPI_L = _style("kpil", fontSize=7, leading=9, textColor=MUTED)
S_KPI_V = _style("kpiv", fontName=BOLD, fontSize=12.5, leading=15)


_TAX_WORD: ContextVar[str] = ContextVar("report_tax_word", default="GST")


def P(text, style=S_CELL) -> Paragraph:
    return Paragraph(escape(safe(money.retax(str(text), _TAX_WORD.get()) if isinstance(text, str) else text)), style)


class Fmt:
    """Money / number formatting. Helvetica has no rupee sign, so money prints through money.fmt_inr_ascii; whole numbers
    use the Indian (lakh / crore) grouping."""

    def __init__(self, restaurant: dict | None = None):
        pass

    @staticmethod
    def money(x) -> str:
        return money.fmt_inr_ascii(D(x))

    @staticmethod
    def num(x) -> str:
        v = D(x)
        if v == v.to_integral():
            return ("-" if v < 0 else "") + money.group_indian(f"{abs(v):.0f}")
        return f"{v:,.3f}".rstrip("0").rstrip(".")

    @staticmethod
    def pct(x) -> str:
        return "-" if x in (None, "") else f"{D(x):.1f}%"


# ------------------------------------------------------------------ building blocks
class Doc:
    """Accumulates the story of one report."""

    def __init__(self, restaurant: dict, title: str, period: tuple[date, date], f: Fmt):
        self.r, self.title, self.period, self.f = restaurant, title, period, f
        self.story: list = []

    def header(self) -> None:
        r = self.r
        info = [P(r["name"], _style("rn", fontName=BOLD, fontSize=13, leading=16))]
        if r.get("address"):
            info.append(P(r["address"], S_SUB))
        bits = [f"{r['tax_number_label']}: {r['tax_number']}" if r.get("tax_number") else None, r.get("phone")]
        if any(bits):
            info.append(P("  |  ".join(b for b in bits if b), S_SUB))
        cells, widths = [info], [AVAIL]
        if LOGO_PATH.is_file():
            cells.insert(0, RLImage(str(LOGO_PATH), width=22 * mm, height=22 * mm))
            widths = [26 * mm, AVAIL - 26 * mm]
        t = Table([cells], colWidths=widths)
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
        self.story += [t, Spacer(1, 6), _rule(), Spacer(1, 6), P(self.title, S_TITLE),
                       P(f"{_day(self.period[0])} to {_day(self.period[1])}  ({r.get('timezone', '')})"
                         if self.period[0] != self.period[1] else f"{_day(self.period[0])}  ({r.get('timezone', '')})", S_SUB),
                       Spacer(1, 8)]

    def kpis(self, items: list[tuple[str, str]], per_row: int = 4) -> None:
        if not items:
            return
        w = AVAIL / per_row
        rows = []
        for i in range(0, len(items), per_row):
            chunk = items[i:i + per_row]
            rows.append([[P(label, S_KPI_L), P(value, S_KPI_V)] for label, value in chunk] + [""] * (per_row - len(chunk)))
        t = Table(rows, colWidths=[w] * per_row)
        t.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.5, LINE), ("INNERGRID", (0, 0), (-1, -1), 0.5, LINE),
                               ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F9FAFB")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                               ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
        self.story += [t, Spacer(1, 6)]

    def things_to_look_at(self, flags: list[dict], warnings: list[str]) -> None:
        if not flags and not warnings:
            return
        rows = [[P("Things to look at", _style("ttl", fontName=BOLD, fontSize=10, leading=13, textColor=colors.HexColor("#92400E")))]]
        for fl in flags:
            rows.append([Paragraph(f'<font color="{SEVERITY_COLOR[fl["severity"]]}"><b>{fl["severity"].upper()}</b></font>  '
                                   + escape(safe(money.retax(fl["message"], _TAX_WORD.get()))), S_CELL)])
        for w in warnings:
            rows.append([Paragraph(f'<font color="{SEVERITY_COLOR["note"]}"><b>NOTE</b></font>  ' + escape(safe(money.retax(str(w), _TAX_WORD.get()))), S_CELL)])
        t = Table(rows, colWidths=[AVAIL])
        t.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 1, WARN_LINE), ("BACKGROUND", (0, 0), (-1, -1), WARN_BG),
                               ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
        self.story += [t, Spacer(1, 6)]

    def heading(self, text: str) -> None:
        self.story.append(P(text, S_H))

    def note(self, text: str) -> None:
        self.story.append(P(text, S_NOTE))

    def table(self, title: str | None, cols: list[tuple[str, float, str]], rows: list[list], total: list | None = None,
              more: int = 0) -> None:
        """cols = (header, width weight, 'l' | 'r'); rows = lists of already formatted strings. Header repeats on every page;
        cells wrap, so long names never overflow. No rows prints the 'No data' line."""
        if title:
            self.heading(title)
        if not rows:
            self.story.append(P(NO_DATA, S_NODATA))
            return
        wsum = sum(w for _, w, _ in cols)
        widths = [AVAIL * w / wsum for _, w, _ in cols]
        data = [[P(h, S_HEAD_R if a == "r" else S_HEAD) for h, _, a in cols]]
        for row in rows:
            data.append([P(v, S_CELL_R if cols[i][2] == "r" else S_CELL) for i, v in enumerate(row)])
        style = [("BACKGROUND", (0, 0), (-1, 0), HEAD_BG), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                 ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ZEBRA]), ("LINEBELOW", (0, -1), (-1, -1), 0.5, LINE),
                 ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                 ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4)]
        if total:
            data.append([P(v, _style("tot", fontName=BOLD, alignment=TA_RIGHT if cols[i][2] == "r" else 0)) for i, v in enumerate(total)])
            style += [("LINEABOVE", (0, -1), (-1, -1), 0.8, INK), ("BACKGROUND", (0, -1), (-1, -1), colors.white)]
        t = Table(data, colWidths=widths, repeatRows=1)
        t.setStyle(TableStyle(style))
        self.story.append(t)
        if more:
            self.note(f"... and {more} more not shown")
        self.story.append(Spacer(1, 4))

    def bar_chart(self, title: str, labels: list[str], values: list[Decimal], horizontal: bool = False) -> None:
        if not labels or not any(v > 0 for v in values):
            return
        self.heading(title)
        h = max(60, 14 * len(labels) + 20) if horizontal else 150
        d = Drawing(AVAIL, h)
        ch = HorizontalBarChart() if horizontal else VerticalBarChart()
        ch.x, ch.y, ch.width, ch.height = (110, 10, AVAIL - 160, h - 20) if horizontal else (40, 28, AVAIL - 60, h - 40)
        ch.data = [[float(v) for v in values]]
        ch.bars[0].fillColor = BRAND
        ch.bars.strokeColor = None
        ch.categoryAxis.categoryNames = [safe(x)[:24] for x in labels]
        ch.categoryAxis.labels.fontName, ch.categoryAxis.labels.fontSize = REG, 6.5
        ch.valueAxis.labels.fontName, ch.valueAxis.labels.fontSize = REG, 6.5
        ch.valueAxis.valueMin = 0
        ch.valueAxis.labelTextFormat = "%.0f"
        ch.valueAxis.strokeColor = ch.categoryAxis.strokeColor = LINE
        if not horizontal and len(labels) > 12:
            ch.categoryAxis.labels.angle, ch.categoryAxis.labels.boxAnchor = 45, "ne"
        if horizontal:
            ch.categoryAxis.labels.boxAnchor, ch.categoryAxis.labels.dx = "e", -3
            ch.categoryAxis.reverseDirection = 1
        d.add(ch)
        self.story += [d, Spacer(1, 4)]


def _rule() -> Table:
    t = Table([[""]], colWidths=[AVAIL], rowHeights=[1])
    t.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, 0), 0.8, BRAND)]))
    return t


class NumberedCanvas(canvas.Canvas):
    """Draws the footer once the page count is known ('page X of Y')."""

    footer_left = ""
    footer_right = ""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._saved: list[dict] = []

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved)
        for state in self._saved:
            self.__dict__.update(state)
            self.setFont(REG, 7)
            self.setFillColor(MUTED)
            self.setStrokeColor(LINE)
            self.line(MARGIN, 30, PAGE_W - MARGIN, 30)
            self.drawString(MARGIN, 20, safe(self.footer_left))
            self.drawRightString(PAGE_W - MARGIN, 20, f"{self.footer_right} · page {self._pageNumber} of {total}")
            super().showPage()
        super().save()


# ------------------------------------------------------------------ per-kind layouts
def _bucket_days(days: list[dict], key: str) -> tuple[list[str], list[Decimal]]:
    """One bar per day; long ranges are summed per week (> 31 days) or per month (> 120 days) so the chart stays readable."""
    ds = [(x["date"] if isinstance(x["date"], date) else date.fromisoformat(str(x["date"])), D(x[key])) for x in days]
    if len(ds) <= 31:
        return [d.strftime("%d %b") for d, _ in ds], [v for _, v in ds]
    acc: dict = {}
    for d, v in ds:
        k = d.replace(day=1) if len(ds) > 120 else d.fromordinal(d.toordinal() - d.weekday())
        acc[k] = acc.get(k, Decimal(0)) + v
    fmt = "%b %Y" if len(ds) > 120 else "wk %d %b"
    return [k.strftime(fmt) for k in acc], list(acc.values())


def _sales_summary(doc: Doc, data: dict) -> None:
    f, daily, orders = doc.f, data["daily"], data["orders"]
    t = daily["totals"]
    doc.kpis([("Gross sales", f.money(t["gross_total"])), ("Net sales (after refunds)", f.money(t["net_total"])),
              ("Tax", f.money(t["vat"])), ("Bills", f.num(t["bills"])),
              ("Average bill", f.money(orders["average_bill_value"])), ("Discounts", f.money(t["discounts"])),
              ("Refunds", f.money(t["refunds"])), ("Service charge", f.money(t["service_charge"]))])
    doc.things_to_look_at([], _meta_warnings(daily))
    labels, vals = _bucket_days(daily["days"], "gross_total")
    doc.bar_chart("Gross sales per day" if len(daily["days"]) <= 31 else "Gross sales", labels, vals)
    doc.table("Daily sales", [("Date", 1.3, "l"), ("Bills", 0.7, "r"), ("Excl. Tax", 1.1, "r"), ("Tax", 1, "r"), ("Gross", 1.1, "r"),
                              ("Discounts", 1, "r"), ("Refunds", 1, "r"), ("Net", 1.1, "r")],
              [[_day(x["date"]), f.num(x["bills"]), f.money(x["subtotal"]), f.money(x["vat"]), f.money(x["gross_total"]),
                f.money(x["discounts"]), f.money(x["refunds"]), f.money(x["net_total"])] for x in daily["days"]],
              total=["Total", f.num(t["bills"]), f.money(t["subtotal"]), f.money(t["vat"]), f.money(t["gross_total"]),
                     f.money(t["discounts"]), f.money(t["refunds"]), f.money(t["net_total"])] if daily["days"] else None)
    doc.table("Tax by rate", [("Rate", 1, "l"), ("Code", 1, "l"), ("Excl. Tax", 1, "r"), ("Tax", 1, "r"), ("Gross", 1, "r")],
              [[f"{D(x['rate_percent']):.2f}%", x["code"], f.money(x["net"]), f.money(x["vat"]), f.money(x["gross"])] for x in t["vat_by_rate"]])
    doc.table("Order types", [("Order type", 2, "l"), ("Bills", 1, "r"), ("Total", 1.5, "r")],
              [[x["order_type"].title(), f.num(x["bills"]), f.money(x["total"])] for x in orders["billed_by_order_type"]])
    doc.note(daily["note"])


def _meta_warnings(d: dict) -> list[str]:
    return [] if d.get("data_complete", True) else [d.get("incomplete_reason") or "The data is incomplete."]


def _item_sales(doc: Doc, data: dict) -> None:
    f, items = doc.f, data["items"]
    total = sum((D(x["revenue_excl_vat"]) for x in items), Decimal(0))
    doc.kpis([("Items listed", f.num(len(items))), ("Quantity sold", f.num(sum(x["quantity"] for x in items))),
              ("Revenue excl. Tax", f.money(total))], 3)
    doc.things_to_look_at([], _meta_warnings(data))
    doc.table("Items by revenue", [("#", 0.5, "l"), ("Item", 4, "l"), ("Qty", 1, "r"), ("Revenue excl. Tax", 1.6, "r"), ("Share", 1, "r")],
              [[str(i), x["item"], f.num(x["quantity"]), f.money(x["revenue_excl_vat"]),
                f.pct(D(x["revenue_excl_vat"]) / total * 100) if total else "-"] for i, x in enumerate(items, 1)])
    doc.note(data["note"])


def _category_sales(doc: Doc, data: dict) -> None:
    f, t = doc.f, data["totals"]
    doc.kpis([("Net sales", f.money(t["net"])), ("Tax", f.money(t["vat"])), ("Gross", f.money(t["gross"])),
              ("Discounts", f.money(t["discount"])), ("Items sold", f.num(t["quantity"])), ("Service charge", f.money(t["service_charge"]))])
    doc.things_to_look_at([], _meta_warnings(data))
    cats = data["categories"]
    doc.bar_chart("Share of net sales by category", [x["category"] for x in cats[:12]], [D(x["net"]) for x in cats[:12]], horizontal=True)
    cols = [("Category", 3, "l"), ("Qty", 0.8, "r"), ("Before disc.", 1.3, "r"), ("Discount", 1.1, "r"), ("Net", 1.2, "r"),
            ("Tax", 1, "r"), ("Gross", 1.2, "r"), ("Share", 0.9, "r")]

    def rows(cc):
        return [[x["category"], f.num(x["quantity"]), f.money(x["before_discount"]), f.money(x["discount"]), f.money(x["net"]),
                 f.money(x["vat"]), f.money(x["gross"]), f.pct(x["share_percent"])] for x in cc]
    doc.table("All categories", cols, rows(cats), total=["Total", f.num(t["quantity"]), f.money(t["before_discount"]),
                                                          f.money(t["discount"]), f.money(t["net"]), f.money(t["vat"]),
                                                          f.money(t["gross"]), ""] if cats else None)
    for ch in data["by_channel"]:
        if ch["categories"]:
            doc.table(f"{ch['label'].title()} ({ch['orders']} orders)", cols, rows(ch["categories"]))
    doc.note(data["note"])


def _purchases(doc: Doc, data: dict) -> None:
    f, sup = doc.f, data["suppliers"]
    doc.kpis([("Total purchases", f.money(data["total"])), ("Invoices", f.num(sum(x["invoices"] for x in sup))),
              ("Suppliers", f.num(len(sup)))], 3)
    doc.things_to_look_at([], _meta_warnings(data))
    doc.table("Purchases by supplier", [("Supplier", 4, "l"), ("Invoices", 1, "r"), ("Total", 1.5, "r")],
              [[x["supplier"], f.num(x["invoices"]), f.money(x["total"])] for x in sup])
    doc.note(data["note"])


def _profit_and_loss(doc: Doc, data: dict) -> None:
    f = doc.f
    doc.kpis([("Net sales excl. Tax", f.money(data["net_sales_excl_vat"])), ("Gross profit", f.money(data["gross_profit"])),
              ("Expenses", f.money(data["expenses"]["total"])), ("Operating profit", f.money(data["operating_profit"])),
              ("Gross margin", f.pct(data["gross_margin_percent"])), ("Operating margin", f.pct(data["operating_margin_percent"]))], 3)
    doc.things_to_look_at([], data["warnings"] + _meta_warnings(data))
    if not data["bills"] and not data["expenses"]["by_category"]:
        doc.story.append(P(NO_DATA, S_NODATA))
        return
    rows = [["Net sales (excl. Tax, after refunds)", f.money(data["net_sales_excl_vat"]), ""],
            ["Ingredient cost (recipes x sold quantities)", f.money(-D(data["ingredient_cost"])), ""],
            ["Gross profit", f.money(data["gross_profit"]), f.pct(data["gross_margin_percent"])]]
    for e in data["expenses"]["by_category"]:
        rows.append([f"Expense: {e['category']}", f.money(-D(e["amount"])), ""])
    rows.append(["Operating profit", f.money(data["operating_profit"]), f.pct(data["operating_margin_percent"])])
    doc.table("Profit and loss", [("", 4, "l"), ("Amount", 1.5, "r"), ("% of net sales", 1.2, "r")], rows)
    v = data["vat"]
    doc.table("Tax", [("", 4, "l"), ("Amount", 1.5, "r")],
              [["Output Tax (on sales)", f.money(v["output_vat"])], ["Input Tax (on purchases and expenses)", f.money(-D(v["input_vat"]))],
               [f"Net Tax payable to {v['authority']}", f.money(v["net_vat_due"])]])
    doc.note(data["note"])


def _food_cost(doc: Doc, data: dict) -> None:
    f, t = doc.f, data["totals"]
    doc.kpis([("Revenue (dishes with a recipe)", f.money(t["revenue_excl_vat"])), ("Ingredient cost", f.money(t["ingredient_cost"])),
              ("Food cost", f.pct(t["food_cost_percent"])), ("Gross margin", f.money(t["gross_margin"])),
              ("Dishes costed", f.num(t["dishes_costed"])), ("Dishes without recipe", f.num(t["dishes_without_recipe"]))], 3)
    doc.things_to_look_at([], data["warnings"] + _meta_warnings(data))
    doc.table("Dishes with a recipe", [("Dish", 3.2, "l"), ("Qty", 0.7, "r"), ("Revenue excl. Tax", 1.3, "r"), ("Cost / portion", 1.1, "r"),
                                       ("Food cost", 0.9, "r"), ("Margin / portion", 1.1, "r"), ("Total margin", 1.2, "r"), ("Class", 1, "l")],
              [[x["item"], f.num(x["quantity"]), f.money(x["revenue_excl_vat"]), f.money(x["cost_per_portion"]), f.pct(x["food_cost_percent"]),
                f.money(x["margin_per_portion"]), f.money(x["total_margin"]), (x["classification"] or "-").title()] for x in data["dishes"]],
              more=data["dishes_more"])
    doc.table("Dishes without a recipe or without costed ingredients (cost unknown)",
              [("Dish", 3.5, "l"), ("Qty", 0.8, "r"), ("Revenue excl. Tax", 1.4, "r"), ("Why", 3, "l")],
              [[x["item"], f.num(x["quantity"]), f.money(x["revenue_excl_vat"]),
                "No recipe" if not x["has_recipe"] else "No cost for: " + ", ".join(x["ingredients_without_cost"])]
               for x in data["dishes_without_recipe"]], more=data["dishes_without_recipe_more"])
    doc.note(data["classification_note"])


def _gst_summary(doc: Doc, data: dict) -> None:
    f, t, inp = doc.f, data["totals"], data["input_tax"]
    kpis = [("Output tax (after credit notes)", f.money(t["net_tax"])), ("Bills", f.num(t["bills"]))]
    if inp is not None:
        kpis += [("Input tax", f.money(inp["total"])), ("Net payable", f.money(data["net_payable"]))]
    doc.kpis(kpis, len(kpis))
    doc.things_to_look_at([], data["warnings"] + _meta_warnings(data))
    doc.table("Output tax by rate (sales)", [("Rate", 1, "l"), ("Code", 1, "l"), ("Taxable value", 1.4, "r"), ("Tax", 1, "r"),
                                             ("Gross", 1.2, "r")],
              [[f"{D(x['rate_percent']):.2f}%", x["code"], f.money(x["taxable_value"]), f.money(x["tax"]), f.money(x["gross"])]
               for x in data["by_rate"]],
              total=["Total", "", f.money(t["taxable_value"]), f.money(t["tax"]), f.money(t["gross"])] if data["by_rate"] else None)
    rows = [["Tax on credit notes", f.money(-D(t["credit_note_tax"]))], ["Output tax after credit notes", f.money(t["net_tax"])]]
    if inp is not None:
        rows += [[f"Input tax: stock purchases ({inp['purchase_invoices']} invoices)", f.money(-D(inp["purchases"]))],
                 [f"Input tax: expenses ({inp['expense_count']})", f.money(-D(inp["expenses"]))],
                 ["Net payable", f.money(data["net_payable"])]]
    doc.table("Credit notes and input tax", [("", 4, "l"), ("Amount", 1.5, "r")], rows)
    doc.note(data["note"])


def _leakage(doc: Doc, data: dict) -> None:
    f, d, v, rf, cr, u, pv, st = doc.f, data["discounts"], data["voids"], data["refunds"], data["corrections"], \
        data["unpaid_bills"], data["payments_vs_takings"], data["stock"]
    doc.kpis([("Discounts", f.money(d["total"])), ("Discounts % of sales", f.pct(d["percent_of_sales"])),
              ("Cancelled orders", f.money(v["value"])), ("Cancelled after kitchen", f.money(v["after_kitchen"]["value"])),
              ("Refunds", f.money(rf["value"])), ("Unpaid bills", f.money(u["balance"])),
              ("Stock losses", f.money(st["total_loss_value"])), ("Payments - billed", f.money(pv["difference"]))])
    doc.things_to_look_at(data["flags"], data["warnings"] + _meta_warnings(data))
    cs = [("Staff", 3, "l"), ("Discounts", 1, "r"), ("Amount", 1.3, "r"), ("Their sales", 1.3, "r"), ("% of sales", 1, "r")]
    doc.table("Discounts by staff member", cs, [[x["name"], f.num(x["count"]), f.money(x["amount"]), f.money(x["sales"]),
                                                  f.pct(x["percent_of_sales"])] for x in d["by_staff"]])
    doc.table("Discounts by reason", [("Reason", 4, "l"), ("Discounts", 1, "r"), ("Amount", 1.3, "r")],
              [[x["name"], f.num(x["count"]), f.money(x["amount"])] for x in d["by_reason"]])
    doc.table("Biggest discounted bills", [("Invoice", 1.4, "l"), ("Date", 1.2, "l"), ("Amount", 1.1, "r"), ("%", 0.7, "r"), ("By", 1.5, "l"),
                                           ("Reason", 2.5, "l")],
              [[x["invoice"], _day(x["sale_date"]), f.money(x["amount"]), f.pct(x["percent"]), x["staff"], x["reason"]] for x in d["biggest"]])
    doc.table("Cancelled orders", [("When", 3, "l"), ("Orders", 1, "r"), ("Value", 1.3, "r")],
              [["Before the kitchen got the ticket", f.num(v["before_kitchen"]["count"]), f.money(v["before_kitchen"]["value"])],
               ["After the kitchen ticket was sent (check these)", f.num(v["after_kitchen"]["count"]), f.money(v["after_kitchen"]["value"])]]
              if v["count"] else [])
    doc.table("Cancelled orders by staff", [("Staff", 3, "l"), ("Orders", 1, "r"), ("Value", 1.2, "r"), ("After kitchen", 1.2, "r"),
                                            ("After-kitchen value", 1.4, "r")],
              [[x["name"], f.num(x["count"]), f.money(x["amount"]), f.num(x["after_kitchen_count"]), f.money(x["after_kitchen_amount"])]
               for x in v["by_staff"]])
    doc.table("Cancelled after the kitchen ticket was sent", [("Order", 1.4, "l"), ("When", 1.6, "l"), ("Value", 1, "r"), ("By", 1.5, "l"), ("Reason", 2.5, "l")],
              [[x["order_ref"], x["cancelled_at"].strftime("%d %b %H:%M"), f.money(x["amount"]), x["staff"], x["reason"]]
               for x in v["after_kitchen"]["orders"]])
    doc.table(f"Refunds ({rf['count']}, {f.money(rf['value'])})", [("Staff", 3, "l"), ("Refunds", 1, "r"), ("Amount", 1.3, "r")],
              [[x["name"], f.num(x["count"]), f.money(x["amount"])] for x in rf["by_staff"]])
    doc.table("Refunds by reason", [("Reason", 4, "l"), ("Refunds", 1, "r"), ("Amount", 1.3, "r")],
              [[x["name"], f.num(x["count"]), f.money(x["amount"])] for x in rf["by_reason"]])
    doc.table(f"Bill corrections / credit notes ({cr['count']})", [("Staff", 3, "l"), ("Corrections", 1.2, "r"), ("Reversed", 1.3, "r")],
              [[x["name"], f.num(x["count"]), f.money(x["amount"])] for x in cr["by_staff"]])
    if cr["count"]:
        doc.note(f"Net change after replacement invoices: {f.money(cr['net_change'])}; paid back to customers: {f.money(cr['payout_to_customers'])}.")
    doc.table(f"Bills waiting for payment ({u['count']}, {f.money(u['balance'])})",
              [("Invoice", 1.5, "l"), ("Customer", 2, "l"), ("Age (days)", 1, "r"), ("Total", 1.2, "r"), ("Balance", 1.2, "r"), ("Part paid", 1, "l")],
              [[x["invoice"], x["customer"] or "-", f.num(x["age_days"]), f.money(x["total"]), f.money(x["balance"]),
                "yes" if x["part_paid"] else "no"] for x in u["bills"]])
    doc.table("Payments against takings", [("", 3, "l"), ("Amount", 1.5, "r")],
              [["Payments received", f.money(pv["payments"])], ["Takings", f.money(pv["takings"])], ["Difference", f.money(pv["difference"])]])
    doc.note(pv["note"])
    doc.table("Stock losses (write-offs, negative adjustments, negative counts)", [("Item", 3, "l"), ("Quantity", 1.2, "r"), ("Unit", 0.7, "l"),
                                                                                  ("Value", 1.2, "r"), ("Recorded as", 1.5, "l")],
              [[x["item"], f.num(x["quantity"]), x["unit"], f.money(x["value"]), ", ".join(sorted(set(x["types"])))] for x in st["items"]])
    if st["usage_gap"].get("note"):  # absent for an outlet-restricted view (stock is tenant-wide, insights.leakage)
        doc.note("Usage gap: " + st["usage_gap"]["note"])


def _staff_sales(doc: Doc, data: dict) -> None:
    f, t = doc.f, data["totals"]
    doc.kpis([("Bills", f.num(t["bills"])), ("Gross sales", f.money(t["gross"])), ("Discounts given", f.money(t["discount_value"])),
              ("Staff with sales", f.num(sum(1 for s in data["staff"] if s["bills"])))])
    doc.things_to_look_at([], _meta_warnings(data))
    doc.table("Sales by staff member", [("Staff", 2.4, "l"), ("Bills", 0.7, "r"), ("Gross", 1.2, "r"), ("Avg bill", 1, "r"), ("Items", 0.7, "r"),
                                        ("Discounts", 1.3, "r"), ("Voids", 1.2, "r"), ("Refunds", 1.2, "r")],
              [[f"{s['name']} ({s['role']})" if s["role"] else s["name"], f.num(s["bills"]), f.money(s["gross"]), f.money(s["average_bill"]),
                f.num(s["items"]), f"{s['discounts']['count']} / {f.money(s['discounts']['value'])}",
                f"{s['voids']['count']} / {f.money(s['voids']['value'])}", f"{s['refunds']['count']} / {f.money(s['refunds']['value'])}"]
               for s in data["staff"]])
    doc.note(data["note"])


def _customers(doc: Doc, data: dict) -> None:
    f = doc.f
    doc.kpis([("Customers", f.num(data["customers"])), ("New", f.num(data["new_customers"])), ("Returning", f.num(data["returning_customers"])),
              ("Repeat rate", f.pct(data["repeat_rate_percent"])), ("Bills with a customer", f.num(data["bills_with_customer"])),
              ("Bills without", f.num(data["bills_without_customer"]))])
    doc.things_to_look_at([], data["warnings"] + _meta_warnings(data))
    doc.table("Top customers by spend", [("Customer", 3, "l"), ("Phone", 1.7, "l"), ("Visits", 0.8, "r"), ("Spend", 1.2, "r"),
                                         ("Avg bill", 1.1, "r"), ("Last visit", 1.3, "l"), ("", 1, "l")],
              [[x["name"] or "(no name)", x["phone"] or "-", f.num(x["visits"]), f.money(x["spend"]), f.money(x["average_bill"]),
                _day(x["last_visit"]), "returning" if x["returning"] else "new"] for x in data["top_customers"]])
    doc.note(data["note"])


def _stock(doc: Doc, data: dict) -> None:
    f, bal, low = doc.f, data["balances"], data["low"]
    doc.kpis([("Stock items", f.num(len(bal["items"]))), ("At or below reorder level", f.num(len(low["items"])))], 2)
    doc.things_to_look_at([], _meta_warnings(bal))
    doc.table("Low stock", [("Item", 4, "l"), ("Balance", 1.2, "r"), ("Unit", 0.8, "l"), ("Reorder level", 1.2, "r")],
              [[x["item"], f.num(x["balance"]), x["unit"], f.num(x["reorder_level"])] for x in low["items"]])
    doc.table("Stock balances", [("Item", 4, "l"), ("Balance", 1.2, "r"), ("Unit", 0.8, "l"), ("Reorder level", 1.2, "r"), ("Status", 1, "l")],
              [[x["item"], f.num(x["balance"]), x["unit"], f.num(x["reorder_level"]), "LOW" if x["low_stock"] else "ok"] for x in bal["items"]])
    doc.note(f"Balances as of {bal['as_of'].strftime('%d %b %Y %H:%M') if hasattr(bal['as_of'], 'strftime') else bal['as_of']} (first 200 items by name).")


LAYOUTS = {"sales_summary": _sales_summary, "item_sales": _item_sales, "category_sales": _category_sales, "purchases": _purchases,
           "profit_and_loss": _profit_and_loss, "food_cost": _food_cost, "gst_summary": _gst_summary, "leakage": _leakage,
           "staff_sales": _staff_sales, "customers": _customers, "stock": _stock}


def render(kind: str, data: dict, restaurant: dict, period: tuple[date, date], generated_at: datetime) -> bytes:
    check_kind(kind)
    title = money.retax(KINDS[kind], restaurant.get("tax_word") or "GST")
    _TAX_WORD.set(restaurant.get("tax_word") or "GST")
    doc = Doc(restaurant, title, period, Fmt(restaurant))
    doc.header()
    LAYOUTS[kind](doc, data)
    gen = generated_at.astimezone(ZoneInfo(restaurant["timezone"])) if generated_at.tzinfo and restaurant.get("timezone") else generated_at
    buf = io.BytesIO()
    canvas_cls = type("ReportCanvas", (NumberedCanvas,), {"footer_left": f"{restaurant['name']} - {title}",
                                                          "footer_right": f"Generated {gen.strftime('%d %b %Y %H:%M')}"})
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN, bottomMargin=44,
                      title=f"{restaurant['name']} - {title}", author=safe(restaurant["name"]), pageCompression=COMPRESS,
                      invariant=1).build(doc.story, canvasmaker=canvas_cls)
    return buf.getvalue()
