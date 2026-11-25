from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    def __init__(self, status: int, code: str, message: str, details=None):
        self.status, self.code, self.message, self.details = status, code, message, details


def install(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _h(request: Request, exc: AppError):
        return JSONResponse({"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
                            status_code=exc.status)
