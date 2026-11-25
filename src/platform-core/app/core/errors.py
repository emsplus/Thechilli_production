from fastapi import Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    def __init__(self, status: int, code: str, message: str, headers: dict | None = None):
        self.status, self.code, self.message, self.headers = status, code, message, headers or {}


def bad(msg, code="bad_request"): return AppError(400, code, msg)
def unauthorized(msg="Invalid or missing credentials"): return AppError(401, "unauthorized", msg, {"WWW-Authenticate": "Bearer"})
def forbidden(msg="Not permitted"): return AppError(403, "forbidden", msg)
def not_found(msg="Not found"): return AppError(404, "not_found", msg)
def conflict(msg, code="conflict"): return AppError(409, code, msg)


async def app_error_handler(_: Request, exc: AppError):
    return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status, headers=exc.headers)
