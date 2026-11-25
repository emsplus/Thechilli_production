"""Table QR codes and guest reviews (docs/TABLE_QR_REVIEWS.md).

Owner side (Bearer): QR links per table + a restaurant-wide one, regenerate, switches, the reviews list.
Public side (no login; the signed token in the URL is the capability, see services/table_qr.py): the view-only menu JSON, the
review form's header JSON and the review POST, plus the two page shells /m/{token} and /rv/{token} and their static files."""
import uuid
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, current_principal, require_feature, require_perm
from app.core.config import settings
from app.core.db import get_db
from app.models.core import DiningTable, Restaurant
from app.services import audit, business_type, outlets
from app.services import table_qr as svc

router = APIRouter(tags=["table-qr"])
qr_plan = Depends(require_feature("table_qr"))


def _ip(request: Request) -> str:
    return ((request.client.host if request.client else None) or "unknown")[:64]


# ------------------------------------------------------------------------------------------------ owner: QR codes
class QrSettingsIn(BaseModel):
    menu_enabled: bool | None = None
    reviews_enabled: bool | None = None
    google_review_url: str | None = Field(default=None, max_length=600)


def _settings_out(s) -> dict:
    return {"menu_enabled": bool(s.menu_enabled), "reviews_enabled": bool(s.reviews_enabled),
            "google_review_url": s.google_review_url}


@router.get("/table-qr", dependencies=[qr_plan])
def qr_overview(request: Request, outlet_id: uuid.UUID | None = None, p: Principal = Depends(require_perm(P.TABLES_MANAGE)),
                db: Session = Depends(get_db)):
    """Everything the Tables screen needs to print: the menu and review URL of every active table of the outlet and of the
    restaurant-wide codes. URLs carry signed tokens, never a raw table id."""
    r = db.get(Restaurant, p.restaurant_id)
    s = svc.get_settings(db, r.id)
    base = svc.base_url(request)
    tables = []
    if business_type.capabilities(business_type.stored(r))["tables"]:
        gens = svc.table_gens(db, r.id)
        q = select(DiningTable).where(DiningTable.restaurant_id == r.id, DiningTable.is_active,
                                      DiningTable.outlet_id.in_(outlets.scope(p, outlet_id, all_by_default=False)))
        for t in db.scalars(q):
            g = gens.get(t.id)
            tables.append({"table_id": str(t.id), "label": t.label, "area": t.area.value if hasattr(t.area, "value") else t.area,
                           "seats": t.seats, "gen": g.gen if g else 1,
                           "regenerated_at": g.rotated_at.isoformat() if g else None, **svc.urls(base, r.id, t.id, g.gen if g else 1)})
        tables.sort(key=lambda x: _natural(x["label"]))
    return {"restaurant_name": r.name, "base_url": base, **_settings_out(s),
            "general": {"gen": s.general_gen, **svc.urls(base, r.id, None, s.general_gen)}, "tables": tables}


def _natural(label: str):
    import re
    return [int(x) if x.isdigit() else x.lower() for x in re.split(r"(\d+)", label)]


@router.post("/table-qr/tables/{table_id}/regenerate", dependencies=[qr_plan])
def regenerate_table(table_id: uuid.UUID, request: Request, p: Principal = Depends(require_perm(P.TABLES_MANAGE)),
                     db: Session = Depends(get_db)):
    t = db.get(DiningTable, table_id)
    if t is None or t.restaurant_id != p.restaurant_id or not outlets.visible(p, t):
        raise HTTPException(404, "Table not found")
    gen = svc.regenerate_table(db, p.restaurant_id, t)
    audit.record(db, p, "table_qr.regenerate", "table", t.id, {"label": t.label, "gen": gen})
    db.commit()
    return {"table_id": str(t.id), "label": t.label, "gen": gen, **svc.urls(svc.base_url(request), p.restaurant_id, t.id, gen)}


@router.post("/table-qr/general/regenerate", dependencies=[qr_plan])
def regenerate_general(request: Request, p: Principal = Depends(require_perm(P.TABLES_MANAGE)), db: Session = Depends(get_db)):
    gen = svc.regenerate_general(db, p.restaurant_id)
    audit.record(db, p, "table_qr.regenerate", "restaurant", p.restaurant_id, {"general": True, "gen": gen})
    db.commit()
    return {"gen": gen, **svc.urls(svc.base_url(request), p.restaurant_id, None, gen)}


@router.put("/table-qr/settings")
def put_settings(data: QrSettingsIn, p: Principal = Depends(require_perm(P.SETTINGS_MANAGE)), db: Session = Depends(get_db)):
    s = svc.get_settings(db, p.restaurant_id, create=True)
    changes = {}
    if data.menu_enabled is not None:
        s.menu_enabled = changes["menu_enabled"] = data.menu_enabled
    if data.reviews_enabled is not None:
        s.reviews_enabled = changes["reviews_enabled"] = data.reviews_enabled
    if "google_review_url" in data.model_fields_set:
        s.google_review_url = changes["google_review_url"] = svc.clean_google_url(data.google_review_url)
    if changes:
        audit.record(db, p, "table_qr.settings", "restaurant", p.restaurant_id, changes)
    db.commit()
    return _settings_out(s)


@router.get("/table-qr/settings")
def get_settings(p: Principal = Depends(require_perm(P.SETTINGS_MANAGE, P.REPORTS_VIEW, P.TABLES_MANAGE)),
                 db: Session = Depends(get_db)):
    return _settings_out(svc.get_settings(db, p.restaurant_id))


# ------------------------------------------------------------------------------------------------ owner: reviews
class ReadIn(BaseModel):
    ids: list[uuid.UUID] | None = Field(default=None, max_length=500)  # None = every unread review


@router.get("/reviews")
def list_reviews(table: str | None = Query(default=None, max_length=40), rating: int | None = Query(default=None, ge=1, le=5),
                 min_rating: int | None = Query(default=None, ge=1, le=5), max_rating: int | None = Query(default=None, ge=1, le=5),
                 date_from: date | None = None, date_to: date | None = None, outlet_id: uuid.UUID | None = None,
                 limit: int = Query(default=50, ge=1, le=5000), offset: int = Query(default=0, ge=0),
                 p: Principal = Depends(require_perm(P.REPORTS_VIEW)), db: Session = Depends(get_db)):
    """Newest first, with count / average / 1-5 distribution / per-table averages over the same filter (dates are the
    restaurant's local days, inclusive)."""
    r = db.get(Restaurant, p.restaurant_id)
    conds = svc.review_filter(r.id, r.timezone, outlet_ids=outlets.scope(p, outlet_id, all_by_default=True), table=table,
                              rating=rating, min_rating=min_rating, max_rating=max_rating, date_from=date_from, date_to=date_to)
    return svc.list_reviews(db, r.id, conds, limit=limit, offset=offset)


@router.get("/reviews/summary")
def reviews_summary(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """For the bell: low ratings (1-2 stars) nobody has read yet. Every signed-in user may ask (the top bar of every screen does, also
    for a cashier, waiter or kitchen login): without reports.view the answer is `{"unread_low": 0}`, never a 403 (BREAK_UI_REPORT.md
    D27). The reviews themselves stay behind reports.view."""
    return {"unread_low": svc.unread_low(db, p.restaurant_id) if p.can(P.REPORTS_VIEW) else 0}


@router.post("/reviews/read")
def reviews_read(data: ReadIn, p: Principal = Depends(require_perm(P.REPORTS_VIEW)), db: Session = Depends(get_db)):
    n = svc.mark_read(db, p.restaurant_id, data.ids)
    return {"marked": n, "unread_low": svc.unread_low(db, p.restaurant_id)}


# ------------------------------------------------------------------------------------------------ public JSON
class ReviewIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=svc.REVIEW_COMMENT_MAX)
    name: str | None = Field(default=None, max_length=80)
    contact: str | None = Field(default=None, max_length=120)
    website: str | None = Field(default=None, max_length=300)  # honeypot: hidden from people, bots fill it


def _menu_limit(request: Request) -> None:
    if not svc.menu_limiter.allow(_ip(request), settings.table_qr_menu_per_minute):
        raise svc.QrError(429, "rate_limited", "Too many requests. Please wait a minute.", headers={"Retry-After": "60"})


def _resolve(db: Session, request: Request, token: str, kind: int) -> svc.Ctx:
    try:
        return svc.resolve(db, token, kind)
    except svc.QrError:
        svc.throttle_lookup_miss(_ip(request))  # guessing costs: 429 after a few misses
        raise


@router.get("/table-qr/public/menu/{token}")
def public_menu(token: str, request: Request, db: Session = Depends(get_db)):
    _menu_limit(request)
    ctx = _resolve(db, request, token, svc.KIND_MENU)
    body = dict(svc.menu_payload(db, ctx))
    body["table"] = {"label": ctx.table.label} if ctx.table is not None else None
    body["review_path"] = (f"/rv/{svc.make_token(svc.KIND_REVIEW, ctx.restaurant.id, ctx.parsed.table_id, ctx.parsed.gen)}"
                           if ctx.cfg.reviews_enabled else None)
    return JSONResponse(body, headers={"Cache-Control": "public, max-age=60", "X-Robots-Tag": "noindex, nofollow"})


@router.get("/table-qr/public/review/{token}")
def public_review_info(token: str, request: Request, db: Session = Depends(get_db)):
    _menu_limit(request)
    ctx = _resolve(db, request, token, svc.KIND_REVIEW)
    return {"restaurant": {"name": ctx.restaurant.name}, "table": {"label": ctx.table.label} if ctx.table is not None else None,
            "comment_max": svc.REVIEW_COMMENT_MAX}


@router.post("/table-qr/public/review/{token}", status_code=201)
def public_review_submit(token: str, data: ReviewIn, request: Request, db: Session = Depends(get_db)):
    ctx = _resolve(db, request, token, svc.KIND_REVIEW)
    return svc.submit_review(db, ctx, _ip(request), rating=data.rating, comment=data.comment, name=data.name,
                             contact=data.contact, honeypot=data.website)


# ------------------------------------------------------------------------------------------------ public pages (outside /api/v1)
PAGES = Path(__file__).resolve().parents[2] / "assets" / "table_qr"
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
PAGE_HEADERS = {"Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive",
                "Cache-Control": "public, max-age=300", "Permissions-Policy": "camera=(), microphone=(), geolocation=()"}
STATIC = {"tq.css": "text/css; charset=utf-8", "menu.js": "text/javascript; charset=utf-8",
          "review.js": "text/javascript; charset=utf-8", "common.js": "text/javascript; charset=utf-8",
          "favicon.svg": "image/svg+xml"}
pages = APIRouter(include_in_schema=False)


def _page(name: str) -> HTMLResponse:
    return HTMLResponse((PAGES / name).read_text(encoding="utf-8"), headers=PAGE_HEADERS)


# The shell is the same for every token; the script asks the API, which decides. `{token:path}` also takes an empty token (`/m/`) and a
# token with a slash in it (a truncated or mangled scan): they get the friendly "This QR code is not active" page, not a raw JSON 404
# (BREAK_UI_REPORT.md D12).
@pages.get("/m")
@pages.get("/m/{token:path}")
def menu_page(token: str = ""):
    return _page("menu.html")


@pages.get("/rv")
@pages.get("/rv/{token:path}")
def review_page(token: str = ""):
    return _page("review.html")


@pages.get("/qr-static/{name}")
def static_file(name: str):
    if name not in STATIC:
        raise HTTPException(404, "Not found")
    return FileResponse(PAGES / name, media_type=STATIC[name],
                        headers={**{k: v for k, v in PAGE_HEADERS.items() if k != "Cache-Control"}, "Cache-Control": "public, max-age=3600"})
