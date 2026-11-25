"""Database side of the stock ledger (docs/INVENTORY.md): the trigger that keeps every running total consistent with the
ledger in the SAME transaction, and the trigger that makes the ledger append-only.

* AFTER INSERT on stock_movements: item balance (`inventory_items.balance`), per-location balance (`stock_balances`) and
  per-batch remaining (`stock_batches.remaining`) move by the movement's quantity. The UPDATE also row-locks the item, so two
  concurrent postings of one item serialise in the database even if the caller forgot to lock.
* BEFORE UPDATE OR DELETE on stock_movements: refused. A correction is a new, opposite movement. TRUNCATE (test resets) and
  dropping the table are not affected.

The triggers run as the invoking role (the app role has DML on all of these tables and RLS applies as usual).
Single source of the SQL: the Alembic revision and tests/conftest.py both call ``create_all``."""
from sqlalchemy import text
from sqlalchemy.engine import Connection

APPLY_FN = """
CREATE OR REPLACE FUNCTION stock_ledger_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE inventory_items SET balance = balance + NEW.quantity WHERE id = NEW.item_id;
  INSERT INTO stock_balances (restaurant_id, item_id, location_id, balance)
       VALUES (NEW.restaurant_id, NEW.item_id, NEW.location_id, NEW.quantity)
  ON CONFLICT (item_id, location_id) DO UPDATE SET balance = stock_balances.balance + EXCLUDED.balance;
  IF NEW.batch_id IS NOT NULL THEN
    UPDATE stock_batches SET remaining = remaining + NEW.quantity WHERE id = NEW.batch_id;
  END IF;
  RETURN NEW;
END $$"""

FROZEN_FN = """
CREATE OR REPLACE FUNCTION stock_ledger_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only: post an opposite movement instead' USING ERRCODE = 'restrict_violation';
END $$"""

TRIGGERS = (
    "DROP TRIGGER IF EXISTS stock_ledger_apply_trg ON stock_movements",
    "CREATE TRIGGER stock_ledger_apply_trg AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION stock_ledger_apply()",
    "DROP TRIGGER IF EXISTS stock_ledger_frozen_trg ON stock_movements",
    "CREATE TRIGGER stock_ledger_frozen_trg BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION stock_ledger_frozen()",
)


def create_all(conn: Connection) -> None:
    conn.execute(text(APPLY_FN))
    conn.execute(text(FROZEN_FN))
    for sql in TRIGGERS:
        conn.execute(text(sql))


def drop_all(conn: Connection) -> None:
    conn.execute(text("DROP TRIGGER IF EXISTS stock_ledger_apply_trg ON stock_movements"))
    conn.execute(text("DROP TRIGGER IF EXISTS stock_ledger_frozen_trg ON stock_movements"))
    conn.execute(text("DROP FUNCTION IF EXISTS stock_ledger_apply()"))
    conn.execute(text("DROP FUNCTION IF EXISTS stock_ledger_frozen()"))
