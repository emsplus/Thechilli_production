import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import analytics, auth, billing, catalog, marketing, mfa, onboarding, ops, sessions, staff, support, tenants, wallet
from app.core.config import settings
from app.core.errors import AppError, app_error_handler
from app.core.security import get_keyring


def _start_provisioning_sweep() -> threading.Event:
    """PROVISION_SWEEP_SECONDS > 0: a daemon thread runs the provisioning sweep (queued, due retries, invite -> live). Off by default;
    with several workers each runs one, which is safe (rows are claimed with SKIP LOCKED)."""
    stop = threading.Event()
    every = settings.provision_sweep_seconds
    if every > 0:
        def loop():
            from app.core.db import SessionLocal
            from app.services import onboarding
            while not stop.wait(every):
                try:
                    with SessionLocal() as db:
                        onboarding.run_due(db)
                except Exception:  # noqa: BLE001 - the sweep must survive a bad cycle
                    logging.getLogger("app.onboarding").exception("provisioning sweep failed")
        threading.Thread(target=loop, name="provisioning-sweep", daemon=True).start()
    return stop


def _start_retention_sweep() -> threading.Event:
    """RETENTION_SWEEP_SECONDS > 0 (default daily): purge old login / security rows (security review finding 14)."""
    stop = threading.Event()
    every = settings.retention_sweep_seconds
    if every > 0:
        def loop():
            from app.core.db import SessionLocal
            from app.services import retention
            while not stop.wait(every):
                try:
                    with SessionLocal() as db:
                        retention.purge(db)
                except Exception:  # noqa: BLE001
                    logging.getLogger("app.retention").exception("retention purge failed")
        threading.Thread(target=loop, name="retention-sweep", daemon=True).start()
    return stop


def _start_billing_sweep() -> threading.Event:
    """BILLING_SWEEP_SECONDS > 0: trial-ending notices and PAYG trial conversion (docs/PAYG_BILLING.md). Off by default;
    idempotent, so several workers may run it."""
    stop = threading.Event()
    every = settings.billing_sweep_seconds
    if every > 0:
        def loop():
            from app.core.db import SessionLocal
            from app.services import wallet as wallet_svc
            while not stop.wait(every):
                try:
                    with SessionLocal() as db:
                        wallet_svc.run_due(db)
                        db.commit()
                except Exception:  # noqa: BLE001 - the sweep must survive a bad cycle
                    logging.getLogger("app.wallet").exception("billing sweep failed")
        threading.Thread(target=loop, name="billing-sweep", daemon=True).start()
    return stop


@asynccontextmanager
async def lifespan(_: FastAPI):
    from app.services import mfa as mfa_svc
    mfa_svc.check_config()  # production needs MFA_ENCRYPTION_KEY
    from app.services import mailer as mailer_svc
    mailer_svc.check_config()  # no SMTP_FROM: production refuses to start, elsewhere a loud error log
    get_keyring()  # fail closed: production without a keyring refuses to start
    stop = _start_provisioning_sweep()
    stop_retention = _start_retention_sweep()
    stop_billing = _start_billing_sweep()
    yield
    stop.set()
    stop_retention.set()
    stop_billing.set()


app = FastAPI(title="Chilli platform-core", version="0.1.0", lifespan=lifespan,
              docs_url=None if settings.is_production else "/docs", redoc_url=None,
              openapi_url=None if settings.is_production else "/openapi.json")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                   allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Step-Up-Token"],
                   expose_headers=["X-Step-Up-Required", "Retry-After"])
app.add_exception_handler(AppError, app_error_handler)


@app.exception_handler(RequestValidationError)
async def validation_handler(_: Request, exc: RequestValidationError):
    errs = [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]
    return JSONResponse({"error": {"code": "validation_error", "message": "Invalid request", "details": errs}}, status_code=422)


@app.middleware("http")
async def limits_and_headers(request: Request, call_next):
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > settings.max_request_bytes:
        return JSONResponse({"error": {"code": "too_large", "message": "Request too large"}}, status_code=413)
    resp = await call_next(request)
    resp.headers.setdefault("Cache-Control", "no-store")
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


for r in (auth, mfa, sessions, staff, tenants, onboarding, catalog, billing, wallet, support, ops, analytics, marketing):
    app.include_router(r.router, prefix="/api/v1")
app.include_router(auth.well_known)  # /.well-known/jwks.json at the origin root as well (standard discovery location)
