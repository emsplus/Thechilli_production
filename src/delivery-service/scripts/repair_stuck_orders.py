"""Repair delivery orders stuck at `placed` although POS has already moved them on (accepted / preparing / ready / cancelled).

Cause (fixed in bb5f1f9): the create-order call recorded the POS snapshot's version without its status, so the matching
order.accepted webhook (same version) looked stale and was dropped; the reminder re-check is version-gated too, so those
orders never left `placed`. This script asks POS for each `placed` order's live status and, when POS is further on, moves the
mirror forward through the same rules as apply_pos_status (rank only goes up; out_for_delivery / delivered stay ours),
records an OrderEvent (source=repair) and raises pos_version to POS's. It sends NO WhatsApp message (the moment has passed).

Dry run by default (prints what it would change); --apply writes. Idempotent: a repaired order is no longer `placed`.
Runs as the app (RLS-bound per restaurant), so it needs the service's DATABASE_URL and POS secrets, e.g. inside the container:
  docker exec -i chilli-local-delivery-service-1 python - --restaurant <rid> [--apply] < scripts/repair_stuck_orders.py
or locally:  uv run python scripts/repair_stuck_orders.py --restaurant <rid> [--min-age-minutes 5] [--apply]
"""
import argparse
import sys
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app import pos as pos_mod
from app.core.tenancy import tenant_session
from app.models import RANK, TERMINAL, DeliveryOrder, OrderEvent
from app.pos.base import PosError

MIRRORED = ("accepted", "preparing", "ready", "cancelled")


def decide(current: str, live: str | None) -> str | None:
    """The status the mirror should take, or None to leave it."""
    if current in TERMINAL or live not in MIRRORED:
        return None
    if live == "cancelled":
        return "cancelled"
    return live if RANK[live] > RANK[current] else None


def repair_restaurant(restaurant_id: str, *, apply: bool, min_age_minutes: int = 5, out=sys.stdout) -> list[dict]:
    db = tenant_session(restaurant_id)
    rows = []
    try:
        cutoff = datetime.now(UTC) - timedelta(minutes=min_age_minutes)
        stuck = db.scalars(select(DeliveryOrder).where(DeliveryOrder.restaurant_id == restaurant_id,
                                                       DeliveryOrder.status == "placed", DeliveryOrder.created_at <= cutoff)
                           .order_by(DeliveryOrder.created_at).with_for_update(skip_locked=True)).all()
        client = pos_mod.get_pos_client(db, restaurant_id) if stuck else None
        for o in stuck:
            row = {"order_id": str(o.id), "code": o.order_code, "pos_order_id": o.pos_order_id, "created_at": o.created_at,
                   "status": o.status, "pos_status": None, "action": "keep"}
            try:
                live = client.get_order(restaurant_id, o.pos_order_id)
            except PosError as e:
                row["action"] = f"skip (POS: {type(e).__name__})"
                rows.append(row)
                continue
            row["pos_status"] = live.get("status")
            new = decide(o.status, live.get("status"))
            if new:
                row["action"] = f"-> {new}"
                if apply:
                    o.status = new
                    if new == "cancelled":
                        o.otp_hash, o.offered_rider_id = None, None
                    o.pos_version = max(int(o.pos_version or 0), int(live.get("version") or 0))
                    db.add(OrderEvent(order_id=o.id, restaurant_id=o.restaurant_id, kind=new,
                                      detail={"source": "repair", "script": "repair_stuck_orders", "from": "placed"}))
            rows.append(row)
        if apply:
            db.commit()
        else:
            db.rollback()
    finally:
        db.close()
    print(f"restaurant {restaurant_id}: {len(rows)} order(s) at 'placed' older than {min_age_minutes} min"
          f"{'' if apply else ' (dry run: nothing written)'}", file=out)
    for r in rows:
        print(f"  {r['code'] or '-':<10} {r['order_id']}  created {r['created_at']:%Y-%m-%d %H:%M}  "
              f"POS={r['pos_status'] or '?':<10} {r['action']}", file=out)
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--restaurant", action="append", required=True, help="restaurant id (repeatable)")
    ap.add_argument("--min-age-minutes", type=int, default=5, help="only orders placed at least this long ago (default 5)")
    ap.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    a = ap.parse_args(argv)
    for rid in a.restaurant:
        repair_restaurant(rid, apply=a.apply, min_age_minutes=a.min_age_minutes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
