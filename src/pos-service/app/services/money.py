"""ONE place for server-side money formatting (owner decision 2026-10-31, docs/DECISIONS.md: all money is INR, shown with
the rupee sign, Indian digit grouping (lakh / crore) and two decimals).

    fmt_amount(Decimal("1234567.5"))        -> '12,34,567.50'
    fmt_inr(Decimal("1234567.5"))           -> '₹12,34,567.50'      screens, emails, WhatsApp, CSV-free text
    fmt_inr(Decimal("-18625"))              -> '-₹18,625.00'
    fmt_inr_ascii(Decimal("1234567.5"))     -> RUPEE_ASCII + ' 12,34,567.50'   PDFs and thermal print (no rupee sign in their fonts)
    tax_word("gst_engine") -> 'GST'; tax_word("off") -> 'GST'   (India only: the tax is always called GST)

`RUPEE_ASCII` is the only place the ASCII rupee prefix is spelled; everything that prints it goes through here.
"""
import re
from decimal import ROUND_HALF_UP, Decimal

RUPEE = "₹"
RUPEE_ASCII = "Rs."  # the rupee for fonts without the sign (Helvetica, printer code pages)
_PAISA = Decimal("0.01")


def group_indian(digits: str) -> str:
    """'1234567' -> '12,34,567' (last three digits, then pairs)."""
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    pairs = []
    while len(head) > 2:
        pairs.insert(0, head[-2:])
        head = head[:-2]
    return ",".join(([head] if head else []) + pairs + [tail])


def fmt_amount(x) -> str:
    """Two decimals, Indian grouping, no sign: '1,23,456.00', '-12,34,567.50'."""
    v = Decimal(str(x)).quantize(_PAISA, rounding=ROUND_HALF_UP)
    sign = "-" if v < 0 else ""
    whole, frac = f"{abs(v):.2f}".split(".")
    return f"{sign}{group_indian(whole)}.{frac}"


def fmt_inr(x) -> str:
    """'₹12,34,567.50'; the minus goes before the sign: '-₹18,625.00'."""
    body = fmt_amount(x)
    return f"-{RUPEE}{body[1:]}" if body.startswith("-") else f"{RUPEE}{body}"


def fmt_inr_ascii(x) -> str:
    """RUPEE_ASCII + ' 12,34,567.50' (PDF / thermal fonts without the rupee sign); the minus goes first when negative."""
    body = fmt_amount(x)
    return f"-{RUPEE_ASCII} {body[1:]}" if body.startswith("-") else f"{RUPEE_ASCII} {body}"


_RUPEE_SIGN = re.compile(RUPEE + r"\s*")


def ascii_rupee(text: str) -> str:
    """Replaces the rupee sign (and the spaces after it) in free text by RUPEE_ASCII and one space, as fmt_inr_ascii prints it."""
    return _RUPEE_SIGN.sub(RUPEE_ASCII + " ", text)


def tax_word(tax_mode: str | None = None) -> str:
    """How the tax is named in customer-facing text. India only (owner decision 2026-11-01, confirmed by the owner's CA): the tax is
    GST for every restaurant, whatever the engine mode. `tax_mode` ('off' | 'gst_engine') decides which engine computes the tax,
    never the word; the parameter is kept so existing callers keep working."""
    return "GST"


_TAX = re.compile(r"(?<![A-Za-z])Tax(?![A-Za-z])")
_TAX_UP = re.compile(r"(?<![A-Za-z])TAX(?![A-Za-z])")
_TAX_LOW = re.compile(r"(?<![A-Za-z])tax(?![A-Za-z])")


def retax(text: str, word: str, lower: bool = False) -> str:
    """Report labels are written with the neutral word 'Tax'; it becomes the restaurant's tax word, always 'GST' ('TAX' -> 'GST' in
    upper-case text; with `lower`, column names such as 'tax' / 'revenue_excl_tax' -> 'gst' / 'revenue_excl_gst').
    Words that merely start with it ('Taxable value') are left alone."""
    if word == "Tax" or not text:
        return text
    out = _TAX_UP.sub(word.upper(), _TAX.sub(word, text))
    return _TAX_LOW.sub(word.lower(), out) if lower else out
