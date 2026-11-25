"""CSV export of the main reports. One function per report returns (headers, rows) from the same report dict the JSON API uses.
Cells are formula-injection safe: a TEXT cell starting with = + - @ (or tab / CR) gets a leading apostrophe, so spreadsheet
software shows it as text. Numbers (Decimal / int) are written plain, never in scientific notation, and keep their sign."""
import csv
import io
from datetime import date, datetime
from decimal import Decimal
from typing import Callable

from fastapi import HTTPException

from app.services import mis, money, reports

DANGEROUS = ("=", "+", "-", "@", "\t", "\r")


def cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, Decimal):
        return format(v, "f")
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    s = str(v) if not isinstance(v, str) else v
    if isinstance(v, str) and s.startswith(DANGEROUS):
        return "'" + s
    return s


def to_csv(headers: list[str], rows: list[list]) -> bytes:
    """UTF-8 with BOM (Excel), CRLF line endings, header row first."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow([cell(h) for h in headers])
    for r in rows:
        w.writerow([cell(v) for v in r])
    return b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8")


def _daily(c, a, b):
    d = reports.daily_sales(c, a, b)
    return (["date", "bills", "subtotal", "tax", "gross_total", "discounts", "service_charge", "refunds", "net_total"],
            [[x["date"], x["bills"], x["subtotal"], x["vat"], x["gross_total"], x["discounts"], x["service_charge"], x["refunds"],
              x["net_total"]] for x in d["days"]])


def _items(c, a, b):
    d = reports.item_sales(c, a, b, 100)
    return ["item", "quantity", "revenue_excl_tax"], [[x["item"], x["quantity"], x["revenue_excl_vat"]] for x in d["items"]]


def _category(c, a, b):
    d = reports.category_sales(c, a, b)
    return (["category", "quantity", "before_discount", "discount", "net", "tax", "gross", "share_percent"],
            [[x["category"], x["quantity"], x["before_discount"], x["discount"], x["net"], x["vat"], x["gross"], x["share_percent"]]
             for x in d["categories"]])


def _gst(c, a, b):
    d = mis.gst_summary(c, a, b)
    return (["code", "rate_percent", "taxable_value", "tax", "cgst", "sgst", "igst", "gross"],
            [[x["code"], x["rate_percent"], x["taxable_value"], x["tax"], x["cgst"], x["sgst"], x["igst"], x["gross"]] for x in d["by_rate"]])


def _pay_method(c, a, b):
    d = mis.payments_report(c, a, b)
    return ["method", "payments", "amount", "share_percent"], [[x["method"], x["payments"], x["amount"], x["share_percent"]] for x in d["by_method"]]


def _pay_cashier(c, a, b):
    d = mis.payments_report(c, a, b)
    methods = sorted({m for x in d["by_cashier"] for m in x["by_method"]})
    return (["cashier", "payments", *methods, "total", "refunds", "net_collected"],
            [[x["name"], x["payments"], *[x["by_method"].get(m, Decimal("0.00")) for m in methods], x["total"], x["refunds"], x["net_collected"]]
             for x in d["by_cashier"]])


def _period(group):
    def f(c, a, b):
        d = mis.period_sales(c, a, b, group)
        return (["period", "bills", "subtotal", "tax", "gross_total", "discounts", "service_charge", "refunds", "net_total", "average_bill"],
                [[x["period"], x["bills"], x["subtotal"], x["tax"], x["gross_total"], x["discounts"], x["service_charge"], x["refunds"],
                  x["net_total"], x["average_bill"]] for x in d["periods"]])
    return f


def _rank(direction):
    def f(c, a, b):
        d = mis.item_ranking(c, a, b, direction, "revenue", 200)
        return ["rank", "item", "quantity", "revenue_excl_tax"], [[x["rank"], x["item"], x["quantity"], x["revenue_excl_tax"]] for x in d["items"]]
    return f


def _outlets(c, a, b):
    d = mis.outlet_comparison(c, a, b)
    return (["rank", "outlet", "code", "bills", "gross_total", "refunds", "net_total", "average_bill", "discount_percent", "refund_percent"],
            [[x["rank"], x["outlet"], x["code"], x["bills"], x["gross_total"], x["refunds"], x["net_total"], x["average_bill"],
              x["discount_percent"], x["refund_percent"]] for x in d["outlets"]])


KINDS: dict[str, Callable] = {
    "daily_sales": _daily, "item_sales": _items, "category_sales": _category, "gst_summary": _gst,
    "payments_by_method": _pay_method, "payments_by_cashier": _pay_cashier, "daily_summary": _period("day"),
    "monthly_summary": _period("month"), "top_items": _rank("top"), "bottom_items": _rank("bottom"), "outlet_comparison": _outlets,
}


def build(c, kind: str, d_from: date, d_to: date) -> bytes:
    if kind not in KINDS:
        raise HTTPException(422, f"Unknown report kind; one of {sorted(KINDS)}")
    headers, rows = KINDS[kind](c, d_from, d_to)
    word = getattr(c, "tax_word", "GST")  # 'tax' columns are headed 'gst'
    return to_csv([money.retax(h, word, lower=True) if isinstance(h, str) else h for h in headers], rows)
