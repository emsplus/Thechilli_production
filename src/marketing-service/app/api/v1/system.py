from fastapi import APIRouter
from sqlalchemy import text

from app.core.db import engine

VERSION = "0.1.0"
router = APIRouter(tags=["system"])


@router.get("/health")
def health():
    with engine.connect() as c:
        c.execute(text("select 1"))
    return {"status": "ok", "version": VERSION}
