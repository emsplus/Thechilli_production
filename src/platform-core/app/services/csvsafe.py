"""CSV writer that cannot be turned into a spreadsheet formula (CSV/formula injection, OWASP).

Any text cell whose first non-blank character is = + - @ (or that starts with TAB / CR / LF) is prefixed with a single
quote so Excel/Sheets/Numbers treat it as text. Real numbers (int/float/Decimal) are written as-is; they cannot be formulas."""
import csv
import io
from decimal import Decimal

TRIGGERS = ("=", "+", "-", "@")


def safe_cell(v) -> str | int | float:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float, Decimal)):
        return v
    s = str(v)
    stripped = s.lstrip(" ")
    if s[:1] in ("\t", "\r", "\n") or stripped[:1] in TRIGGERS or stripped[:1] in ("＝", "＋", "－", "＠"):
        return "'" + s
    return s


def to_csv(header: list[str], rows: list[list]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    w.writerow([safe_cell(h) for h in header])
    for r in rows:
        w.writerow([safe_cell(c) for c in r])
    return buf.getvalue()
