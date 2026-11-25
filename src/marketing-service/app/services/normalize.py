import re

from app.core.config import settings


def normalize_phone(raw: str | None) -> str | None:
    """Canonical E.164-like form `+<digits>` so formatting differences do not hide duplicates.
    '+91 98765 00123', '0091 98765-00123', '098765 00123' (national, leading 0) and '98765 00123' (bare 10-digit
    national number) all map to '+919876500123' with the default country code 91. Raises ValueError when the result is
    not 7..15 digits."""
    if raw is None or not raw.strip():
        return None
    s = raw.strip()
    digits = re.sub(r"\D", "", s)
    if s.startswith("+"):
        pass
    elif digits.startswith("00"):
        digits = digits[2:]
    elif digits.startswith("0"):
        digits = settings.default_country_code + digits.lstrip("0")
    elif len(digits) == 10:
        digits = settings.default_country_code + digits
    if not 7 <= len(digits) <= 15:
        raise ValueError("phone number must have 7 to 15 digits")
    return "+" + digits


def normalize_email(raw: str | None) -> str | None:
    """Lowercase + trim; for gmail/googlemail also drop dots and `+tag` in the local part."""
    if raw is None or not raw.strip():
        return None
    local, _, domain = raw.strip().lower().rpartition("@")
    if not local or not domain:
        raise ValueError("invalid email")
    if domain in ("gmail.com", "googlemail.com"):
        local = local.split("+", 1)[0].replace(".", "")
        domain = "gmail.com"
    return f"{local}@{domain}"
