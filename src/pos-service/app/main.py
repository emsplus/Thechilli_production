import logging
import threading
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import ai, audit, auth, billing, cash_sessions, comms, crm, delivery, expenses, inventory, media, menu, menu_extras, online_payments, orders, outlets, printing, provision, public, recipe_ai, reorder, reports, restaurant, roles, stock, sync, system, voice_aliases, voice_wake, waiter
from app.api.v1 import attendance, auth_otp, daily_report as daily_report_api, mfa as mfa_api, reservations, setup as setup_api
from app.api.v1 import staff_devices, table_qr as table_qr_api, wallet as wallet_api
from app.core import errors, tenancy  # noqa: F401 - tenancy installs the per-transaction tenant listener
from app.core.config import settings
from app.core.http import HardeningMiddleware
from app.services import reorder as services_reorder  # also installs the after-commit hook that sends re-order emails

log = logging.getLogger("app.startup")


def _recover_extractions() -> None:
    from app.services.ocr import get_extractor
    from app.services.purchases import recover_stuck_extractions
    try:
        n = recover_stuck_extractions(get_extractor())
        if n:
            log.info("Re-ran %d stuck purchase extraction(s)", n)
    except Exception:  # never take the API down over recovery (e.g. DB not migrated yet)
        log.exception("Purchase extraction recovery failed")


@asynccontextmanager
async def lifespan(_: FastAPI):
    from app.core import db_roles, rls
    from app.core.db import engine
    db_roles.check_runtime_role(engine, env=settings.env, allow_override=settings.allow_privileged_db_role,
                                tenant_tables=tuple(rls.all_tables()), log=log)  # raises: the API does not start
    # Off the event loop and non-blocking: OCR calls can take a while; startup must not wait for them.
    threading.Thread(target=_recover_extractions, name="ocr-recovery", daemon=True).start()
    from app.services import printing as services_printing
    services_printing.start_sweeper()  # stale `sent` print jobs / expired slips, off the hub poll path
    services_reorder.start_sweeper()  # low items that waited for their supplier's email window (no-op when email is not set up)
    from app.services import gemini, voice_order as services_voice
    gemini.log_startup_warnings()
    from app.services import mail as services_mail
    services_mail.check_config()  # SMTP host without a sender (SMTP_FROM): loud error instead of silent failures later
    services_voice.start_purger()
    from app.services import whatsapp as services_whatsapp
    services_whatsapp.start_sweeper()  # queued WhatsApp messages due for a (re)try; WHATSAPP_SWEEP_SECONDS=0 turns it off
    from app.services import delivery_outbox
    delivery_outbox.start_runner()  # status webhooks to delivery-service (no-op when DELIVERY_OUTBOX_SWEEP_SECONDS=0)
    from app.services import daily_report
    daily_report.start_sweeper()  # end of day report emails (DAILY_REPORT_SWEEP_SECONDS=0 turns it off)
    from app.services import wallet as services_wallet
    services_wallet.start_runner()  # PAYG usage -> platform-core (no-op when BILLING_USAGE_SWEEP_SECONDS=0 or unconfigured)
    yield


def docs_enabled() -> bool:
    return settings.docs_enabled if settings.docs_enabled is not None else settings.env == "development"


app = FastAPI(title="Chilli Agent API", version=system.VERSION, lifespan=lifespan,
              docs_url="/api/v1/docs" if docs_enabled() else None,
              redoc_url=None, openapi_url="/api/v1/openapi.json" if docs_enabled() else None)
app.add_middleware(HardeningMiddleware)  # inside CORS so error responses still get CORS headers
# Response headers a cross-origin client (the iOS waiter app in its capacitor://localhost WebView) must be able to read:
# PIN lockout / retry hints and the step-up / locked-session signals (docs/STAFF_PIN_DEVICES_API.md).
CORS_EXPOSE_HEADERS = ["X-Pin-Attempts-Left", "Retry-After", "X-Session-Locked", "X-Step-Up-Required"]
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"], expose_headers=CORS_EXPOSE_HEADERS)
errors.install(app)
delivery.install(app)

v1 = APIRouter(prefix="/api/v1")
v1.include_router(auth.router)
v1.include_router(mfa_api.router)
v1.include_router(auth_otp.router)
v1.include_router(daily_report_api.router)
v1.include_router(staff_devices.auth_router)
v1.include_router(staff_devices.devices_router)
v1.include_router(roles.router)
v1.include_router(menu.router)
v1.include_router(menu_extras.router)
v1.include_router(media.router)
v1.include_router(public.router)
v1.include_router(orders.router)
v1.include_router(billing.router)
v1.include_router(inventory.router)
v1.include_router(stock.router)
v1.include_router(expenses.router)
v1.include_router(cash_sessions.router)
v1.include_router(sync.router)
v1.include_router(crm.router)
v1.include_router(reports.router)
v1.include_router(ai.router)
v1.include_router(audit.router)
v1.include_router(system.router)
v1.include_router(restaurant.router)
v1.include_router(reservations.router)
v1.include_router(attendance.router)
v1.include_router(setup_api.router)
v1.include_router(outlets.router)
v1.include_router(reorder.router)
v1.include_router(recipe_ai.router)
v1.include_router(voice_aliases.router)
v1.include_router(voice_wake.router)
v1.include_router(printing.router)
v1.include_router(comms.router)
v1.include_router(online_payments.router)
v1.include_router(delivery.router)
v1.include_router(provision.accept_router)
v1.include_router(waiter.router)
v1.include_router(wallet_api.router)
v1.include_router(table_qr_api.router)


@v1.get("/health", tags=["system"])
def health():
    """Liveness (container healthcheck): the process answers. Readiness with dependencies: /health/ready."""
    return {"status": "ok"}


@v1.get("/health/ready", tags=["system"])
def health_ready():
    """Readiness for load balancers / orchestrators. Public, so it shows states only: no host names, versions, revision ids
    or error text (owners get those from /system/health). 503 when the database is unreachable or the schema is behind the
    code's migration head; an unknown migration state (no alembic_version table, alembic files not shipped) does not block."""
    from fastapi.responses import JSONResponse
    from sqlalchemy import text

    from app.api.v1.system import _migration_head
    from app.core.db import SessionLocal
    db_state, mig = "ok", "unknown"
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
            rev = (db.scalar(text("SELECT version_num FROM alembic_version LIMIT 1"))
                   if db.scalar(text("SELECT to_regclass('alembic_version')")) else None)
    except Exception:  # noqa: BLE001 - any failure means not ready; the detail is logged, never returned
        logging.getLogger(__name__).warning("readiness: database check failed", exc_info=True)
        db_state, rev = "down", None
    head = _migration_head()
    if rev and head:
        mig = "up_to_date" if rev == head else "behind"
    ready = db_state == "ok" and mig != "behind"
    return JSONResponse({"status": "ready" if ready else "not_ready", "checks": {"database": db_state, "migrations": mig}},
                        status_code=200 if ready else 503)


app.include_router(v1)
app.include_router(table_qr_api.pages)  # /m/{token}, /rv/{token}, /qr-static/*: public table QR pages (docs/TABLE_QR_REVIEWS.md)
app.include_router(provision.router)  # /internal/provision/*: service principal (platform-core), outside /api/v1
