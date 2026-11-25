class AppError(Exception):
    status = 400
    code = "bad_request"

    def __init__(self, message: str, *, code: str | None = None, status: int | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status:
            self.status = status


class NotFound(AppError):
    status, code = 404, "not_found"


class Conflict(AppError):
    status, code = 409, "conflict"


class ProviderError(AppError):
    status, code = 502, "provider_error"
    # True only when the provider answered with a 4xx: the request was definitely NOT executed.
    # Timeouts / 5xx / garbage leave the outcome unknown and must be reconciled, never blindly retried.
    definitive = False

    def __init__(self, message: str, *, definitive: bool = False):
        super().__init__(message)
        self.definitive = definitive
