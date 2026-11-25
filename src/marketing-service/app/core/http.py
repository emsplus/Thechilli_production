"""Pure-ASGI middleware: request body size limit and security headers."""
from app.core.config import settings
from app.core.errors import error_body
import json

SECURITY_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"content-security-policy", b"frame-ancestors 'none'"),
]
_DOCS = ("/api/v1/docs", "/api/v1/openapi.json")


class HardeningMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]

        async def send_hardened(message):
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                present = {k.lower() for k, _ in headers}
                headers.extend(h for h in SECURITY_HEADERS if h[0] not in present)
                if settings.env != "development":
                    headers.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
                if path.startswith("/api/") and path not in _DOCS:
                    headers[:] = [h for h in headers if h[0].lower() != b"cache-control"]
                    headers.append((b"cache-control", b"no-store"))
            await send(message)

        declared = dict(scope.get("headers", [])).get(b"content-length")
        limit = settings.document_max_bytes + 4096 if (scope["method"] == "POST" and path.endswith("/documents")) \
            else settings.max_request_bytes
        if declared and declared.isdigit() and int(declared) > limit:
            body = json.dumps(error_body(413, "Request body too large")).encode()
            await send_hardened({"type": "http.response.start", "status": 413,
                                 "headers": [(b"content-type", b"application/json")]})
            await send_hardened({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send_hardened)
