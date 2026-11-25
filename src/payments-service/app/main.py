from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.v1.routes import router
from app.core.config import settings
from app.core.errors import AppError

_dev = settings.env == "development"  # fail closed: interactive docs only in development
app = FastAPI(title="payments-service", version="0.1.0", docs_url="/docs" if _dev else None,
              redoc_url=None, openapi_url="/openapi.json" if _dev else None)
app.include_router(router, prefix="/api/v1")


@app.exception_handler(AppError)
async def app_error(_: Request, exc: AppError):
    return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)
