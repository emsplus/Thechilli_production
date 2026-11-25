from fastapi import FastAPI

from app.api.routes import router
from app.core import errors
from app.core.config import check_startup, settings
from app.pos.http import HttpPosClient
from app.providers.registry import default_registry


def create_app() -> FastAPI:
    check_startup(settings)
    docs = {} if settings.is_dev else {"docs_url": None, "redoc_url": None, "openapi_url": None}
    app = FastAPI(title="aggregator-service", version="0.1.0", **docs)
    app.state.registry = default_registry()
    app.state.pos_client = HttpPosClient()
    errors.install(app)
    app.include_router(router)
    return app


app = create_app()
