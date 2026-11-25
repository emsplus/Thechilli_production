"""Per-restaurant public ordering link (docs/PUBLIC_ORDER_LINK.md): slug lifecycle, QR, opening hours, brand palette, abuse limits.

The slug is a capability: ~59 random bits from `secrets`, stored in plain text (the owner must be able to read the URL back) and
resolved before the tenant is known through the SECURITY DEFINER function resolve_public_link(), which answers only for an
ENABLED link. Disabled, rotated-away and never-existing slugs are indistinguishable from outside (same 404, same body)."""
import io
import math
import re
import secrets
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import segno
from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import AppError, NotFound
from app.core.security import keyed_hash
from app.core.tenancy import bind_tenant, tenant_session
from app.models import PublicLink
from app.providers.base import normalize_number
from app.services import ratelimit

SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no i, l, o, 0, 1: safe to read aloud and type from a poster
SLUG_LENGTH = 12
SLUG_RE = re.compile(r"^[a-z0-9]{8,32}$")
PUBLIC_TENANT = "_public"  # pseudo-tenant that owns the pre-tenant buckets (slug-miss throttle); real ids never start with "_"
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _now() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------------------------------------- link lifecycle
def new_slug() -> str:
    return "".join(secrets.choice(SLUG_ALPHABET) for _ in range(SLUG_LENGTH))


def public_url(slug: str) -> str:
    return f"{(settings.public_order_base_url or settings.public_base_url).rstrip('/')}/r/{slug}"


def get_link(db: Session, restaurant_id: str) -> PublicLink | None:
    return db.get(PublicLink, restaurant_id)


def _insert(db: Session, restaurant_id: str, brand_color: str | None) -> PublicLink:
    for _ in range(5):  # a slug collision (unique index) is astronomically unlikely; retry rather than fail
        link = PublicLink(restaurant_id=restaurant_id, slug=new_slug(), enabled=True, brand_color=brand_color)
        try:
            with db.begin_nested():
                db.add(link)
            return link
        except IntegrityError:
            db.expunge(link)
    raise AppError("could not allocate a link", code="slug_unavailable", status=503)


def ensure_link(db: Session, restaurant_id: str, brand_color: str | None = None) -> tuple[PublicLink, bool]:
    """Idempotent: the existing link (enabled or not, unchanged) or a new enabled one. (link, created)."""
    link = get_link(db, restaurant_id)
    if link:
        return link, False
    return _insert(db, restaurant_id, brand_color), True


def rotate(db: Session, link: PublicLink) -> PublicLink:
    """New slug; the old URL stops working at once. Does NOT re-enable a disabled link."""
    for _ in range(5):
        slug = new_slug()
        if slug != link.slug:
            try:
                with db.begin_nested():
                    link.slug, link.rotated_at = slug, _now()
                    db.flush()
                return link
            except IntegrityError:
                continue
    raise AppError("could not allocate a link", code="slug_unavailable", status=503)


def set_enabled(link: PublicLink, enabled: bool) -> PublicLink:
    if link.enabled != enabled:
        link.enabled = enabled
        link.disabled_at = None if enabled else _now()
    return link


def resolve_slug(db: Session, slug: str) -> str | None:
    """Restaurant id for an enabled link, else None. Safe on an unbound session (SECURITY DEFINER lookup)."""
    if not SLUG_RE.match(slug or ""):
        return None
    return db.scalar(select(func.resolve_public_link(slug)))


def qr_svg(url: str) -> str:
    """Standalone SVG of the QR code (error correction M, 4-module quiet zone, dark on white so it scans from any screen)."""
    buf = io.BytesIO()
    segno.make(url, error="m", micro=False).save(buf, kind="svg", scale=8, border=4, dark="#111820", light="#ffffff",
                                                 xmldecl=False, svgns=True, title="QR code of the ordering link",
                                                 desc=url)
    return buf.getvalue().decode("utf-8")


# ---------------------------------------------------------------------------------------------- opening hours
_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _in_window(hhmm: str, a: str, b: str) -> bool:
    return a <= hhmm < b or (b <= a and (hhmm >= a or hhmm < b))  # EXACTLY pos-service delivery.is_open (it judges only today's windows), so the page never says open when POS answers outside_hours


def _clock(hhmm: str) -> str:
    h, m = int(hhmm[:2]), int(hhmm[3:5])
    return f"{(h % 12) or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _windows(hours: dict, day: str) -> list[tuple[str, str]]:
    out = []
    for w in hours.get(day) or []:
        if isinstance(w, (list, tuple)) and len(w) >= 2 and re.fullmatch(r"\d\d:\d\d", str(w[0])) and re.fullmatch(r"\d\d:\d\d", str(w[1])):
            out.append((str(w[0]), str(w[1])))
    return out


def availability(cfg: dict, at: datetime | None = None) -> dict:
    """{open, reason, next_open} from POS config (`enabled`, `hours` {"mon":[["11:00","22:00"]]}, `timezone`). Missing or empty hours
    = always open; an unknown config (POS unreachable, {}) = open, because POS still rejects what it must. `next_open` is a
    plain English label ('today at 11:00 AM') or None."""
    if cfg.get("enabled") is False:
        return {"open": False, "reason": "disabled", "next_open": None}
    hours = cfg.get("hours")
    if not isinstance(hours, dict) or not hours:
        return {"open": True, "reason": None, "next_open": None}
    try:
        tz = ZoneInfo(str(cfg.get("timezone") or "Asia/Kolkata"))
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo("Asia/Kolkata")
    local = (at or _now()).astimezone(tz)
    day, hhmm = _DAYS[local.weekday()], local.strftime("%H:%M")
    if any(_in_window(hhmm, a, b) for a, b in _windows(hours, day)):
        return {"open": True, "reason": None, "next_open": None}
    for offset in range(8):
        d = local + timedelta(days=offset)
        key = _DAYS[d.weekday()]
        starts = sorted(a for a, _ in _windows(hours, key) if offset > 0 or a > hhmm)
        if starts:
            when = "today" if offset == 0 else "tomorrow" if offset == 1 else _DAY_NAMES[d.weekday()]
            return {"open": False, "reason": "hours", "next_open": f"{when} at {_clock(starts[0])}"}
    return {"open": False, "reason": "hours", "next_open": None}


# ---------------------------------------------------------------------------------------------- brand palette
def _rgb(c: str) -> tuple[float, float, float]:
    return tuple(int(c[i:i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]


def _hex(rgb) -> str:
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02x}" for v in rgb)


def _mix(a: str, b: str, t: float) -> str:
    """t=0 -> a, t=1 -> b."""
    return _hex(tuple(x + (y - x) * t for x, y in zip(_rgb(a), _rgb(b), strict=True)))


def _lum(c: str) -> float:
    def f(v):
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (f(v) for v in _rgb(c))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = sorted((_lum(a), _lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def _toward(c: str, target: str, surfaces: tuple[str, ...], need: float = 4.5) -> str:
    """Moves `c` toward `target` (black, for the light surfaces) until it reads on every surface at AA."""
    out = c
    for step in range(21):
        out = _mix(c, target, step / 20)
        if all(contrast(out, s) >= need for s in surfaces):
            return out
    return out


def valid_color(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    if not COLOR_RE.match(value):
        raise AppError("brand_color must look like #E50914", code="invalid_color", status=422)
    return value.lower()


def theme(color: str | None) -> dict | None:
    """CSS custom properties for the page (light only, owner decision 2026-11-01: docs/LIGHT_ONLY_STATUS.md), derived from the owner's
    brand colour and nudged until text in that colour reads at WCAG AA (4.5:1) on the card and canvas surfaces of the existing design
    tokens. None = the default look. The former dark palette is not emitted (see LIGHT_ONLY_STATUS.md for how it was derived)."""
    if not color:
        return None
    light = _toward(color, "#000000", ("#ffffff", "#f9fafb", "#f3f4f6"))
    return {
        "light": {"--primary": light, "--primary-hover": _mix(light, "#000000", 0.18), "--on-primary": "#ffffff", "--link": light,
                  "--primary-soft": _mix(light, "#ffffff", 0.88), "--primary-subtle": _mix(light, "#ffffff", 0.94), "--ring": light},
    }


# ---------------------------------------------------------------------------------------------- abuse protection
def client_ip(request: Request) -> str:
    hops = settings.trusted_proxy_hops
    if hops > 0:
        parts = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
        if len(parts) >= hops:
            return parts[-hops]  # the address the outermost trusted proxy saw; anything left of it is client-controlled
    return request.client.host if request.client else "unknown"


def throttle(db: Session, restaurant_id: str, key: str, capacity: float, refill: float) -> None:
    """Spends one token of the (tenant, key) bucket or raises 429 with Retry-After. Commits, so a request that fails later still
    paid for its attempt (a bot sending invalid orders is not refunded)."""
    wait = ratelimit.take(db, restaurant_id, key, capacity=capacity, refill_per_second=refill, now=_now())
    db.commit()
    if wait:
        raise AppError("too many requests, please wait a moment", code="rate_limited", status=429,
                       extra={"retry_after": math.ceil(wait)})


def throttle_miss(request: Request) -> None:
    """A slug that does not resolve costs the caller's IP one token from a small bucket: slug guessing is capped at ~10/minute."""
    s = tenant_session(PUBLIC_TENANT)
    try:
        throttle(s, PUBLIC_TENANT, f"miss:{keyed_hash('ip', client_ip(request))}", settings.public_miss_ip_capacity,
                 settings.public_miss_ip_refill_per_second)
    finally:
        s.close()


def resolve_or_404(db: Session, request: Request, slug: str) -> str:
    """slug -> restaurant id, binds the session to that tenant. Disabled/unknown/malformed all raise the same 404."""
    rid = resolve_slug(db, slug)
    if not rid:
        throttle_miss(request)
        raise NotFound("this ordering link is not active", code="link_not_found")
    bind_tenant(db, rid)
    return rid


def purge_stale_buckets(db: Session, restaurant_id: str, older_than: timedelta = timedelta(days=1)) -> int:
    """Public-link bucket rows are per visitor: drop the idle ones (a full bucket and an absent one behave the same). Also trims the
    pre-tenant slug-miss buckets (their own pseudo-tenant, so a second session)."""
    from sqlalchemy import delete

    from app.models import RateBucket

    def purge(s: Session, rid: str) -> int:
        r = s.execute(delete(RateBucket).where(RateBucket.restaurant_id == rid, RateBucket.updated_at < _now() - older_than,
                                               RateBucket.key.regexp_match("^(pg|pi|pp|miss):")))
        s.commit()
        return r.rowcount or 0
    n = purge(db, restaurant_id)
    pub = tenant_session(PUBLIC_TENANT)
    try:
        return n + purge(pub, PUBLIC_TENANT)
    finally:
        pub.close()


def valid_phone(raw: str) -> str | None:
    """WhatsApp-style digits-only international number, or None. Bare 10-digit numbers are Indian mobiles (6-9 first digit)."""
    d = normalize_number(raw)
    cc = settings.whatsapp_default_country_code
    if cc == "91" and d.startswith("91") and len(d) == 12:
        return d if d[2] in "6789" else None
    return d if 8 <= len(d) <= 15 and not d.startswith("0") and len(set(d)) > 2 else None
