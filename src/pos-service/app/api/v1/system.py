from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core.config import settings
from app.core.db import get_db
from app.services import reconciliation

router = APIRouter(prefix="/system", tags=["system"])
VERSION = "0.1.0"


def _migration_head() -> str | None:
    try:
        from alembic.config import Config
        from alembic.script import ScriptDirectory
        cfg = Config(str(Path(__file__).resolve().parents[3] / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(__file__).resolve().parents[3] / "alembic"))
        return ScriptDirectory.from_config(cfg).get_current_head()
    except Exception:  # alembic files not shipped with this deployment
        return None


@router.get("/health")
def health_details(p: Principal = Depends(require_perm(P.SYSTEM_VIEW)), db: Session = Depends(get_db)):
    """Operational detail for owners/managers. The public /health stays minimal."""
    db_ok, revision = True, None
    try:
        db.execute(text("SELECT 1"))
        if db.scalar(text("SELECT to_regclass('alembic_version')")):
            revision = db.scalar(text("SELECT version_num FROM alembic_version LIMIT 1"))
    except Exception:
        db_ok = False
    head = _migration_head()
    return {"status": "ok" if db_ok else "degraded", "version": VERSION, "env": settings.env,
            "database": {"reachable": db_ok}, "migration": {"revision": revision, "head": head,
                                                            "up_to_date": None if not (revision and head) else revision == head},
            "checked_at": datetime.now(timezone.utc)}


@router.get("/reconciliation")
def run_reconciliation(p: Principal = Depends(require_perm(P.SYSTEM_VIEW)), db: Session = Depends(get_db)):
    """Read-only invariant checks for the caller's restaurant. ok=false on any error-severity check."""
    checks = reconciliation.run(db, p.restaurant_id)
    return {"ok": all(c["ok"] for c in checks), "checked_at": datetime.now(timezone.utc),
            "warnings": sum(1 for c in checks if c["severity"] == "warning" and c["sample"]),
            "checks": checks}
