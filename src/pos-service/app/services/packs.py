"""Deterministic stock quantities for invoice lines.

The OCR model only READS what is printed (qty, unit of sale, pack count, unit size, the raw pack text). Every multiplication
happens here, in Decimal: "4 cases x 6 x 2.55 kg" is 61.2 kg because this code says so, never because a model guessed.
A line whose pack/size cannot be read, or whose sources disagree, comes back `uncertain` and must be fixed by a human."""
import re
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from app.services.units import ALIASES, UNITS, normalize_code

_UNIT_WORDS = sorted({*UNITS, *ALIASES}, key=len, reverse=True)
UNIT = "(?:" + "|".join(re.escape(u) for u in _UNIT_WORDS) + ")"
NUM = r"(\d+(?:[.,]\d+)?)"
PACKAGE_WORDS = {"case", "cases", "box", "boxes", "bag", "bags", "sack", "sacks", "tray", "trays", "carton", "cartons",
                 "pack", "packs", "packet", "packets", "tin", "tins", "can", "cans", "bottle", "bottles", "jar", "jars",
                 "tub", "tubs", "crate", "crates", "drum", "drums", "bunch", "bunches", "keg", "kegs", "ctn", "pkt", "btl"}

_P_COUNT_SIZE = re.compile(rf"(?<![\d.]){NUM}\s*x\s*{NUM}\s*({UNIT})\b")            # 12x660ml, 4X2.5KG, 1*9.5KG
_P_SIZE_COUNT = re.compile(rf"(?<![\d.]){NUM}\s*({UNIT})\s*x\s*(\d+)\b")            # 4 pint x 6, 1l x 12
_P_SIZE = re.compile(rf"(?<![\d.]){NUM}\s*({UNIT})\b")                              # 2.55Kg, 20L, 400ml
_P_S = re.compile(r"(?<![\d.x])(\d+)\s*s\b")                                         # 100s
_P_PACK_OF = re.compile(r"\b(?:pack|case|tray|box|carton|bag|crate|pkt)\s*(?:of\s*)?(\d+)\b")  # tray 30, pack of 12
_P_PACK_N = re.compile(r"\bpack\s*(?:of\s*)?(\d+)\b")
_P_COUNT_NOUNIT = re.compile(rf"(?<![\d.x]){NUM}\s*x\s*{NUM}(?![\d.]|\s*[a-z])")     # 15x50 (no unit printed)


def _dec(s: str | Decimal | int | float | None) -> Decimal | None:
    if s is None:
        return None
    try:
        return Decimal(str(s).replace(",", ".")).normalize()
    except InvalidOperation:
        return None


def fmt(d: Decimal) -> str:
    s = f"{d.quantize(Decimal('0.001'), rounding=ROUND_HALF_UP).normalize():f}"
    return s


def _norm_text(t: str | None) -> str:
    return re.sub(r"\s+", " ", (t or "").lower().replace("×", "x").replace("*", "x").replace("✕", "x")).strip()


def _unit_ok(u: str | None) -> str | None:
    if not u:
        return None
    n = normalize_code(u)
    return n if n in UNITS else None


class Pack:
    """count x size unit. `size`/`unit` may be missing (pack of 30 pieces => count only)."""
    def __init__(self, count: Decimal | None, size: Decimal | None, unit: str | None, source: str):
        self.count, self.size, self.unit, self.source = count, size, unit, source

    @property
    def dim(self) -> str | None:
        return UNITS[self.unit][0] if self.unit else None

    def base_amount(self) -> Decimal | None:
        """count x size in the dimension's base unit (g / ml / pcs)."""
        if self.size is None or not self.unit:
            return None
        return (self.count or Decimal(1)) * self.size * UNITS[self.unit][1]

    def label(self) -> str:
        bits = ([fmt(self.count)] if self.count and self.count != 1 else []) + ([f"{fmt(self.size)} {self.unit}"] if self.size is not None and self.unit else [])
        return " x ".join(bits) or "?"


def find_pack(text: str | None, source: str) -> Pack | None:
    t = _norm_text(text)
    if not t:
        return None
    for m in _P_COUNT_SIZE.finditer(t):
        u = _unit_ok(m.group(3))
        if u:
            return Pack(_dec(m.group(1)), _dec(m.group(2)), u, source)
    for m in _P_SIZE_COUNT.finditer(t):
        u = _unit_ok(m.group(2))
        if u:
            return Pack(_dec(m.group(3)), _dec(m.group(1)), u, source)
    for m in _P_SIZE.finditer(t):
        u = _unit_ok(m.group(2))
        if u:
            n = _P_PACK_N.search(t)  # "Size 2.55Kg Pack 6": the 6 belongs to the size
            return Pack(_dec(n.group(1)) if n and UNITS[u][0] != "count" else None, _dec(m.group(1)), u, source)
    if m := _P_S.search(t):
        return Pack(None, _dec(m.group(1)), "pcs", source)
    if m := _P_PACK_OF.search(t):
        return Pack(None, _dec(m.group(1)), "pcs", source)
    if m := _P_COUNT_NOUNIT.search(t):
        return Pack(_dec(m.group(1)), _dec(m.group(2)), None, source)
    return None


def plural(word: str, qty: Decimal) -> str:
    if qty == 1:
        return word
    return word + ("es" if word.endswith(("x", "ch", "s")) else "s")


def _agree(a: Pack, b: Pack) -> bool:
    """Same per-unit size (1% tolerance) in the same dimension; counts are compared only when both state one."""
    if a.unit is None or b.unit is None or a.size is None or b.size is None:
        return a.unit is None or b.unit is None
    if a.dim != b.dim:
        return False
    sa, sb = a.size * UNITS[a.unit][1], b.size * UNITS[b.unit][1]
    if abs(sa - sb) > max(sa, sb) * Decimal("0.01"):
        return False
    if a.count and b.count and a.count != b.count and a.source != "description" and b.source != "description":
        return False
    return True


def _display(dim: str, base_amount: Decimal) -> tuple[Decimal, str]:
    """Quantity and unit to store on the line: 61200 g -> 61.2 kg, 7920 ml -> 7.92 l, 20 pcs -> 20 pcs."""
    if dim == "mass":
        return ((base_amount / 1000) if base_amount >= 1000 else base_amount), ("kg" if base_amount >= 1000 else "g")
    if dim == "volume":
        return ((base_amount / 1000) if base_amount >= 1000 else base_amount), ("l" if base_amount >= 1000 else "ml")
    return base_amount, "pcs"


def _q(d: Decimal) -> Decimal:
    return d.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)


def _sale_measure(unit_text: str) -> tuple[Decimal, str, bool] | None:
    """'1 KG' -> (1, kg, explicit), 'KG' -> (1, kg, False), '4X2.5KG' -> (10, kg, True), 'BOX'/'' -> None."""
    t = _norm_text(unit_text)
    if not t:
        return None
    if m := re.fullmatch(rf"{NUM}\s*x\s*{NUM}\s*({UNIT})", t):
        u = _unit_ok(m.group(3))
        if u:
            return _dec(m.group(1)) * _dec(m.group(2)), u, True  # type: ignore[operator]
    if m := re.fullmatch(rf"(?:{NUM}\s*)?({UNIT})", t):
        u = _unit_ok(m.group(2))
        if u:
            return (_dec(m.group(1)) if m.group(1) else Decimal(1)), u, m.group(1) is not None
    return None


def _opt(p: Pack, quantity: Decimal, q: Decimal, u: str) -> dict:
    o = {"label": f"{p.label()} ({p.source}) = {fmt(_q(q))} {u}", "quantity": fmt(_q(q)), "unit": u}
    if p.count and p.count > 1:
        o["count_total"] = fmt(_q(quantity * p.count))  # the same stock as pieces, for items counted in bottles
    return o


def _result(status, quantity, unit, **kw):
    return {"status": status, "quantity": quantity, "unit": unit, "text": None, "reason": None, "count_total": None,
            "measure": None, "options": [], "source": None, "per_unit": None, **kw}


def derive(description: str, quantity: Decimal, unit_text: str | None, pack_count=None, unit_size=None,
           unit_size_unit=None, pack_text: str | None = None) -> dict:
    """-> {status: asis|ok|uncertain, quantity, unit, text, reason, count_total, measure, options}.
    asis: the printed quantity and unit are already a plain kg / l / pcs line. ok: quantity x pack x size worked out.
    uncertain: could not be worked out (or sources disagree); the caller must flag the line."""
    ut = (unit_text or "").strip()
    word = ut.lower()
    sale = _sale_measure(ut)
    structured = None
    size = _dec(unit_size)
    if size is not None and size > 0:
        structured = Pack(_dec(pack_count) or Decimal(1), size, _unit_ok(unit_size_unit), "pack columns")
    elif pack_count is not None and _dec(pack_count) and _dec(pack_count) > 1:
        structured = Pack(_dec(pack_count), None, None, "pack columns")
    rx_all = [x for x in (find_pack(pack_text, "pack text"), find_pack(description, "description")) if x]
    rx = rx_all[0] if rx_all else None
    pack_for_count = structured if structured and structured.unit else rx

    # --- the unit of sale is itself a measure: qty x 1 KG, qty x 10 PRTN, qty x 4X2.5KG
    if sale is not None:
        per, u, explicit = sale
        dim = UNITS[u][0]
        multi = (pack_for_count.count if pack_for_count and pack_for_count.count else None)
        if not explicit and dim != "count" and multi and multi > 1 and pack_for_count and pack_for_count.unit and pack_for_count.dim == dim:
            # "kg" next to "Pack 6 x 2.55kg": is Qty in kg or in cases? Never guess.
            as_is_q, as_is_u = _display(dim, quantity * UNITS[u][1])
            full = quantity * pack_for_count.base_amount()  # type: ignore[operator]
            fq, fu = _display(dim, full)
            return _result("uncertain", quantity, normalize_code(u), reason=f"The invoice shows unit {u} and also a pack of {pack_for_count.label()}. Is the quantity in {u} or in packs?",
                           options=[{"label": f"{fmt(quantity)} {u} (as printed)", "quantity": fmt(as_is_q), "unit": as_is_u},
                                    {"label": f"{fmt(quantity)} packs x {pack_for_count.label()} = {fmt(fq)} {fu}", "quantity": fmt(_q(fq)), "unit": fu}])
        total = quantity * per * UNITS[u][1]
        q, su = _display(dim, total)
        q = _q(q)
        out = _result("ok" if explicit else "asis", q, su)
        if explicit:
            out["text"] = f"{fmt(quantity)} x {fmt(per)} {u if dim != 'count' else 'pcs'}" if per != 1 else f"{fmt(quantity)} x 1 {u}"
        if not explicit and dim == "count" and pack_for_count and pack_for_count.unit and pack_for_count.dim != "count":
            amt = _q(quantity * pack_for_count.base_amount())  # type: ignore[operator]
            mq, mu = _display(pack_for_count.dim, amt)  # type: ignore[arg-type]
            out["measure"] = {"quantity": fmt(_q(mq)), "unit": mu}
            out["text"] = None
        return out

    # --- a package word (case, box ...) or nothing printed: quantity = packages, the pack says what is inside
    sale_word = (word[:-1] if word.endswith("s") and word[:-1] in PACKAGE_WORDS else word) if word in PACKAGE_WORDS or word[:-1] in PACKAGE_WORDS else ""
    names = plural(sale_word or "case", quantity)  # wording of the explanation only; the line unit is never "case" unless printed
    chosen = structured if structured and (structured.unit or structured.count) else None
    if chosen and chosen.unit is None and rx and rx.unit:
        chosen = Pack(chosen.count, rx.size, rx.unit, "pack columns + text") if rx.size is not None and (rx.count is None or rx.count == chosen.count or chosen.count == 1) else chosen
    clash = next((x for x in rx_all if chosen and chosen.unit and x.unit and not _agree(chosen, x)), None)
    if chosen and chosen.unit and clash:
        a, b = chosen, clash
        qa, ua = _display(a.dim, quantity * a.base_amount())  # type: ignore[arg-type,operator]
        qb, ub = _display(b.dim, quantity * b.base_amount())  # type: ignore[arg-type,operator]
        return _result("uncertain", quantity, sale_word or (normalize_code(ut) if ut else "pcs"), reason=f"The pack sizes disagree: {a.label()} ({a.source}) vs {b.label()} ({b.source}). Check the invoice.",
                       options=[_opt(a, quantity, qa, ua), _opt(b, quantity, qb, ub)])
    pack = chosen if chosen and chosen.unit else rx
    if pack is None or (pack.unit is None):
        if pack is not None and pack.count and pack.size is not None:
            return _result("uncertain", quantity, sale_word or (normalize_code(ut) if ut else "pcs"), reason=f"Found a pack of {fmt(pack.count)} x {fmt(pack.size)} but no unit (g, ml, ...). Say what is in the pack.")
        if chosen and chosen.count and chosen.unit is None:
            return _result("uncertain", quantity, sale_word or (normalize_code(ut) if ut else "pcs"), reason=f"{fmt(chosen.count)} per pack, but how much is in each is not on the invoice.")
        if not ut:  # nothing printed to say what the quantity counts: do not invent "cases"
            return _result("uncertain", quantity, "pcs", reason="No unit or pack size is printed on this line. Check the quantity and unit.")
        return _result("uncertain", quantity, sale_word or normalize_code(ut), reason="No pack size found on this line. Say how much one pack holds.")
    count = pack.count or Decimal(1)
    total = quantity * pack.base_amount()  # type: ignore[operator]
    q, su = _display(pack.dim, total)  # type: ignore[arg-type]
    pq, pu = _display(pack.dim, pack.base_amount())  # type: ignore[arg-type,operator]
    out = _result("ok", _q(q), su, source=pack.source, per_unit={"quantity": fmt(_q(pq)), "unit": pu})  # what ONE invoiced unit holds
    if pack.dim == "count":
        out["text"] = " x ".join([f"{fmt(quantity)} {names}"] + ([fmt(count)] if count != 1 else []) + ([f"{fmt(pack.size)} pcs"] if pack.size and pack.size != 1 else []))
    else:
        out["text"] = " x ".join([f"{fmt(quantity)} {names}"] + ([fmt(count)] if count != 1 else []) + [f"{fmt(pack.size)} {pack.unit}"])
        if count > 1:
            out["count_total"] = fmt(_q(quantity * count))  # 12 bottles in the case, for items counted in pieces
    return out


# ------------------------------------------------------------------ UK dates
_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def parse_uk_date(text: str | None) -> date | None:
    """Day-first dates as printed on UK invoices: 09/10/26, 7-10-2026, 8th October 2026. Two-digit years are 20xx."""
    if not text:
        return None
    t = text.strip().lower()
    m = re.search(r"(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2}|\d{4})\b", t)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{2}|\d{4})\b", t)
        if not m or m.group(2)[:3] not in _MONTHS:
            return None
        d, mo, y = int(m.group(1)), _MONTHS[m.group(2)[:3]], int(m.group(3))
    if y < 100:
        y += 2000
    try:
        return date(y, mo, d)
    except ValueError:
        return None
