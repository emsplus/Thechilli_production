class AppError(Exception):
    status = 400
    code = "bad_request"

    def __init__(self, message: str, *, code: str | None = None, status: int | None = None, extra: dict | None = None):
        super().__init__(message)
        self.message = message
        self.extra = extra or {}
        if code:
            self.code = code
        if status:
            self.status = status


class NotFound(AppError):
    status, code = 404, "not_found"


class Conflict(AppError):
    status, code = 409, "conflict"


class Unauthorized(AppError):
    status, code = 401, "unauthorized"
