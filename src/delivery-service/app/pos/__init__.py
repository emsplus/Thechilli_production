from collections.abc import Callable

from sqlalchemy.orm import Session

from app.core.errors import NotFound
from app.pos.base import PosClient
from app.pos.http import HttpPosClient

# Tests (or a deployment wiring) install a factory: restaurant_id -> PosClient.
factory_override: Callable[[str], PosClient] | None = None


def get_pos_client(db: Session, restaurant_id: str) -> PosClient:
    if factory_override is not None:
        return factory_override(restaurant_id)
    from app.models import Restaurant
    r = db.get(Restaurant, restaurant_id)
    if not r:
        raise NotFound("restaurant is not configured")
    return HttpPosClient(r.pos_api_key_ref)
