import logging
import math
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.v1.routes import router
from app.core.config import settings
from app.core.errors import AppError
from app.core.security import MIN_SECRET, keyring
from app.web import pages
from app.web.pages import Assets


def validate_startup() -> None:
    """Fail loudly in production instead of degrading silently (e.g. to a console/mock provider)."""
    if settings.env == "development":
        return
    problems = []
    if not keyring():
        problems.append(f"LINK_SECRET or LINK_KEYRING needs a key of at least {MIN_SECRET} characters")
    elif settings.link_active_kid and settings.link_active_kid not in keyring():
        problems.append("LINK_ACTIVE_KID is not in the keyring")
    if settings.whatsapp_provider == "mock" and not settings.allow_mock_provider:
        problems.append("WHATSAPP_PROVIDER=mock is not allowed in production (set ALLOW_MOCK_PROVIDER=true to override)")
    if not settings.whatsapp_app_secret.get_secret_value():
        problems.append("WHATSAPP_APP_SECRET is required")
    if settings.whatsapp_provider == "meta":
        if not settings.whatsapp_access_token.get_secret_value():
            problems.append("WHATSAPP_ACCESS_TOKEN is required for WHATSAPP_PROVIDER=meta")
        if not settings.whatsapp_verify_token.get_secret_value():
            problems.append("WHATSAPP_VERIFY_TOKEN is required for WHATSAPP_PROVIDER=meta")
    if problems:
        raise RuntimeError("; ".join(problems))


def check_db_role() -> None:
    """Security review finding 3: the API's DB role must be subject to RLS (fails closed outside development)."""
    from app.core import db_roles, rls
    from app.core.db import engine
    db_roles.check_runtime_role(engine, env=settings.env, allow_override=settings.allow_privileged_db_role,
                                tenant_tables=rls.all_tables(), log=logging.getLogger("app.db_roles"))


@asynccontextmanager
async def lifespan(_: FastAPI):
    validate_startup()
    check_db_role()
    yield


_dev = settings.env == "development"  # fail closed: interactive docs only in development
app = FastAPI(title="delivery-service", version="0.1.0", lifespan=lifespan, docs_url="/docs" if _dev else None,
              redoc_url=None, openapi_url="/openapi.json" if _dev else None)
app.include_router(router, prefix="/api/v1")
app.include_router(pages.router)
app.mount("/assets", Assets(directory=pages.STATIC), name="assets")


@app.exception_handler(AppError)
async def app_error(_: Request, exc: AppError):
    headers = {"Retry-After": str(max(1, math.ceil(exc.extra["retry_after"])))} if "retry_after" in exc.extra else None
    return JSONResponse({"code": exc.code, "error": {"code": exc.code, "message": exc.message}, **exc.extra},
                        status_code=exc.status, headers=headers)
