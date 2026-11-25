"""Table QR codes (view-only menu, guest review form) and the reviews they collect (docs/TABLE_QR_REVIEWS.md).

Token = base64url( head(1) | restaurant_id(16) | [table_id(16)] | gen(2, big-endian) | mac(12) ), mac = HMAC-SHA256(key,
payload)[:12]. head = 0x10 | kind (1 menu, 2 review) | 0x04 for the restaurant-wide ("general") code, which has no table id.
The key is TABLE_QR_SECRET or, when unset, derived from JWT_SECRET with its own purpose string, so a QR token can never be
confused with (or forged from) any other secret use. 96 bits of MAC behind per-IP limits: forging is out of reach.

The token carries the tenant: the public endpoints verify it, bind the session to THAT restaurant (RLS) and only then read.
"Regenerate" bumps the table's (or the general) generation; every older token then fails exactly like a forged one.
Revoked, forged, malformed, switched-off and not-entitled codes are indistinguishable: one 404 `qr_inactive`.
"""
import base64
import hashlib
import hmac
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time as dtime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.tenancy import bind_tenant
from app.models.core import Category, DiningTable, MenuItem, Outlet, Restaurant
from app.models.table_qr import REVIEW_COMMENT_MAX, TableQrLink, TableQrSettings, TableReview
from app.services import abuse, business_type, entitlements
from app.services.order_rules import is_sold_out
from app.services.receipt_links import TokenBucket

KIND_MENU, KIND_REVIEW = 1, 2
FEATURE_CODE = "table_qr"  # platform-core feature code (pos deps.FEATURES["table_qr"]); absent from a plan = allowed
_HEAD, _GENERAL = 0x10, 0x04
_PURPOSE = b"pos-table-qr-v1"
_MAC = 12
_TOKEN_RX = re.compile(r"[A-Za-z0-9_-]{40,64}")
LOW_RATING = 2  # ratings at or below this count in the owner's bell until read


class QrError(HTTPException):
    def __init__(self, status: int, code: str, message: str, headers: dict | None = None):
        super().__init__(status, message, headers=headers)
        self.code = code


def inactive() -> QrError:
    return QrError(404, "qr_inactive", "This QR code is not active. Please ask the staff for help.")


# ------------------------------------------------------------------------------------------------ tokens
def _key() -> bytes:
    root = settings.table_qr_secret or settings.jwt_secret
    return hmac.new(root.encode(), _PURPOSE, hashlib.sha256).digest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def make_token(kind: int, restaurant_id: uuid.UUID, table_id: uuid.UUID | None, gen: int) -> str:
    if kind not in (KIND_MENU, KIND_REVIEW) or not 1 <= gen <= 0xFFFF:
        raise ValueError("bad kind or generation")
    head = _HEAD | kind | (_GENERAL if table_id is None else 0)
    payload = bytes([head]) + restaurant_id.bytes + (table_id.bytes if table_id else b"") + gen.to_bytes(2, "big")
    return _b64(payload + hmac.new(_key(), payload, hashlib.sha256).digest()[:_MAC])


@dataclass(frozen=True)
class Parsed:
    kind: int
    restaurant_id: uuid.UUID
    table_id: uuid.UUID | None
    gen: int


def verify(token: str) -> Parsed | None:
    """The token's content when the MAC is genuine, else None. Does NOT check the generation (see resolve)."""
    if not _TOKEN_RX.fullmatch(token or ""):
        return None
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
    except (ValueError, TypeError):
        return None
    if len(raw) not in (1 + 16 + 2 + _MAC, 1 + 32 + 2 + _MAC):
        return None
    payload, mac = raw[:-_MAC], raw[-_MAC:]
    if not hmac.compare_digest(mac, hmac.new(_key(), payload, hashlib.sha256).digest()[:_MAC]):
        return None
    head = payload[0]
    kind, general = head & 0x03, bool(head & _GENERAL)
    if head & 0xF0 != _HEAD or kind not in (KIND_MENU, KIND_REVIEW) or general != (len(payload) == 19):
        return None
    rid = uuid.UUID(bytes=payload[1:17])
    tid = None if general else uuid.UUID(bytes=payload[17:33])
    return Parsed(kind, rid, tid, int.from_bytes(payload[-2:], "big"))


def base_url(request=None) -> str:
    b = settings.table_qr_base_url.strip() or settings.public_base_url.strip()
    if not b and request is not None:
        b = str(request.base_url)
    return b.rstrip("/")


def urls(base: str, restaurant_id: uuid.UUID, table_id: uuid.UUID | None, gen: int) -> dict:
    return {"menu_url": f"{base}/m/{make_token(KIND_MENU, restaurant_id, table_id, gen)}",
            "review_url": f"{base}/rv/{make_token(KIND_REVIEW, restaurant_id, table_id, gen)}"}


# ------------------------------------------------------------------------------------------------ settings / generations
def get_settings(db: Session, rid: uuid.UUID, *, create: bool = False) -> TableQrSettings:
    s = db.get(TableQrSettings, rid)
    if s is None:
        s = TableQrSettings(restaurant_id=rid, menu_enabled=True, reviews_enabled=True, general_gen=1)
        if create:
            db.add(s)
            db.flush()
    return s


def table_gens(db: Session, rid: uuid.UUID) -> dict[uuid.UUID, TableQrLink]:
    return {link.table_id: link for link in db.scalars(select(TableQrLink).where(TableQrLink.restaurant_id == rid))}


def regenerate_table(db: Session, rid: uuid.UUID, table: DiningTable) -> int:
    link = db.get(TableQrLink, table.id, with_for_update=True)
    if link is None:
        link = TableQrLink(table_id=table.id, restaurant_id=rid, gen=2, rotated_at=datetime.now(timezone.utc))
        db.add(link)
    else:
        link.gen = link.gen + 1 if link.gen < 0xFFFF else 1  # wraps after 65,534 regenerations of one table
        link.rotated_at = datetime.now(timezone.utc)
    db.flush()
    return link.gen


def regenerate_general(db: Session, rid: uuid.UUID) -> int:
    s = get_settings(db, rid, create=True)
    s.general_gen = s.general_gen + 1 if s.general_gen < 0xFFFF else 1
    db.flush()
    return s.general_gen


GOOGLE_HOSTS = ("google.com", "g.page", "goo.gl", "google.co.in")


def clean_google_url(v: str | None) -> str | None:
    """'' / None clears. Only https links on Google hosts (a review link, not an open redirect for anything else)."""
    v = (v or "").strip()
    if not v:
        return None
    m = re.fullmatch(r"https://([A-Za-z0-9.-]+)(/[^\s<>\"']*)?", v)
    host = m.group(1).lower() if m else ""
    if not m or len(v) > 500 or not any(host == h or host.endswith("." + h) for h in GOOGLE_HOSTS):
        raise QrError(422, "invalid_google_review_url",
                      "Use the https link Google gives you for reviews (g.page/r/..., search.google.com/local/writereview?..., maps.app.goo.gl/...).")
    return v


# ------------------------------------------------------------------------------------------------ public resolution
@dataclass
class Ctx:
    restaurant: Restaurant
    table: DiningTable | None
    cfg: TableQrSettings
    parsed: Parsed

    @property
    def qr_key(self) -> str:
        return self.table.id.hex if self.table is not None else "g" + self.restaurant.id.hex


def entitled(rid: uuid.UUID) -> bool:
    e = entitlements.current(rid)  # None: ENTITLEMENTS_ENFORCE=off
    if e is None:
        return True
    return not e.suspended and e.feature_enabled(FEATURE_CODE)


def resolve(db: Session, token: str, kind: int) -> Ctx:
    """Verify, bind the tenant from the token, check generation / table / switches / plan. Any failure: inactive()."""
    p = verify(token)
    if p is None or p.kind != kind:
        raise inactive()
    bind_tenant(db, p.restaurant_id)  # before anything is read: RLS shows this tenant only
    r = db.get(Restaurant, p.restaurant_id)
    if r is None:
        raise inactive()
    cfg = get_settings(db, r.id)
    table = None
    if p.table_id is None:
        if p.gen != cfg.general_gen:
            raise inactive()
    else:
        table = db.get(DiningTable, p.table_id)
        if table is None or table.restaurant_id != r.id or not table.is_active:
            raise inactive()
        link = db.get(TableQrLink, table.id)
        if p.gen != (link.gen if link else 1):
            raise inactive()
        if not business_type.capabilities(business_type.stored(r))["tables"]:
            raise inactive()
    if (kind == KIND_MENU and not cfg.menu_enabled) or (kind == KIND_REVIEW and not cfg.reviews_enabled):
        raise inactive()
    if not entitled(r.id):
        raise inactive()
    return Ctx(r, table, cfg, p)


# ------------------------------------------------------------------------------------------------ public menu
def _paise(x: Decimal) -> int:
    return int((Decimal(x) * 100).quantize(Decimal(1)))


_menu_cache: dict[tuple, tuple[float, dict]] = {}
_menu_lock = threading.Lock()


def clear_menu_cache() -> None:
    with _menu_lock:
        _menu_cache.clear()


def _outlet(db: Session, ctx: Ctx) -> Outlet | None:
    if ctx.table is not None:
        return db.get(Outlet, ctx.table.outlet_id)
    return db.scalar(select(Outlet).where(Outlet.restaurant_id == ctx.restaurant.id).order_by(Outlet.created_at).limit(1))


def menu_payload(db: Session, ctx: Ctx) -> dict:
    """The view-only menu: active categories and dishes, sold-out today flagged, prices in paise (INR), no ids of anything
    but categories (for the jump list). Cached per restaurant + outlet for TABLE_QR_MENU_CACHE_SECONDS."""
    r = ctx.restaurant
    outlet = _outlet(db, ctx)
    key = (r.id, outlet.id if outlet else None)
    now = time.monotonic()
    with _menu_lock:
        hit = _menu_cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    today = datetime.now(ZoneInfo(r.timezone or "Asia/Kolkata")).date()
    cats = db.scalars(select(Category).where(Category.restaurant_id == r.id, Category.is_active)
                      .order_by(Category.sort_order, Category.name)).all()
    rank = {c.id: i for i, c in enumerate(cats)}
    items = db.scalars(select(MenuItem).where(MenuItem.restaurant_id == r.id, MenuItem.is_active,
                                              MenuItem.category_id.in_(list(rank) or [uuid.uuid4()]))).all()
    items.sort(key=lambda i: (rank[i.category_id], i.name.lower()))
    out = []
    for i in items:
        variants = [{"name": v.name, "price": _paise(i.price + v.price_delta)}
                    for v in sorted(i.variants, key=lambda v: (v.price_delta, v.name)) if v.is_active]
        out.append({"category": str(i.category_id), "name": i.name, "description": i.description or "",
                    "food_type": i.food_type, "price": _paise(i.price), "variants": variants,
                    "image": i.thumb_url or i.image_url, "sold_out": is_sold_out(i, today)})
    used = {i["category"] for i in out}
    inclusive = outlet.prices_include_tax if outlet is not None else r.prices_include_tax
    registered = outlet.vat_registered if outlet is not None else r.vat_registered
    body = {"restaurant": {"name": r.name},
            "categories": [{"id": str(c.id), "name": c.name} for c in cats if str(c.id) in used],
            "items": out, "currency": "INR",
            "tax_note": ("Prices include GST." if inclusive else "GST extra as applicable.") if registered else None}
    with _menu_lock:
        if len(_menu_cache) > 2000:
            _menu_cache.clear()
        _menu_cache[key] = (now + max(0, settings.table_qr_menu_cache_seconds), body)
    return body


menu_limiter = TokenBucket()


# ------------------------------------------------------------------------------------------------ reviews: cleaning
_CTRL = re.compile(r"[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]")
_URL = re.compile(r"(?i)\b(?:https?://|ftp://|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|in|net|org|io|co|info|biz|xyz|me|ly|app|link|site|online|shop|top|ru|cn)\b(?:/\S*)?")
_EMAILISH = re.compile(r"\S+@\S+\.\S+")
# A short list, masked whole-word (English and common romanised Hindi). The point is to keep the owner's list readable, not to judge.
_PROFANE = ("fuck", "fucking", "fucker", "shit", "bitch", "bastard", "asshole", "cunt", "dick", "motherfucker",
            "madarchod", "maderchod", "bhenchod", "behenchod", "bhanchod", "chutiya", "chutiye", "gandu", "bhosdike", "bhosadike",
            "harami", "haramkhor", "randi", "kutta", "kamina", "kamine", "saala", "saale")
_PROFANE_RX = re.compile(r"(?i)\b(" + "|".join(_PROFANE) + r")\b")


def clean_text(v: str | None, limit: int, *, strip_contacts: bool = False) -> str | None:
    if v is None:
        return None
    t = _CTRL.sub("", str(v))
    t = _URL.sub("", t)
    if strip_contacts:
        t = _EMAILISH.sub("", t)
    t = _PROFANE_RX.sub(lambda m: m.group(0)[0] + "*" * (len(m.group(0)) - 1), t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\s*\n\s*(\n\s*)+", "\n\n", t).strip()  # at most one blank line in a row
    return t[:limit] or None


def clean_name(v: str | None) -> str | None:
    t = clean_text(v, 80, strip_contacts=True)
    if not t:
        return None
    t = re.sub(r"[^\w .'\-\u0900-\u097F]", "", t.replace("\n", " ")).strip()  # letters (Latin, Devanagari), space . ' -
    t = re.sub(r"\d", "", t).strip()
    return t[:80] or None


def clean_contact(v: str | None) -> str | None:
    """'' -> None. An e-mail (lower case) or an Indian mobile number as +91XXXXXXXXXX; anything else is 422."""
    t = (v or "").strip()
    if not t:
        return None
    if "@" in t:
        t = t.lower()
        if len(t) <= 120 and re.fullmatch(r"[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}", t):
            return t
    else:
        d = re.sub(r"[\s()-]", "", t)
        d = d[1:] if d.startswith("+") else d
        if d.startswith("91") and len(d) == 12:
            d = d[2:]
        elif d.startswith("0") and len(d) == 11:
            d = d[1:]
        if re.fullmatch(r"[6-9]\d{9}", d):
            return "+91" + d
    raise QrError(422, "invalid_contact", "Enter a 10-digit mobile number or an email address, or leave it empty.")


# ------------------------------------------------------------------------------------------------ reviews: submit
def _hk(*parts: str) -> str:
    """Keyed hash for abuse counter keys: no raw IP address is ever stored."""
    return hmac.new(_key(), "|".join(parts).encode(), hashlib.sha256).hexdigest()[:24]


def throttle_lookup_miss(ip: str) -> None:
    """Invalid / inactive review tokens per IP: after review_lookup_per_ip_per_minute, 429 for the rest of the minute."""
    n = abuse.hit("tqr:miss:" + _hk("ip", ip), window=timedelta(minutes=1),
                  limit=settings.review_lookup_per_ip_per_minute + 1)
    if n > settings.review_lookup_per_ip_per_minute:
        raise QrError(429, "rate_limited", "Too many tries. Please wait a minute.", headers={"Retry-After": "60"})


def submit_review(db: Session, ctx: Ctx, ip: str, *, rating: int, comment: str | None, name: str | None,
                  contact: str | None, honeypot: str | None) -> dict:
    ipk = _hk("ip", ip)
    try:
        abuse.throttle([("tqr:rv:ipt:" + ipk + ":" + ctx.qr_key[:33], settings.review_per_ip_table_per_hour),
                        ("tqr:rv:ip:" + ipk, settings.review_per_ip_per_hour),
                        ("tqr:rv:qr:" + ctx.qr_key[:33], settings.review_per_table_per_hour)],
                       window=timedelta(hours=1), what="reviews")
    except HTTPException as e:
        raise QrError(429, "rate_limited", "Thank you! We already have your review. Please try again later.",
                      headers=e.headers) from None
    thanks = {"ok": True, "google_review_url": ctx.cfg.google_review_url if rating == 5 else None}
    if (honeypot or "").strip():  # a bot filled the hidden field: same answer, nothing stored
        return thanks
    c = clean_text(comment, REVIEW_COMMENT_MAX)
    n = clean_name(name)
    k = clean_contact(contact)
    dup = "tqr:rv:dup:" + _hk(ipk, ctx.qr_key, str(rating), (c or "").lower())
    if abuse.hit(dup, window=timedelta(hours=1), limit=10**6) > 1:  # the same review again (double tap, resend): stored once
        return thanks
    t = ctx.table
    db.add(TableReview(restaurant_id=ctx.restaurant.id, outlet_id=t.outlet_id if t is not None else None,
                       table_id=t.id if t is not None else None, table_label=t.label if t is not None else None,
                       rating=rating, comment=c, guest_name=n, guest_contact=k))
    db.commit()
    return thanks


# ------------------------------------------------------------------------------------------------ reviews: owner side
def _local_range(tz: str, d_from: date | None, d_to: date | None):
    z = ZoneInfo(tz or "Asia/Kolkata")
    lo = datetime.combine(d_from, dtime.min, z) if d_from else None
    hi = datetime.combine(d_to + timedelta(days=1), dtime.min, z) if d_to else None
    return lo, hi


def review_filter(rid: uuid.UUID, tz: str, *, outlet_ids: list[uuid.UUID] | None, table: str | None,
                  rating: int | None, min_rating: int | None, max_rating: int | None,
                  date_from: date | None, date_to: date | None) -> list:
    conds = [TableReview.restaurant_id == rid]
    if outlet_ids is not None:
        conds.append(or_(TableReview.outlet_id.in_(outlet_ids), TableReview.outlet_id.is_(None)))
    if table == "general":
        conds.append(TableReview.table_id.is_(None))
    elif table:
        try:
            conds.append(TableReview.table_id == uuid.UUID(table))
        except ValueError:
            raise QrError(422, "invalid_table", "Unknown table filter") from None
    if rating is not None:
        conds.append(TableReview.rating == rating)
    if min_rating is not None:
        conds.append(TableReview.rating >= min_rating)
    if max_rating is not None:
        conds.append(TableReview.rating <= max_rating)
    lo, hi = _local_range(tz, date_from, date_to)
    if lo is not None:
        conds.append(TableReview.created_at >= lo)
    if hi is not None:
        conds.append(TableReview.created_at < hi)
    return conds


def review_out(rv: TableReview) -> dict:
    return {"id": str(rv.id), "created_at": rv.created_at.isoformat() if rv.created_at else None, "rating": rv.rating,
            "comment": rv.comment, "guest_name": rv.guest_name, "guest_contact": rv.guest_contact,
            "table_id": str(rv.table_id) if rv.table_id else None, "table_label": rv.table_label,
            "read": rv.read_at is not None}


def list_reviews(db: Session, rid: uuid.UUID, conds: list, *, limit: int, offset: int) -> dict:
    where = and_(*conds)
    rows = db.scalars(select(TableReview).where(where).order_by(TableReview.created_at.desc(), TableReview.id.desc())
                      .limit(limit).offset(offset)).all()
    count, avg = db.execute(select(func.count(), func.avg(TableReview.rating)).where(where)).one()
    dist = dict(db.execute(select(TableReview.rating, func.count()).where(where).group_by(TableReview.rating)).all())
    per = db.execute(select(TableReview.table_id, func.max(TableReview.table_label), func.count(), func.avg(TableReview.rating))
                     .where(where).group_by(TableReview.table_id)).all()
    labels = {t.id: t.label for t in db.scalars(select(DiningTable).where(DiningTable.restaurant_id == rid))}
    per_table = sorted(({"table_id": str(tid) if tid else None, "table_label": (labels.get(tid) or lbl) if tid else None,
                         "count": n, "average": round(float(a), 2)} for tid, lbl, n, a in per),
                       key=lambda x: (x["table_label"] is None, (x["table_label"] or "").lower()))
    items = [review_out(r) for r in rows]
    for it in items:  # show the table's current name (renamed tables), falling back to the label it had then
        if it["table_id"]:
            it["table_label"] = labels.get(uuid.UUID(it["table_id"])) or it["table_label"]
    return {"items": items, "total": int(count), "average": round(float(avg), 2) if avg is not None else None,
            "distribution": {str(k): int(dist.get(k, 0)) for k in range(1, 6)}, "per_table": per_table,
            "unread_low": unread_low(db, rid)}


def unread_low(db: Session, rid: uuid.UUID) -> int:
    return int(db.scalar(select(func.count()).select_from(TableReview).where(
        TableReview.restaurant_id == rid, TableReview.rating <= LOW_RATING, TableReview.read_at.is_(None))) or 0)


def mark_read(db: Session, rid: uuid.UUID, ids: list[uuid.UUID] | None) -> int:
    q = select(TableReview).where(TableReview.restaurant_id == rid, TableReview.read_at.is_(None))
    if ids is not None:
        q = q.where(TableReview.id.in_(ids or [uuid.uuid4()]))
    now = datetime.now(timezone.utc)
    rows = db.scalars(q).all()
    for r in rows:
        r.read_at = now
    db.commit()
    return len(rows)
