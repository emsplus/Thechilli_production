"""Uniform error bodies. Every error carries BOTH the legacy `detail` (the web app reads it) and a structured
`error: {code, message, details}`."""
import logging

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("app.errors")

CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed",
         409: "conflict", 413: "payload_too_large", 415: "unsupported_media_type", 422: "validation_error",
         429: "too_many_requests", 500: "internal_error"}


def error_body(status: int, message: str, detail=None, details=None) -> dict:
    return {"detail": message if detail is None else detail,
            "error": {"code": CODES.get(status, "error" if status < 500 else "server_error"),
                      "message": message, "details": details}}


def install(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def http_exc(request: Request, exc: StarletteHTTPException):
        msg = exc.detail if isinstance(exc.detail, str) else "Request failed"
        body = error_body(exc.status_code, msg, detail=exc.detail,
                          details=None if isinstance(exc.detail, str) else jsonable_encoder(exc.detail))
        return JSONResponse(body, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_exc(request: Request, exc: RequestValidationError):
        errors = jsonable_encoder(exc.errors())
        return JSONResponse(error_body(422, "Request validation failed", detail=errors, details=errors),
                            status_code=422)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        log.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(error_body(500, "Internal server error"), status_code=500)
