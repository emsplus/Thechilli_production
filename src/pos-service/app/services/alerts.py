import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models.core import Alert, InventoryItem, Restaurant
from app.services import inventory


def evaluate(db: Session, restaurant_id: uuid.UUID, item_ids: list[uuid.UUID]) -> None:
    """Open one alert per low item (deduplicated by a partial unique index); resolve it once stock recovers.
    Runs inside the caller's transaction so alerts always match the committed ledger."""
    if not item_ids:
        return
    db.flush()
    bal = inventory.balances(db, restaurant_id, item_ids)
    from app.services import reorder  # local import: reorder -> inventory -> alerts
    restaurant = None
    for item in db.scalars(select(InventoryItem).where(InventoryItem.id.in_(item_ids))):
        b = bal.get(item.id, Decimal(0))
        low = item.is_active and item.reorder_level > 0 and b <= item.reorder_level  # archived items never alert
        open_alert = db.scalar(select(Alert).where(Alert.item_id == item.id, Alert.kind == "low_stock", Alert.status == "open"))
        if low and not open_alert:
            restaurant = restaurant or db.get(Restaurant, restaurant_id)
            pending = reorder.wants_auto(restaurant, item)  # emailed to the usual supplier after the commit (background)
            # INSERT .. ON CONFLICT DO NOTHING on the partial unique index uq_alert_open_item: two concurrent transactions
            # (two bills that both cross the reorder level) can both see "no open alert"; the second waits for the first's
            # commit and then does nothing, instead of failing the whole sale with an IntegrityError (a 500).
            opened = db.execute(pg_insert(Alert).values(
                restaurant_id=restaurant_id, kind="low_stock", item_id=item.id, status="open", balance=b, email_pending=pending,
                message=f"{item.name} is low: {b.normalize():f} {item.base_unit} left (reorder at {item.reorder_level.normalize():f})",
            ).on_conflict_do_nothing(index_elements=["item_id", "kind"], index_where=(Alert.status == "open"))
              .returning(Alert.id)).scalar()
            if opened is not None and pending:
                reorder.note_pending(db, restaurant_id)
        elif low and open_alert:
            open_alert.balance = b
        elif not low and open_alert:
            open_alert.status, open_alert.resolved_at = "resolved", datetime.now(timezone.utc)
