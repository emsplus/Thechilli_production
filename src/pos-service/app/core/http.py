"""Pure-ASGI middleware: request body size limit and security headers."""
import json

from app.core.config import settings
from app.core.errors import error_body

SECURITY_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"content-security-policy", b"frame-ancestors 'none'"),
]
_DOCS = ("/api/v1/docs", "/api/v1/openapi.json")
_PUBLIC_MEDIA = "/api/v1/media/"  # app/api/v1/media.py: public immutable menu photos
_PUBLIC_RECEIPTS = "/api/v1/public/receipts/"  # app/api/v1/public.py: token-gated receipt PDFs (private cache)
_PUBLIC_QR_MENU = "/api/v1/table-qr/public/menu/"  # app/api/v1/table_qr.py: view-only table menu (short public cache)


class _TooLarge(Exception):
    pass


class HardeningMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path, limit = scope["path"], settings.max_request_bytes
        state = {"started": False, "exceeded": False, "replaced": False}

        async def send_hardened(message):
            if message["type"] == "http.response.start":
                state["started"] = True
                headers = message.setdefault("headers", [])
                present = {k.lower() for k, _ in headers}
                headers.extend(h for h in SECURITY_HEADERS if h[0] not in present)
                if settings.env != "development" and b"strict-transport-security" not in present:
                    headers.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
                # API responses are per-user data: never cache them (receipts included). The only exception is a
                # successful response from the public, content-addressed media route, which sets its own
                # `public, immutable` policy; its errors (404) are no-store like everything else.
                if path.startswith("/api/") and path not in _DOCS:
                    if not ((path.startswith(_PUBLIC_MEDIA) or path.startswith(_PUBLIC_RECEIPTS) or path.startswith(_PUBLIC_QR_MENU))
                            and message["status"] in (200, 206, 304) and b"cache-control" in present):
                        headers[:] = [h for h in headers if h[0].lower() != b"cache-control"]
                        headers.append((b"cache-control", b"no-store"))
            await send(message)

        async def send_checked(message):
            if state["exceeded"]:
                # The app saw a truncated body and answered 400/500; replace that with a clean 413.
                if not state["replaced"]:
                    state["replaced"] = True
                    await self._reject(send_hardened)
                return
            await send_hardened(message)

        declared = dict(scope["headers"]).get(b"content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            return await self._reject(send_hardened)

        seen = 0

        async def receive_limited():
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:  # chunked / lying Content-Length
                    state["exceeded"] = True
                    raise _TooLarge()
            return message

        try:
            await self.app(scope, receive_limited, send_checked)
        except _TooLarge:
            if not state["started"] and not state["replaced"]:
                await self._reject(send_hardened)

    @staticmethod
    async def _reject(send):
        body = json.dumps(error_body(413, "Request body too large")).encode()
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
