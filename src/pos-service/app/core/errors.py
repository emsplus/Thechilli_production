"""Uniform error bodies. Every error carries BOTH the legacy `detail` (the web app reads it) and a structured
`error: {code, message, details}`."""
import logging

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DataError, IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("app.errors")

CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed",
         409: "conflict", 413: "payload_too_large", 415: "unsupported_media_type", 422: "validation_error",
         429: "too_many_requests", 500: "internal_error"}


INVALID_VALUE = ("A value in this request cannot be saved (an invisible control character in a text, or a number that is too "
                 "large). Check what was typed or scanned and try again.")

CONFLICT_VALUE = "This change conflicts with what is already saved (for example a duplicate, or a minimum above the maximum). Reload and try again."


def error_body(status: int, message: str, detail=None, details=None, code: str | None = None) -> dict:
    return {"detail": message if detail is None else detail,
            "error": {"code": code or CODES.get(status, "error" if status < 500 else "server_error"),
                      "message": message, "details": details}}


def _plain(e: dict) -> str | None:
    """Owner-readable text for the number mistakes that reach the server (a price or discount typed with too many digits or decimals,
    or letters): pydantic's own wording ("Decimal input should have no more than 10 digits before the decimal point") must not be
    shown to a restaurant owner (BREAK_UI_REPORT.md D06 / D15). `type` stays the machine-readable code."""
    ctx = e.get("ctx") or {}
    t = e.get("type")
    if t == "decimal_max_places":
        n = ctx.get("decimal_places")
        return f"Use at most {n} decimal place{'s' if n != 1 else ''} (for example 12.50)."
    if t == "decimal_whole_digits":
        return f"That number is too large. Use at most {ctx.get('whole_digits')} digits before the decimal point."
    if t == "decimal_max_digits":
        return "That number is too large. Enter a smaller amount."
    if t in ("int_parsing", "int_from_float", "int_type"):  # whole-number fields (quantity, seats, guests): no decimal example
        return "Enter a whole number, for example 4."
    if t in ("decimal_parsing", "decimal_type", "float_parsing", "float_type", "finite_number"):
        return "Enter a plain number such as 12.50, with no letters or symbols."
    if t == "greater_than" and str(ctx.get("gt")) in ("0", "0.0"):
        return "Enter a number greater than zero."
    if t == "greater_than_equal" and str(ctx.get("ge")) in ("0", "0.0"):
        return "Enter zero or a larger number."
    return None


def safe_errors(errors: list[dict]) -> list[dict]:
    """Pydantic's error dicts, without the submitted value: `input` (the offending value, which for a login or password-change
    body is a password) and `ctx` (may hold the value or the exception object) are dropped. loc / msg / type stay, which is
    all a client needs to fix its request."""
    out = []
    for e in errors:
        row = {k: v for k, v in jsonable_encoder(e).items() if k in ("loc", "msg", "type")}
        plain = _plain({"type": e.get("type"), "ctx": jsonable_encoder(e.get("ctx") or {})})
        if plain:
            row["msg"] = plain
        out.append(row)
    return out


def install(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def http_exc(request: Request, exc: StarletteHTTPException):
        msg = exc.detail if isinstance(exc.detail, str) else "Request failed"
        extra = getattr(exc, "details", None)  # app.services.order_rules.RuleError: plain message + machine-readable details
        body = error_body(exc.status_code, msg, detail=exc.detail,
                          details=jsonable_encoder(extra) if extra is not None
                          else None if isinstance(exc.detail, str) else jsonable_encoder(exc.detail),
                          code=getattr(exc, "code", None))
        return JSONResponse(body, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_exc(request: Request, exc: RequestValidationError):
        errors = safe_errors(exc.errors())
        return JSONResponse(error_body(422, "Request validation failed", detail=errors, details=errors),
                            status_code=422)

    @app.exception_handler(DataError)
    async def data_exc(request: Request, exc: DataError):
        # The database refused a VALUE the request carried: a NUL character in a text, a number beyond NUMERIC(12,2), an
        # out-of-range date. That is the client's input, not a server fault: 422, never a 500 (BREAK_BACKEND_REPORT.md D6/D7).
        # The request's session is rolled back by get_db's teardown; the message names no column or value.
        log.warning("Refused value on %s %s: %s", request.method, request.url.path, type(exc.orig).__name__)
        return JSONResponse(error_body(422, INVALID_VALUE, code="invalid_value"), status_code=422)

    @app.exception_handler(IntegrityError)
    async def integrity_exc(request: Request, exc: IntegrityError):
        # A uniqueness / check rule of the database refused the change and no service turned it into its own message (e.g. a
        # second open attendance record, min_select above max_select): a conflict with the stored data, not a server fault.
        log.warning("Refused by a database rule on %s %s: %s", request.method, request.url.path, type(exc.orig).__name__)
        return JSONResponse(error_body(409, CONFLICT_VALUE), status_code=409)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        log.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(error_body(500, "Internal server error"), status_code=500)
