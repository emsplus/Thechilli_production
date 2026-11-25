"""Testing-phase wake-word samples (docs/VOICE_WAKE_SAMPLES.md): TEXT ONLY, per restaurant, kept 30 days.

`clean_heard` is the only thing that ever decides what text is stored: NFKC, lower case, whitespace collapsed, every digit
dropped, every token that contains '@' or looks like a URL / domain dropped, cut to 120 characters. `variants` are the strings
the restaurant's own testers got recognised as a command at least twice in the last 30 days (shown to the app as extra wake
variants). Everything runs on the caller's tenant-bound session, so Row Level Security keeps other restaurants out."""
import re
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models.voice_wake import VoiceWakeSample

RETENTION_DAYS = 30
PURGE_BATCH = 500  # rows deleted per write call: cheap, bounded; a backlog drains over the next calls
VARIANT_MIN_HITS = 2
VARIANT_MAX_COUNT = 20
VARIANT_MAX_TOKENS = 3
VARIANT_MAX_LEN = 30
HEARD_MAX = 120
DEVICE_MAX = 64

_WS = re.compile(r"\s+")
# a token that is (or contains) a link or a bare domain: scheme, www., or something.tld[/...]
_URL = re.compile(r"://|^www\.|[a-z0-9-]+\.[a-z]{2,}(?:[/:?#]|$)", re.I)
# letters only: Latin (with accents, without x and division signs) and Devanagari letters and vowel signs (no digits, no danda)
_LETTERS = "a-zÀ-ÖØ-öø-ɏऀ-ॣॱ-ॿ"
_TOKEN = re.compile(rf"^[{_LETTERS}]+$")


def _drop_private_tokens(text: str) -> str:
    return " ".join(t for t in _WS.split(text) if t and "@" not in t and not _URL.search(t))


def clean_heard(raw: str) -> str:
    """The text that is stored for what the app heard ('' = nothing worth keeping, the sample is ignored)."""
    t = unicodedata.normalize("NFKC", raw).lower()
    t = "".join(" " if ch.isspace() or unicodedata.category(ch) in ("Cc", "Cf") else ch for ch in t)
    t = _drop_private_tokens(t)  # before the digits go, so "name1@x.com" is still seen as an address
    t = "".join(ch for ch in t if unicodedata.category(ch) != "Nd")  # every script's digits
    return _WS.sub(" ", t).strip()[:HEARD_MAX].strip()


def clean_device(raw: str) -> str:
    """A device label ('Pixel 7 test phone'): whitespace tidied, no address / URL tokens, at most 64 characters."""
    t = unicodedata.normalize("NFKC", raw)
    t = "".join(" " if ch.isspace() or unicodedata.category(ch) in ("Cc", "Cf") else ch for ch in t)
    return _drop_private_tokens(t)[:DEVICE_MAX].strip()


def _cutoff(now: datetime | None = None) -> datetime:
    return (now or datetime.now(timezone.utc)) - timedelta(days=RETENTION_DAYS)


def purge_old(db: Session, restaurant_id: uuid.UUID, now: datetime | None = None) -> int:
    """Deletes up to PURGE_BATCH of this restaurant's samples older than 30 days (no scheduler: called while writing)."""
    old = (select(VoiceWakeSample.id)
           .where(VoiceWakeSample.restaurant_id == restaurant_id, VoiceWakeSample.created_at < _cutoff(now))
           .limit(PURGE_BATCH))
    return db.execute(delete(VoiceWakeSample).where(VoiceWakeSample.id.in_(old))).rowcount


def store(db: Session, restaurant_id: uuid.UUID, user_id: uuid.UUID, samples: list[dict]) -> int:
    """Adds the samples that are not empty after cleaning; returns how many were kept. Does not commit."""
    purge_old(db, restaurant_id)
    kept = 0
    for s in samples:
        heard = clean_heard(s["heard"])
        if not heard:
            continue
        db.add(VoiceWakeSample(restaurant_id=restaurant_id, user_id=user_id, device=clean_device(s["device"]), heard=heard,
                               matched=bool(s["matched"]), kind=s["kind"]))
        kept += 1
    return kept


def variants(db: Session, restaurant_id: uuid.UUID, now: datetime | None = None) -> list[str]:
    """Distinct `heard` strings matched as a command at least twice in the last 30 days, 1-3 tokens, <= 30 characters, letters
    (Latin or Devanagari) and spaces only; most frequent first (then alphabetical), at most 20."""
    n = func.count()
    rows = db.execute(
        select(VoiceWakeSample.heard, n)
        .where(VoiceWakeSample.restaurant_id == restaurant_id, VoiceWakeSample.matched.is_(True),
               VoiceWakeSample.kind == "command", VoiceWakeSample.created_at >= _cutoff(now),
               func.char_length(VoiceWakeSample.heard) <= VARIANT_MAX_LEN)
        .group_by(VoiceWakeSample.heard).having(n >= VARIANT_MIN_HITS)
        .order_by(n.desc()).limit(500)).all()  # 500 candidates, the token rules below pick the 20
    rows.sort(key=lambda r: (-r[1], r[0]))  # ties alphabetical by code point (not by the database's collation)
    out: list[str] = []
    for heard, _count in rows:
        toks = heard.split(" ")
        if 1 <= len(toks) <= VARIANT_MAX_TOKENS and all(_TOKEN.match(t) for t in toks):
            out.append(heard)
            if len(out) == VARIANT_MAX_COUNT:
                break
    return out
