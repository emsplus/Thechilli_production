"""Customer ordering page, tracking page and rider screen: static HTML shells + small same-origin scripts. No framework, no inline script or
style (strict CSP), nothing server-rendered into the page: the shell is identical for every token and the scripts call the
existing JSON endpoints with the signed link token taken from the URL path. The token is the only credential in the URL;
pages are never cached and send no referrer."""
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from starlette.types import Receive, Scope, Send

from app.core.config import settings
from app.core.db import get_db
from app.core.errors import AppError
from app.services import publiclink

STATIC = Path(__file__).parent / "static"

CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
HEADERS = {
    "Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Permissions-Policy": "geolocation=(self)",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
}
router = APIRouter()


def _page(name: str) -> HTMLResponse:
    html = (STATIC / name).read_text(encoding="utf-8")
    # The only server-side substitution: the language flag (English only unless DELIVERY_ENABLE_LANGUAGES=1). Never the token.
    html = html.replace("{{LANGUAGES}}", "1" if settings.delivery_enable_languages else "0")
    return HTMLResponse(html, headers=HEADERS)


@router.get("/menu/{token}", include_in_schema=False)
def menu_page(token: str):  # same: the script calls GET/POST /api/v1/public/menu/{token}
    return _page("menu.html")


@router.get("/r/{slug}", include_in_schema=False)
def public_order_page(slug: str, request: Request, db: Session = Depends(get_db)):
    """The restaurant's public ordering page (same shell as /menu/{token}; its script sees the /r/ path and calls
    /api/v1/public/r/{slug}). A disabled, rotated-away, unknown or malformed slug gets ONE identical 404 page: nothing to index."""
    try:
        publiclink.resolve_or_404(db, request, slug)
    except AppError as e:
        r = _page("link-off.html")
        r.status_code = e.status if e.status == 429 else 404
        if "retry_after" in e.extra:
            r.headers["Retry-After"] = str(e.extra["retry_after"])
        return r
    return _page("menu.html")


@router.get("/track/{token}", include_in_schema=False)
def track_page(token: str):  # the token is validated by the API the script calls, not here
    return _page("track.html")


@router.get("/rider/{token}", include_in_schema=False)
def rider_page(token: str):
    return _page("rider.html")


class Assets(StaticFiles):
    """Static files with the same hardening headers; assets are not secret, so they may be cached briefly."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def with_headers(message):
            if message["type"] == "http.response.start":
                h = {k: v for k, v in HEADERS.items() if k != "Cache-Control"}
                h["Cache-Control"] = "public, max-age=300"
                message.setdefault("headers", []).extend((k.lower().encode(), v.encode()) for k, v in h.items())
            await send(message)
        await super().__call__(scope, receive, with_headers)
