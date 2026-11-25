"""WhatsApp opt-out (STOP) / opt-in (START) keywords. An opted-out number receives no queued message except `essential`
templates (the delivery code of an order the customer already placed); see app/providers/templates.py."""
import string
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.models import WaConsent
from app.providers.base import normalize_number

_PUNCT = str.maketrans("", "", string.punctuation + "।॥…")
# Hindi words are INPUT keywords (always recognised, whatever the language flag); the replies below are English only.
# Whole-message match (case-insensitive, punctuation stripped), so "please stop calling the rider" does not opt anyone out.
STOP_WORDS = {"stop", "stop all", "stopall", "unsubscribe", "opt out", "optout", "रोको", "बंद", "बंद करो", "बंद करें"}
START_WORDS = {"start", "unstop", "subscribe", "opt in", "optin", "शुरू", "शुरू करो"}

OPT_OUT_REPLY = "You are unsubscribed and will get no more messages from us. Reply START to resume."
OPT_IN_REPLY = "You are subscribed again. Send 'menu' to order or 'status' to track an order."
STILL_OUT_REPLY = "You are unsubscribed. Reply START to receive messages again."


def keyword(text: str) -> str | None:
    # Strip punctuation only: \w would also strip Devanagari vowel signs (category Mc/Mn).
    t = " ".join(text.lower().translate(_PUNCT).split())
    if t in STOP_WORDS:
        return "stop"
    if t in START_WORDS:
        return "start"
    return None


def is_opted_out(db: Session, restaurant_id: str, number: str) -> bool:
    c = db.get(WaConsent, (restaurant_id, normalize_number(number)))
    return bool(c and c.opted_out)


def set_opt(db: Session, restaurant_id: str, number: str, opted_out: bool) -> None:
    key = (restaurant_id, normalize_number(number))
    c = db.get(WaConsent, key)
    if c is None:
        db.add(WaConsent(restaurant_id=key[0], wa_number=key[1], opted_out=opted_out, updated_at=datetime.now(UTC)))
    else:
        c.opted_out, c.updated_at = opted_out, datetime.now(UTC)
