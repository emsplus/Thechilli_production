"""Input validators: GSTIN, HSN/SAC and GST state codes. Pure functions.

Every legal statement here is NEEDS CA VERIFICATION (see docs/OPEN_QUESTIONS_CA.md): the state-code list, the
GSTIN structure/checksum, and the 4/6/8-digit HSN/SAC lengths.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from .errors import TaxError

# GST state / UT codes. NEEDS CA VERIFICATION. Legacy 25 (Daman & Diu) and 28 (undivided Andhra Pradesh) are
# deliberately NOT accepted: 25 was merged into 26 and 28 was replaced by 37.
GST_STATE_CODES: dict[str, str] = {
    "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
    "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
    "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
    "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
    "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
    "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
    "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
    "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
    "97": "Other Territory", "99": "Centre Jurisdiction",
}

_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_GSTIN_RE = re.compile(r"^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$")
_HSN_RE = re.compile(r"^[0-9]+$", re.ASCII)


def normalise_state_code(code: str) -> str:
    """'7' -> '07'; must be a known GST state code. Blank, non-digit or unknown codes raise TaxError."""
    if not isinstance(code, str):
        raise TaxError("State code must be a string")
    c = code.strip()
    if not c:
        raise TaxError("State code is blank")
    if not _HSN_RE.match(c) or len(c) > 2:
        raise TaxError(f"Invalid state code '{code}'")
    c = c.zfill(2)
    if c not in GST_STATE_CODES:
        raise TaxError(f"Unknown GST state code '{code}'")
    return c


def gstin_checksum(first14: str) -> str:
    """Check character for the first 14 characters of a GSTIN (base-36, alternating weights 1/2)."""
    total = 0
    for i, ch in enumerate(first14):
        p = _ALPHABET.index(ch) * (2 if i % 2 else 1)
        total += p // 36 + p % 36
    return _ALPHABET[(36 - total % 36) % 36]


def validate_gstin(gstin: str) -> str:
    """Return the trimmed upper-case GSTIN or raise TaxError (length, state, PAN pattern, 'Z', checksum)."""
    if not isinstance(gstin, str):
        raise TaxError("GSTIN must be a string")
    g = gstin.strip().upper()
    if len(g) != 15:
        raise TaxError("GSTIN must be 15 characters")
    m = _GSTIN_RE.match(g)
    if not m:
        raise TaxError("GSTIN format is invalid (state code, PAN, entity number, 'Z', check digit)")
    if m.group(1) not in GST_STATE_CODES:
        raise TaxError(f"GSTIN has unknown state code '{m.group(1)}'")
    if gstin_checksum(g[:14]) != g[14]:
        raise TaxError("GSTIN checksum is wrong")
    return g


def validate_hsn_sac(code: str) -> str:
    """HSN/SAC must be exactly 4, 6 or 8 ASCII digits."""
    if not isinstance(code, str):
        raise TaxError("HSN/SAC must be a string")
    c = code.strip()
    if not _HSN_RE.match(c) or len(c) not in (4, 6, 8):
        raise TaxError(f"HSN/SAC '{code}' must be 4, 6 or 8 digits")
    return c


def strict_decimal(value: object, name: str) -> Decimal:
    """Decimal | str | int -> finite Decimal. float (inexact), bool, NaN/Infinity and garbage raise TaxError."""
    if isinstance(value, bool) or not isinstance(value, (Decimal, str, int)):
        raise TaxError(f"{name} must be a Decimal, str or int (not {type(value).__name__})")
    try:
        d = Decimal(value.strip() if isinstance(value, str) else value)
    except InvalidOperation:
        raise TaxError(f"{name} is not a number") from None
    if not d.is_finite():
        raise TaxError(f"{name} must be finite")
    return d


def iso_date(value: date | str | None, name: str) -> str | None:
    """date | 'YYYY-MM-DD' | None -> 'YYYY-MM-DD' | None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip()).isoformat()
        except ValueError:
            pass
    raise TaxError(f"{name} must be a date or an ISO 'YYYY-MM-DD' string")
