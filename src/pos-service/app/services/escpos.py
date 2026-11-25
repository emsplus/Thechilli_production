"""ESC/POS rendering for the print hub (docs/print-hub-contract.md): a tiny byte builder plus the bill, KOT and test-page
layouts. Pure functions of their inputs (no network, no heavy dependency; Pillow is only used for the optional logo).

Text is encoded for the printer's code page (PC858 by default). No thermal code page has the rupee sign: amounts print with
the ASCII rupee prefix (money.fmt_inr_ascii), and a line with the rupee sign (or Devanagari) goes out as a bitmap when the vendored font is present. A character the
page cannot show becomes its closest ASCII form or '?': rendering never raises on odd item names."""
import logging
import os
import unicodedata
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

ESC, GS = b"\x1b", b"\x1d"
# name -> (python codec, ESC t n); "none" sends no ESC t (the printer's own default page, usually PC437)
CODEPAGES = {"pc858": ("cp858", 19), "cp1252": ("cp1252", 16), "cp437": ("cp437", 0), "none": ("cp437", None)}
DOUBLE_W, DOUBLE_H = 0x10, 0x01  # GS ! n: bits 4-6 = width - 1, bits 0-2 = height - 1
LOGO_PATH = Path(__file__).resolve().parent.parent / "assets" / "brand" / "receipt-logo.png"
LOGO_WIDTH_PX = 384

RASTER_FONT = Path(os.environ.get("RECEIPT_FONT_PATH") or
                   Path(__file__).resolve().parent.parent / "assets" / "fonts" / "NotoSansDevanagari-Regular.ttf")
DOTS_PER_COL = 12          # Font A: 384 dots on 32 columns (58 mm), 576 on 48 (80 mm)
RASTER_PX = 24             # glyph height of a rastered text line, before any double size
log = logging.getLogger(__name__)

ORDER_TYPE = {"indoor": "DINE IN", "outdoor": "OUTDOOR", "takeaway": "TAKE AWAY", "delivery": "DELIVERY"}


def encode(text: str, codepage: str = "pc858") -> bytes:
    """Never raises: unsupported characters fall back to their ASCII decomposition, else '?'."""
    codec = CODEPAGES.get(codepage, CODEPAGES["pc858"])[0]
    out = bytearray()
    for ch in str(text):
        if ch in "\r\n\t":
            out += b" "
            continue
        try:
            out += ch.encode(codec)
            continue
        except UnicodeEncodeError:
            pass
        base = _ASCII_PUNCT.get(ch) or unicodedata.normalize("NFKD", ch).encode("ascii", "ignore")
        out += base if base else b"?"
    return bytes(out)


_ASCII_PUNCT = {"\u2018": b"'", "\u2019": b"'", "\u201c": b'"', "\u201d": b'"', "\u2013": b"-", "\u2014": b"-",
                "\u2026": b"..."}


# ----------------------------------------------------------------------------------- raster text (Devanagari, rupee)
def _raster_char(ch: str) -> bool:
    """A character no thermal code page has but the vendored font can draw: Devanagari block (Hindi, Marathi), ZWJ/ZWNJ and
    the rupee sign. Anything else unsupported (CJK, Arabic ...) still prints as '?' on the text path."""
    o = ord(ch)
    if o < 0x80:
        return False
    return 0x0900 <= o <= 0x097F or o in (0x200C, 0x200D, 0x20B9)


def needs_raster(s: str) -> bool:
    return any(_raster_char(c) for c in str(s))


_FONT_CACHE: dict = {}


def _font():
    """The Devanagari-capable font, or None (the text path is then used). Complex-script shaping (matras, conjuncts) needs
    Pillow's libraqm; without it glyphs are drawn unshaped, so a warning is logged once."""
    if "f" not in _FONT_CACHE:
        f = None
        try:
            from PIL import ImageFont, features
            raqm = features.check("raqm")
            if not raqm:
                log.warning("Pillow has no libraqm: Hindi on receipts will be unshaped (install libraqm0 + libfribidi0)")
            f = ImageFont.truetype(str(RASTER_FONT), RASTER_PX,
                                   layout_engine=ImageFont.Layout.RAQM if raqm else ImageFont.Layout.BASIC)
        except Exception as exc:  # noqa: BLE001 - no font / no Pillow: rendering must never raise
            log.warning("receipt raster font unavailable (%s): Hindi will print as '?'", exc)
        _FONT_CACHE["f"] = f
    return _FONT_CACHE["f"]


def _px_wrap(font, text: str, max_px: int) -> list[str]:
    lines: list[str] = []
    cur = ""
    for word in str(text).split():
        trial = word if not cur else cur + " " + word
        if font.getlength(trial) <= max_px:
            cur = trial
            continue
        if cur:
            lines.append(cur)
            cur = ""
        while font.getlength(word) > max_px and len(word) > 1:  # a single over-long word: split by characters
            k = len(word) - 1
            while k > 1 and font.getlength(word[:k]) > max_px:
                k -= 1
            lines.append(word[:k])
            word = word[k:]
        cur = word
    if cur or not lines:
        lines.append(cur)
    return lines


def raster_text_lines(left: str, right: str = "", *, width_px: int, bold: bool = False, wide: int = 1, high: int = 1,
                      align: str = "l", indent_px: int = 0) -> list[tuple[int, int, bytes]] | None:
    """One logical line as 1-bit images (one per wrapped line): `left` flush left, `right` flush right on the last one.
    A double-width request falls back to single width when it does not fit. None when no font is available."""
    font = _font()
    if font is None:
        return None
    from PIL import Image, ImageDraw
    width_px = max(8, width_px - width_px % 8)
    left, right = str(left), str(right)
    stroke = 1 if bold else 0
    gap = font.getlength("  ")
    for w in ([wide, 1] if wide > 1 else [1]):
        avail = width_px // w - indent_px
        rw = font.getlength(right) if right else 0
        if w == wide and wide > 1 and font.getlength(left) + rw + (gap if right else 0) > avail:
            continue  # does not fit at double width: retry at single width
        room = avail - (rw + gap if right else 0)
        parts = _px_wrap(font, left, room) if left else [""]
        if right and left and font.getlength(parts[0]) > room:  # no room beside the right text: it gets its own line
            parts, own_line = _px_wrap(font, left, avail), True
        else:
            own_line = False
        asc, desc = font.getmetrics()
        h = asc + desc + 2 * stroke + 2
        rows_ = parts + ([""] if own_line else [])
        out = []
        for i, part in enumerate(rows_):
            im = Image.new("L", (width_px // w, h), 0)
            d = ImageDraw.Draw(im)
            y = stroke + 1
            if part and not (right and i == len(rows_) - 1 and own_line):
                x = indent_px
                if align != "l" and not right:
                    free = avail - font.getlength(part)
                    x += int(free / 2 if align == "c" else free)
                d.text((x, y), part, font=font, fill=255, stroke_width=stroke, stroke_fill=255)
            if right and i == len(rows_) - 1:
                d.text((width_px // w - rw - stroke, y), right, font=font, fill=255, stroke_width=stroke, stroke_fill=255)
            if (w, high) != (1, 1):
                im = im.resize((im.width * w, im.height * high), Image.NEAREST)
            im = im.point(lambda v: 255 if v >= 128 else 0).convert("1")
            out.append((im.width, im.height, im.tobytes()))
        return out
    return None


def wrap(text: str, width: int) -> list[str]:
    """Word wrap to `width` characters; a word longer than the line is split."""
    width = max(width, 1)
    lines: list[str] = []
    cur = ""
    for word in str(text).split():
        while len(word) > width:
            if cur:
                lines.append(cur)
                cur = ""
            lines.append(word[:width])
            word = word[width:]
        if not cur:
            cur = word
        elif len(cur) + 1 + len(word) <= width:
            cur += " " + word
        else:
            lines.append(cur)
            cur = word
    if cur or not lines:
        lines.append(cur)
    return lines


class Escpos:
    def __init__(self, columns: int = 42, codepage: str = "pc858"):
        self.columns = columns
        self.codepage = codepage if codepage in CODEPAGES else "pc858"
        self.buf = bytearray()
        self._wide = 1  # horizontal size multiplier currently selected (halves the usable columns)
        self.init()

    @property
    def cols(self) -> int:
        return max(self.columns // self._wide, 1)

    # --- control ---
    def raw(self, b: bytes) -> "Escpos":
        self.buf += b
        return self

    def init(self) -> "Escpos":
        self.raw(ESC + b"@")
        n = CODEPAGES[self.codepage][1]
        if n is not None:
            self.raw(ESC + b"t" + bytes([n]))
        self._wide = 1
        return self

    def set_codepage(self, name: str) -> "Escpos":
        """Switch the code page mid-ticket (ESC t n) and encode the following text for it."""
        self.codepage = name if name in CODEPAGES else "pc858"
        n = CODEPAGES[self.codepage][1]
        return self.raw(ESC + b"t" + bytes([n])) if n is not None else self

    def align(self, where: str = "l") -> "Escpos":
        return self.raw(ESC + b"a" + bytes([{"l": 0, "c": 1, "r": 2}[where]]))

    def bold(self, on: bool = True) -> "Escpos":
        return self.raw(ESC + b"E" + bytes([1 if on else 0]))

    def size(self, wide: int = 1, high: int = 1) -> "Escpos":
        """1 or 2 times normal width / height (GS ! n)."""
        wide, high = (2 if wide >= 2 else 1), (2 if high >= 2 else 1)
        self._wide = wide
        return self.raw(GS + b"!" + bytes([(DOUBLE_W if wide == 2 else 0) | (DOUBLE_H if high == 2 else 0)]))

    def normal(self) -> "Escpos":
        return self.size(1, 1).bold(False).align("l")

    # --- text ---
    def text(self, s: str) -> "Escpos":
        return self.raw(encode(s, self.codepage))

    def nl(self, n: int = 1) -> "Escpos":
        return self.raw(b"\n" * n)

    def _px(self) -> int:
        return self.columns * DOTS_PER_COL

    def _emit_raster(self, imgs) -> None:
        for w, h, data in imgs:
            wb = w // 8
            self.raw(GS + b"v0" + bytes([0, wb & 0xFF, wb >> 8, h & 0xFF, h >> 8]) + data)

    def _try_raster(self, left: str, right: str = "", *, bold=False, wide=1, high=1, align="l", indent=0) -> bool:
        """Text path stays the default; a line with Devanagari or the rupee sign goes out as GS v 0 bitmaps instead."""
        if not (needs_raster(left) or needs_raster(right)):
            return False
        imgs = raster_text_lines(left, right, width_px=self._px(), bold=bold, wide=wide, high=high, align=align,
                                 indent_px=indent * DOTS_PER_COL)
        if imgs is None:
            return False
        self._emit_raster(imgs)
        return True

    def line(self, s: str = "", align: str = "l", bold: bool = False, wide: int = 1, high: int = 1,
             indent: int = 0) -> "Escpos":
        """One logical line, wrapped to the printer width, in the given style; style is reset afterwards."""
        self.align(align).bold(bold).size(wide, high)
        if self._try_raster(s, bold=bold, wide=wide, high=high, align=align, indent=indent):
            return self.normal()
        for part in wrap(s, self.cols - indent):
            self.text(" " * indent + part).nl()
        return self.normal()

    def rule(self, ch: str = "-") -> "Escpos":
        return self.text(ch * self.columns).nl()

    def two_col(self, left: str, right: str, bold: bool = False, wide: int = 1, high: int = 1) -> "Escpos":
        """`left` at the left edge, `right` at the right edge of the line; `left` wraps when they do not fit. A double
        width line that would not fit falls back to single width rather than breaking mid-word."""
        right = str(right)
        if wide > 1 and len(str(left)) + (1 if right else 0) + len(right) > self.columns // wide:
            wide = 1
        self.align("l").bold(bold).size(wide, high)
        if self._try_raster(left, right, bold=bold, wide=wide, high=high):
            return self.normal()
        room = self.cols - len(right) - (1 if right else 0)
        parts = wrap(left, max(room, 1)) if left else [""]
        longest = max((len(w) for w in str(left).split()), default=0)
        if len(parts[0]) > room or longest > room:  # no room beside the right text: it goes on its own line
            parts = wrap(left, self.cols)
            for p in parts:
                self.text(p).nl()
            self.text(right.rjust(self.cols)).nl()
            return self.normal()
        for i, p in enumerate(parts):
            if i == len(parts) - 1:
                self.text(p.ljust(self.cols - len(right)) + right).nl()
            else:
                self.text(p).nl()
        return self.normal()

    def cells(self, label: str, nums: list[str], widths: list[int], bold: bool = False) -> "Escpos":
        """Table row: wrapped label on the left, right-aligned numeric cells (width + 1 gap each) on the right. A number is
        never cut: a cell grows to fit its text, and when the label would be left with under 8 columns the numbers go on
        their own right-aligned line below it."""
        widths = [max(w, len(n)) for n, w in zip(nums, widths)]
        right = "".join(" " + n.rjust(w) for n, w in zip(nums, widths))
        room = self.cols - len(right)
        self.align("l").bold(bold).size(1, 1)
        if room < 8 or needs_raster(label):
            if not self._try_raster(label, bold=bold):
                for p in wrap(label, self.cols):
                    self.text(p).nl()
            self.text(right.strip().rjust(self.cols) if len(right.strip()) <= self.cols else right.strip()).nl()
            return self.normal()
        parts = wrap(label, max(room, 1))
        for i, p in enumerate(parts):
            self.text(p.ljust(room) + right if i == 0 else p).nl()
        return self.normal()

    # --- graphics ---
    def qr(self, data: str, module: int = 6) -> "Escpos":
        """QR code (GS ( k, model 2, error correction M), centred."""
        d = data.encode("utf-8")[:700]
        n = len(d) + 3
        self.align("c")
        self.raw(GS + b"(k" + bytes([4, 0, 49, 65, 50, 0]))                   # model 2
        self.raw(GS + b"(k" + bytes([3, 0, 49, 67, max(1, min(module, 16))]))   # module size
        self.raw(GS + b"(k" + bytes([3, 0, 49, 69, 49]))                       # error correction M
        self.raw(GS + b"(k" + bytes([n & 0xFF, n >> 8, 49, 80, 48]) + d)       # store
        self.raw(GS + b"(k" + bytes([3, 0, 49, 81, 48]))                       # print
        self.nl()
        return self.align("l")

    def raster(self, width_px: int, height_px: int, data: bytes) -> "Escpos":
        """GS v 0: 1-bit image, 1 = black, rows packed MSB first, width a multiple of 8."""
        wb = width_px // 8
        self.align("c")
        self.raw(GS + b"v0" + bytes([0, wb & 0xFF, wb >> 8, height_px & 0xFF, height_px >> 8]) + data)
        return self.align("l")

    def logo(self, path: Path = LOGO_PATH, width_px: int = LOGO_WIDTH_PX) -> "Escpos":
        """Dithered logo from the brand folder; silently skipped when the file or Pillow is unusable."""
        img = logo_raster(path, width_px)
        if img:
            self.raster(*img)
            self.nl()
        return self

    # --- end of ticket ---
    def finish(self, cut: bool = True, feed: int = 4) -> bytes:
        self.normal()
        if cut:
            self.raw(GS + b"V" + bytes([66, feed]))  # feed n lines, partial cut
        else:
            self.nl(feed + 2)
        return bytes(self.buf)


def logo_raster(path: Path = LOGO_PATH, width_px: int = LOGO_WIDTH_PX) -> tuple[int, int, bytes] | None:
    try:
        from PIL import Image
        img = Image.open(path)
        img.load()
        if img.mode in ("RGBA", "LA", "P"):
            rgba = img.convert("RGBA")
            bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            img = Image.alpha_composite(bg, rgba)
        gray = img.convert("L")
        width_px = max(8, width_px - width_px % 8)
        h = max(1, round(gray.height * width_px / gray.width))
        bw = gray.resize((width_px, h)).convert("1")  # Floyd-Steinberg dither; in mode "1" 255 = white
        packed = bytearray()
        px = bw.load()
        for y in range(h):
            for x in range(0, width_px, 8):
                byte = 0
                for bit in range(8):
                    byte = (byte << 1) | (1 if px[x + bit, y] == 0 else 0)
                packed.append(byte)
        return width_px, h, bytes(packed)
    except Exception:  # noqa: BLE001 - a bad logo must never break a receipt
        return None


from app.services.money import RUPEE_ASCII, fmt_amount, fmt_inr, fmt_inr_ascii, group_indian  # noqa: E402,F401


def money(x) -> str:
    """1,23,456.00 (lakh / crore grouping, no sign)."""
    return fmt_amount(x)


# ------------------------------------------------------------------------------------------------ bill
def render_bill(db, bill, tz: str, *, columns: int = 42, codepage: str = "pc858", cut: bool = True,
                logo: bool = False, reprint: bool = False) -> bytes:
    """Same content and order as services/receipt.render_receipt, from the same finalized snapshot and helpers."""
    from app.services import receipt as R
    snap = R.snapshot_fallbacks(db, bill)
    v = R.View(bill)
    when = (getattr(bill, "sale_at", None) or bill.finalized_at).astimezone(ZoneInfo(tz))
    notes = R.amend_notes(db, bill, tz)
    fm = money
    e = Escpos(columns, codepage)
    if logo:  # opt-in; no caller asks for it today
        e.logo()
    if reprint:
        e.line("** REPRINT **", "c", True)
    name_wide = 2 if len(bill.seller_name) * 2 <= columns else 1
    e.line(bill.seller_name, "c", True, wide=name_wide, high=name_wide)
    if bill.seller_address:
        e.line(bill.seller_address, "c")
    if getattr(bill, "seller_phone", None):
        e.line(f"Tel: {bill.seller_phone}", "c")
    if bill.seller_trn and v.registered:
        e.line(f"{v.tax_label}: {bill.seller_trn}", "c", True)
    e.nl()
    e.line(v.title, "c", True)
    if notes["voided"]:
        e.line(notes["voided"], "c", True)
        e.line("Voided. Not valid.", "c")
    if v.gst and v.gst["customer_gstin"]:
        e.line(f"Customer GSTIN: {v.gst['customer_gstin']}", "c")
    if notes["superseded_by"]:
        e.line(notes["superseded_by"], "c", True)
        e.line("Cancelled by a correction. Not valid.", "c")
    for key in ("replaces", "corrected_on"):
        if notes[key]:
            e.line(notes[key], "c", key == "replaces")
    e.rule("=")
    if snap["customer_name"]:
        e.line(f"Name: {snap['customer_name']}")
    if snap["customer_phone"]:
        e.line(f"Phone: {snap['customer_phone']}")
    otype = R.type_label(snap["order_type"])
    clock = when.strftime("%I:%M %p").lstrip("0")
    e.two_col(f"Date: {when.strftime('%d/%m/%Y')}", f"Bill#: {bill.invoice_number}")
    if snap["table_label"]:
        e.two_col(f"Time: {clock}", f"Table: {snap['table_label']}")
        if otype:
            e.two_col("", f"Type: {otype}")
    else:
        e.two_col(f"Time: {clock}", f"Type: {otype}" if otype else "")
    if snap["token_number"] is not None:
        e.line(f"Token: {snap['token_number']}")
    if snap["order_note"]:
        e.line(f"Note: {snap['order_note']}")
    e.rule()
    # items: Item | Qty | Price | Amt. Column widths adapt to the widest number in the bill (a number is never cut);
    # narrow printers, or numbers too wide to leave the name 10+ columns, put the numbers on a second line.
    rows = [(str(l.quantity), fm(l.unit_price), fm(l.line_total)) for l in bill.lines]
    heads = ("Qty", "Price", "Amt")
    widths = [max([len(heads[i]), (3, 7, 8)[i]] + [len(r[i]) for r in rows]) for i in range(3)]
    inline = columns >= 36 and columns - sum(w + 1 for w in widths) >= 10
    if inline:
        e.cells("Item", list(heads), widths, bold=True)
    else:
        e.line("Item", bold=True)
    e.rule()
    for li, (l, (q, up, lt)) in enumerate(zip(bill.lines, rows)):
        if inline:
            e.cells(l.description, [q, up, lt], widths)
        else:
            e.line(l.description)
            sub = f"  {q} x {up}"
            if len(sub) + 1 + len(lt) > columns:
                e.line(sub)
                e.two_col("", lt)
            else:
                e.two_col(sub, lt)
        if v.gst and v.gst["hsn"][li]:
            e.line(f"  HSN/SAC {v.gst['hsn'][li]}")
    e.rule()
    e.two_col("Total Qty", str(sum(l.quantity for l in bill.lines)))
    adjusted = v.discount > 0 or v.sc > 0
    cur = "INR"
    if v.gst:
        g = v.gst
        if adjusted or g["charges"]:
            e.two_col("Sub Total", fm(v.items_total))
        for lbl, amt in R.discount_rows(v):
            e.two_col(lbl, f"-{fm(amt)}")
        if v.sc > 0:
            e.two_col(R.sc_label(v), fm(v.sc))
        for lbl, amt in g["charges"]:
            e.two_col(lbl, fm(amt))
        if not v.inclusive:
            e.two_col("Taxable value", fm(bill.subtotal))
            for lbl, amt in g["tax_rows"]:
                e.two_col(lbl, fm(amt))
        if g["round_off"]:
            e.two_col("Round off", v.signed(g["round_off"]))
        e.rule("=")
        e.two_col("Total", fmt_inr_ascii(bill.total), bold=True, wide=2, high=2)
        e.rule()
        if v.inclusive:
            e.line(f"{v.tax_word} included in the total:")
            e.two_col("Taxable value", fm(bill.subtotal))
            for lbl, amt in g["tax_rows"]:
                e.two_col(lbl, fm(amt))
        if g["place_of_supply"]:
            e.line(f"Place of supply: {g['place_of_supply']}")
        if g["legend"]:
            e.line(g["legend"])
        if v.inclusive or g["place_of_supply"] or g["legend"]:
            e.rule()
    elif v.inclusive:
        if adjusted:
            e.two_col("Sub Total", fm(v.items_total))
        for lbl, amt in R.discount_rows(v):
            e.two_col(lbl, f"-{fm(amt)}")
        if v.sc > 0:
            e.two_col(R.sc_label(v), fm(v.sc))
        e.rule("=")
        e.two_col("Total", fmt_inr_ascii(bill.total), bold=True, wide=2, high=2)
        e.rule()
        if v.registered:
            _tax_summary(e, R.rate_rows(bill), R.pct, fm, v.tax_word)
            e.line(f"Prices include {v.tax_word}")
            e.rule()
    else:
        for lbl, amt in R.discount_rows(v):
            e.two_col(lbl, f"-{fm(amt)}")
        if v.sc > 0:
            e.two_col(R.sc_label(v), fm(v.sc))
        if v.registered:
            e.two_col(f"Sub Total ({cur}, excl. {v.tax_word})", fm(bill.subtotal))
            if len(v.breakdown) > 1:
                for r in R.rate_rows(bill):
                    e.two_col(f"{v.tax_word} {R.pct(r['rate_percent'])}", fm(r["vat"]))
            else:
                e.two_col(R._tax_label(bill, v), fm(bill.tax_amount))
        elif v.tax_charged_unregistered:  # the bill added tax although no GSTIN is set: one plain line so the total adds up
            e.two_col("Sub Total", fm(bill.subtotal))
            e.two_col("Taxes", fm(bill.tax_amount))
        e.rule("=")
        e.two_col("Grand Total", fmt_inr_ascii(bill.total), bold=True, wide=2, high=2)
        e.rule()
    paid = Decimal(0)
    for pay in bill.payments:
        paid += pay.amount
        if pay.method.value == "credit_note":
            e.two_col(f"Credit from {notes['orig_number'] or 'original invoice'}", fm(pay.amount))
        elif pay.amount < 0:
            e.two_col(f"Returned {pay.method.value.upper()}", fm(pay.amount))
        else:
            e.two_col(f"Payment {pay.method.value.upper()}", fm(pay.amount))
    for r in bill.refunds:
        kind = "Credit note" if getattr(r, "kind", "refund") in ("amendment", "void") else "Refund"
        e.two_col(f"{kind} {r.credit_note_number}", f"-{fm(r.amount)}")
        if r.tax_amount and v.registered:
            multi = len(v.breakdown) > 1
            e.two_col(f"  incl. {v.tax_word}" if multi else f"  incl. {R._tax_label(bill, v)}", f"-{fm(r.tax_amount)}")
        if getattr(r, "payout_amount", 0) and r.payout_amount > 0:
            e.two_col(f"  Returned to customer ({r.payout_method})", fm(r.payout_amount))
    if paid < bill.total and getattr(bill, "status", "active") == "active":
        e.two_col("Balance due", fmt_inr_ascii(bill.total - paid), bold=True)
    e.rule()
    e.nl()
    e.line("Thank you for dining with us!", "c", True)
    e.line("Visit again.", "c", True)
    if snap["cashier_name"]:
        e.line(f"Served by {snap['cashier_name']}", "c")
    return e.finish(cut)


def _tax_summary(e: Escpos, rows: list[dict], pct, fm=money, word: str = "GST") -> None:
    cells_ = [(f"{r['code'].title()} {pct(r['rate_percent'])}", fm(r["net"]), fm(r["vat"]), fm(r["gross"])) for r in rows]
    heads = ("Net", word, "Gross")
    widths = [max([len(heads[i]), 8] + [len(c[i + 1]) for c in cells_]) for i in range(3)]
    if e.columns >= 40 and e.columns - sum(w + 1 for w in widths) >= 10:
        e.cells(f"{word} rate", list(heads), widths, bold=True)
        for c in cells_:
            e.cells(c[0], list(c[1:]), widths)
    else:
        for c in cells_:
            e.line(c[0])
            one = f"  Net {c[1]} {word} {c[2]}"
            if len(one) + 1 + len(c[3]) <= e.columns:
                e.two_col(one, c[3])
            else:
                for label, val in (("  Net", c[1]), (f"  {word}", c[2]), ("  Gross", c[3])):
                    e.two_col(label, val)


# ------------------------------------------------------------------------------------------------ KOT
def kot_seq_label(order_type: str | None, number: int) -> str:
    return f"SEQ:{ORDER_TYPE.get(order_type or '', (order_type or 'ORDER').upper())}-{number:03d}"


def render_kot(db, kot, lines: list[dict], *, columns: int = 42, codepage: str = "pc858", cut: bool = True,
               reprint: bool = False) -> bytes:
    """Kitchen slip for `lines` (the KOT's payload entries, possibly filtered for one printer). Data as services/kot_slip."""
    from app.models.core import DiningTable, Order, Restaurant, User
    rest = db.get(Restaurant, kot.restaurant_id)
    order = db.get(Order, kot.order_id)
    table = db.get(DiningTable, order.table_id) if order and order.table_id else None
    waiter = db.get(User, order.created_by) if order else None
    when = kot.created_at.astimezone(ZoneInfo(rest.timezone))
    otype = order.order_type.value if order else None
    e = Escpos(columns, codepage)
    if reprint:
        e.line("** REPRINT **", "c", True)
    if getattr(kot.status, "value", kot.status) == "cancelled":
        e.line("*** CANCELLED ***", "c", True, wide=2, high=2)
    seq = kot_seq_label(otype, kot.number)
    big = 2 if len(seq) * 2 <= columns else 1
    e.line(seq, "c", True, wide=big, high=big)
    from app.services.kot_slip import is_addon
    if is_addon(db, kot):  # a later KOT of the same order: only the items added since the earlier one
        e.line("*** ADD-ON TO EARLIER ORDER ***", "c", True)
    e.rule("=")
    e.line(f"CASHIER: {waiter.full_name if waiter else '-'}")
    e.line(f"INVOICE NO: {kot.number}")
    e.line(f"DATE: {when.strftime('%d/%m/%Y %H:%M')}")
    if table:
        e.line(f"TABLE: {table.label}", bold=True)
    if order and order.token_number is not None:
        e.line(f"TOKEN: {order.token_number}", bold=True)
    if order and order.note:
        e.line(f"NOTE: {order.note.upper()}", bold=True)
    e.rule()
    for i, ln in enumerate(lines, 1):
        qty = int(ln.get("qty", 1))
        e.two_col(f"{i}. {str(ln.get('item', '')).upper()}", f"x{qty}", bold=True)
        for m in ln.get("modifiers") or []:  # docs/MODIFIERS_OFFERS.md
            e.line(f"> {str(m).upper()}", indent=3)
        for c in ln.get("components") or []:
            e.line(f"* {c.get('qty', 1)} X {str(c.get('item', '')).upper()}", indent=3)
        if ln.get("note"):
            e.line(f"**** {str(ln['note']).upper()}", indent=3)
    e.rule()
    e.line(f"Total: {len(lines)} item{'s' if len(lines) != 1 else ''}", bold=True)
    return e.finish(cut)


# ------------------------------------------------------------------------------------------------ test page
def render_test(printer_name: str, tz: str = "UTC", *, columns: int = 42, codepage: str = "pc858", cut: bool = True,
                now: datetime | None = None) -> bytes:
    """Diagnostic page for setting a printer up on site: a ruler (pick `columns`), the same amount under three code pages
    (pick `codepage`: the one whose accented letters print correctly), the rupee sign as a bitmap line (shows whether this
    printer can print the symbol or receipts should keep the ASCII prefix), bold, double size, a QR code and a partial cut."""
    e = Escpos(columns, codepage)
    when = (now or datetime.now(ZoneInfo("UTC"))).astimezone(ZoneInfo(tz))
    e.line("TEST PRINT", "c", True, wide=2, high=2)
    e.line(printer_name, "c", True)
    e.line(when.strftime("%d/%m/%Y %H:%M:%S"), "c")
    e.rule("=")
    e.line("Ruler: the last digit of the last full line is the number of columns that fit.")
    e.text(("1234567890" * 7)[:columns]).nl()
    e.text("".join("+" if (i + 1) % 10 == 0 else "-" for i in range(columns))).nl()
    e.line(f"Columns: {columns}   Codepage: {codepage}")
    e.rule()
    for label, name in (("PC858 (ESC t 19)", "pc858"), ("WPC1252 (ESC t 16)", "cp1252"), ("PC437 (ESC t 0)", "cp437")):
        e.set_codepage(name)
        e.line(f"RUPEE: {fmt_inr_ascii(Decimal('1234.50'))}  Caf\u00e9  {label}")
    e.set_codepage(codepage)  # back to the printer's own setting
    e.line("Pick the codepage whose line prints 'Cafe' with an accented e.")
    e.line(f"Rupee sign: {fmt_inr(Decimal('1234.50'))}")
    e.line(f"If the line above shows the rupee sign, receipts can print it; otherwise they print {RUPEE_ASCII}")
    e.rule()
    e.line("Bold text", bold=True)
    e.line("Double size", wide=2, high=2)
    e.qr(f"{printer_name} {when:%Y-%m-%d %H:%M}")
    e.line("Printer is working.", "c")
    return e.finish(cut)
