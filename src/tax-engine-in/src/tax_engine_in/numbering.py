"""Document-number helper: pure functions, no counters and no I/O (the caller owns the sequence).

GST Rule 46 expects a consecutive serial number, unique for a financial year, of at most 16 characters made of
letters, digits, '/' and '-'. The financial year runs 1 April - 31 March. Tax invoices, bills of supply and
credit notes each get a SEPARATE series. All of this is NEEDS CA VERIFICATION (docs/OPEN_QUESTIONS_CA.md).
The caller must restart each series at 1 on 1 April and never skip or reuse a number.
"""
from __future__ import annotations

import re
from datetime import date

from .errors import TaxError

SERIES = {"tax_invoice": "INV", "bill_of_supply": "BOS", "credit_note": "CN"}
MAX_LENGTH = 16
_PREFIX_RE = re.compile(r"^[A-Za-z0-9]*$")


def financial_year(on: date) -> str:
    """'26-27' for any date from 2026-04-01 to 2027-03-31."""
    if not isinstance(on, date):
        raise TaxError("Date must be a datetime.date")
    start = on.year if on.month >= 4 else on.year - 1
    return f"{start % 100:02d}-{(start + 1) % 100:02d}"


def document_number(document_type: str, sequence: int, on: date, prefix: str = "") -> str:
    """e.g. INV/26-27/000001. `prefix` (optional, alphanumeric) distinguishes outlets/terminals."""
    if document_type not in SERIES:
        raise TaxError(f"Unknown document type '{document_type}'")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
        raise TaxError("Sequence must be a positive integer")
    if not isinstance(prefix, str) or not _PREFIX_RE.match(prefix):
        raise TaxError("Prefix must be alphanumeric")
    number = f"{prefix}{SERIES[document_type]}/{financial_year(on)}/{sequence:06d}"
    if len(number) > MAX_LENGTH:
        raise TaxError(f"Document number '{number}' exceeds {MAX_LENGTH} characters")
    return number
