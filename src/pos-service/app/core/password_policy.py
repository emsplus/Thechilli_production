"""Password policy for tenant users (security review 2026-10-31, finding 7: "password12", "1234567890" and "aaaaaaaaaa"
were accepted). Checked when a password is SET (register, staff create, invite accept, change, reset by email, owner
reset); existing passwords keep working and login never checks it.

Rules: 10 to 128 characters; not all digits; at least 4 different characters; not a straight keyboard / alphabet run;
not one of the 10 000 most common passwords (app/assets/common_passwords.txt, SecLists "10k-most-common", bundled, no
network call), also after stripping leading / trailing digits and symbols ("password12" -> "password"); and it must not
contain the user's email name or a part of their name (4+ characters).
"""
import re
from functools import cache
from pathlib import Path

MIN_LENGTH, MAX_LENGTH = 10, 128
_LIST = Path(__file__).resolve().parent.parent / "assets" / "common_passwords.txt"
_RUNS = ("abcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm", "01234567890", "09876543210",
         "zyxwvutsrqponmlkjihgfedcba", "mnbvcxzlkjhgfdsapoiuytrewq")
_EDGE = re.compile(r"^[\W\d_]+|[\W\d_]+$")


@cache
def common_passwords() -> frozenset[str]:
    return frozenset(w.strip().lower() for w in _LIST.read_text(encoding="utf-8").splitlines() if w.strip())


def problem(password: str, email: str | None = None, name: str | None = None) -> str | None:
    """None when acceptable, else a message that can be shown to the user (never echoes the password)."""
    pw = password or ""
    if len(pw) < MIN_LENGTH:
        return f"Use at least {MIN_LENGTH} characters."
    if len(pw) > MAX_LENGTH:
        return f"Use at most {MAX_LENGTH} characters."
    low = pw.lower()
    if pw.isdigit():
        return "A password cannot be only numbers."
    if len(set(low)) < 4:
        return "Use more different characters."
    if any(low in run for run in _RUNS):
        return "A keyboard or alphabet sequence is too easy to guess."
    common = common_passwords()
    base = _EDGE.sub("", low)
    if low in common or (len(base) >= 4 and base in common):
        return "This password is too common. Choose something less predictable."
    parts = set()
    if email:
        local = email.split("@", 1)[0].lower()
        parts.add(local)
        parts.update(p for p in re.split(r"[._+\-]", local))
    if name:
        parts.update(re.split(r"\s+", name.lower()))
    if any(len(p) >= 4 and p in low for p in parts):
        return "A password cannot contain your name or email."
    return None


def validate(password: str, email: str | None = None, name: str | None = None) -> str:
    """For pydantic validators: raises ValueError (422) with the message."""
    msg = problem(password, email, name)
    if msg:
        raise ValueError(msg)
    return password


def enforce(password: str, email: str | None = None, name: str | None = None) -> None:
    """For services that know the user only after loading it: 422 with the message as `detail`."""
    msg = problem(password, email, name)
    if msg:
        from fastapi import HTTPException
        raise HTTPException(422, msg)
