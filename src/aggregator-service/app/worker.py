"""Retry-queue worker: `python -m app.worker`. Polls for due outbound jobs."""
import time

from app.core.config import check_startup, settings
from app.core.db import SessionLocal
from app.pos.http import HttpPosClient
from app.providers.registry import default_registry
from app.services.handlers import build_handlers
from app.services.outbox import run_due

if __name__ == "__main__":
    check_startup(settings)
    handlers = build_handlers(default_registry(), HttpPosClient())
    while True:
        with SessionLocal() as s:
            stats = run_due(s, handlers)
        if not any(stats.values()):
            time.sleep(2)
