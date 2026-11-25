from fastapi import Request
from sqlalchemy.orm import Session

from app.core.db import get_session
from app.core.security import (
    Caller,
    Internal,
    require_admin,
    require_caller,
    require_worker,
)

__all__ = ["Caller", "Internal", "Session", "get_session", "require_admin", "require_caller", "require_worker"]


def registry(request: Request):
    return request.app.state.registry
