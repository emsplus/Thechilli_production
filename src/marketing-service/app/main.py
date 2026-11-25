from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import (activities, audit, auth, campaigns, commissions, demos, invitations, leads, onboarding, public,
                        referrals, system, users)
from app.core import errors
from app.core.config import settings
from app.core.http import HardeningMiddleware

_docs = settings.env == "development" or settings.docs_enabled  # security review finding 10: off outside development
app = FastAPI(title="Marketing & Onboarding API (Portal C)", version=system.VERSION,
              docs_url="/api/v1/docs" if _docs else None, redoc_url="/api/v1/redoc" if _docs else None,
              openapi_url="/api/v1/openapi.json" if _docs else None)
app.add_middleware(HardeningMiddleware)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])
errors.install(app)

api = APIRouter(prefix="/api/v1")
for m in (system, auth, users, leads, activities, demos, onboarding, invitations, referrals, campaigns, commissions,
          audit, public):
    api.include_router(m.router)
app.include_router(api)
