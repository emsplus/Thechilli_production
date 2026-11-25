"""Tiny layout engine for 80 mm thermal slips (bill + KOT): one page, width fixed, height = content.

Text handling: reportlab's built-in Helvetica/Courier only cover WinAnsi (cp1252). Devanagari and other scripts cannot be
drawn with them (shaping would need a bundled font + extra dependencies), so `safe()` degrades gracefully: every character
the base fonts cannot draw becomes '?', and the rupee sign is printed the way money.fmt_inr_ascii prints it. The
restaurant's menu names should therefore have a Latin name (the web app keeps a Latin `name` for every item); nothing ever
crashes on exotic input.
"""
import io
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

from app.services.money import RUPEE, ascii_rupee, fmt_amount

WIDTH = 226.8  # 80 mm in points
MARGIN = 11.0  # printable width = 204.8 pt (about 72 mm)
INNER = WIDTH - 2 * MARGIN
REG, BOLD = "Helvetica", "Helvetica-Bold"


LOGO_PATH = Path(__file__).resolve().parent.parent / "assets" / "brand" / "receipt-logo.png"
LOGO_WIDTH_MM = 26


@lru_cache(maxsize=1)
def logo() -> ImageReader | None:
    """The receipt logo, loaded once. None (logo skipped) when the file is missing or unreadable."""
    try:
        return ImageReader(str(LOGO_PATH)) if LOGO_PATH.is_file() else None
    except Exception:
        return None


def safe(text: object) -> str:
    out = []
    raw = str(text if text is not None else "")
    for ch in ascii_rupee(raw) if RUPEE in raw else raw:  # the rupee sign is not in WinAnsi
        if ch in "\r\n\t":
            out.append(" ")
        elif ord(ch) < 32 or ord(ch) == 127:
            continue
        else:
            try:
                ch.encode("cp1252")
                out.append(ch)
            except UnicodeEncodeError:
                out.append("?")
    return "".join(out)


def money(x: Decimal) -> str:
    """An amount without the sign, Indian grouping: '12,34,567.50'."""
    return fmt_amount(x)


def width(text: str, font: str, size: float) -> float:
    return stringWidth(text, font, size)


def wrap(text: str, font: str, size: float, max_w: float) -> list[str]:
    """Greedy word wrap; a word wider than the column is hard-split."""
    text = safe(text)
    lines: list[str] = []
    cur = ""
    for word in text.split():
        while width(word, font, size) > max_w:  # hard split an over-long token
            k = len(word)
            while k > 1 and width(word[:k], font, size) > max_w:
                k -= 1
            if cur:
                lines.append(cur)
                cur = ""
            lines.append(word[:k])
            word = word[k:]
        trial = f"{cur} {word}".strip()
        if width(trial, font, size) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines or [""]


def fit(text: str, font: str, size: float, max_w: float, min_size: float = 5.0) -> float:
    while size > min_size and width(text, font, size) > max_w:
        size -= 0.25
    return size


class Slip:
    COMPRESS = 1  # tests set 0 to grep drawn text in the raw PDF bytes
    FONT, FONT_BOLD = REG, BOLD  # subclasses may switch to a monospace face (Z/X reports use Courier)
    MAX_PAGE_H: float | None = None  # when set, a longer roll is split over several pages (Z/X reports use 2500)

    def __init__(self, title: str):
        self.title = safe(title)
        self.y = 8.0  # distance from the top of the paper
        self.ops: list[tuple] = []

    # -- primitives (each records a draw op; y is the baseline distance from the top)
    def _line_h(self, size: float) -> float:
        return size * 1.28

    def text(self, s: str, size: float = 8.5, bold: bool = False, align: str = "l", x: float | None = None,
             w: float | None = None, grey: bool = False, fit_to: float | None = None) -> None:
        """Place one line at the current y without advancing (use `advance`)."""
        s, font = safe(s), self.FONT_BOLD if bold else self.FONT
        if fit_to:
            size = fit(s, font, size, fit_to)
        self.ops.append(("text", s, font, size, align, x, w, self.y + size, grey))

    def advance(self, size: float, extra: float = 0) -> None:
        self.y += self._line_h(size) + extra

    def line(self, s: str, size: float = 8.5, bold: bool = False, align: str = "c", grey: bool = False,
             extra: float = 0) -> None:
        font = self.FONT_BOLD if bold else self.FONT
        for part in wrap(s, font, size, INNER):
            self.text(part, size, bold, align, grey=grey)
            self.advance(size)
        self.y += extra

    def pair(self, left: str, right: str, size: float = 8.5, bold: bool = False, rbold: bool | None = None,
             extra: float = 0) -> None:
        """Left text and right-aligned text on one baseline; the left side shrinks/wraps if they collide."""
        rb = bold if rbold is None else rbold
        right = safe(right)
        rw = width(right, self.FONT_BOLD if rb else self.FONT, size)
        room = INNER - rw - 6
        lines = wrap(left, self.FONT_BOLD if bold else self.FONT, size, room)
        self.text(lines[0], size, bold, "l")
        self.text(right, size, rb, "r")
        self.advance(size)
        for extra_line in lines[1:]:
            self.text(extra_line, size, bold, "l")
            self.advance(size)
        self.y += extra

    def labelled(self, label: str, value: str, size: float = 8.5) -> None:
        """'Name: <bold value>' on one line (wraps the value)."""
        label = safe(label)
        lw = width(label, self.FONT, size)
        parts = wrap(value, self.FONT_BOLD, size, INNER - lw)
        self.text(label, size, False, "l")
        self.text(parts[0], size, True, "l", x=MARGIN + lw)
        self.advance(size)
        for p in parts[1:]:
            self.text(p, size, True, "l", x=MARGIN + lw)
            self.advance(size)

    def image(self, img: ImageReader, width_pt: float, gap: float = 3.0) -> None:
        """Centred picture of the given width (aspect ratio kept) at the current y."""
        iw, ih = img.getSize()
        h = width_pt * ih / iw
        self.ops.append(("image", img, width_pt, h, self.y))
        self.y += h + gap

    def space(self, h: float) -> None:
        self.y += h

    def rule(self, dashed: bool = False, pad: float = 3.0, heavy: bool = False) -> None:
        self.y += pad
        self.ops.append(("rule", self.y, dashed, heavy))
        self.y += pad + (0.6 if heavy else 0.3)

    def box(self, s: str, size: float, pad: float = 4.0) -> None:
        """Inverted (white on black) full-width banner, centred."""
        h = self._line_h(size) + 2 * pad
        self.ops.append(("banner", safe(s), size, self.y, h))
        self.y += h + 3

    def cut_line(self) -> None:
        self.space(8)
        self.rule(dashed=True, pad=0)
        self.space(10)

    # -- output
    @staticmethod
    def _top(op: tuple) -> float:
        kind = op[0]
        if kind == "text":
            return op[7] - op[3]
        if kind == "rule":
            return op[1]
        return op[4] if kind == "image" else op[3]

    def render(self) -> bytes:
        total = max(self.y + 4, 60.0)
        if not self.MAX_PAGE_H or total <= self.MAX_PAGE_H:
            pages, height = [(0.0, self.ops)], total
        else:  # split on op boundaries: each op lands on the page its top edge falls in
            n = int(total // self.MAX_PAGE_H) + 1
            height = self.MAX_PAGE_H + 14  # small overlap room so nothing straddling the cut is clipped
            buckets: list[list[tuple]] = [[] for _ in range(n)]
            for op in self.ops:
                buckets[min(int(self._top(op) // self.MAX_PAGE_H), n - 1)].append(op)
            pages = [(i * self.MAX_PAGE_H, b) for i, b in enumerate(buckets) if b]
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(WIDTH, height), pageCompression=self.COMPRESS)
        c.setTitle(self.title)
        c.setAuthor("")
        for offset, ops in pages:
            self._draw(c, ops, height, offset)
            c.showPage()
        c.save()
        return buf.getvalue()

    def _draw(self, c, ops: list[tuple], height: float, offset: float) -> None:
        for op in ops:
            kind = op[0]
            if kind == "text":
                _, s, font, size, align, x, w, base, grey = op
                c.setFont(font, size)
                c.setFillGray(0.35 if grey else 0)
                yy = height - (base - offset)
                if align == "c":
                    c.drawCentredString(WIDTH / 2, yy, s)
                elif align == "r":
                    c.drawRightString((x if x is not None else WIDTH - MARGIN), yy, s)
                else:
                    c.drawString(x if x is not None else MARGIN, yy, s)
                c.setFillGray(0)
            elif kind == "rule":
                _, y, dashed, heavy = op
                c.setLineWidth(0.9 if heavy else 0.5)
                c.setDash(*((2.5, 2.5) if dashed else ()))
                c.line(MARGIN, height - (y - offset), WIDTH - MARGIN, height - (y - offset))
                c.setDash()
            elif kind == "image":
                _, img, w, h, top = op
                c.drawImage(img, (WIDTH - w) / 2, height - (top - offset) - h, w, h, mask="auto")
            elif kind == "banner":
                _, s, size, top, h = op
                top -= offset
                c.setFillGray(0)
                c.rect(MARGIN, height - top - h, INNER, h, stroke=0, fill=1)
                c.setFillGray(1)
                c.setFont(BOLD, fit(s, BOLD, size, INNER - 8))
                c.drawCentredString(WIDTH / 2, height - top - h + (h - size) / 2 + size * 0.18, s)
                c.setFillGray(0)
