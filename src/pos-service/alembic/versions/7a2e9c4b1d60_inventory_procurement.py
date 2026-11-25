"""inventory & procurement: stock locations, batches, per-item balances, POs, GRNs, returns, supplier ledger, counts

* stock_movements: location_id (backfilled to the default location of the tenant's default outlet, then NOT NULL), batch_id,
  reason_code, ref_type; movement_type enum + purchase_return, expiry_writeoff; the idempotency key widens from
  (restaurant, item, type, ref) to (restaurant, item, type, ref, location, batch) so a FEFO sale can post one row per batch.
* inventory_items: sku (partial unique), category, tracks_batches, shelf_life_days, last_cost (backfilled from the latest
  purchase movement), balance (backfilled from the ledger) + stock_balances (per item and location). Both are kept by the
  AFTER INSERT trigger of app/core/stock_db.py, which also makes stock_movements append-only.
* restaurants.allow_negative_stock (default true = the behaviour before the setting).
* new tables (models/inventory.py) with RLS.

The new tables are created from the model definitions (Table.create): they are new in this revision, so the metadata is
their definition at this point. Downgrade drops everything except the two enum values (PostgreSQL cannot drop enum values).

Revision ID: 7a2e9c4b1d60
Revises: a9e4f6b8c0d2
Create Date: 2026-10-30 10:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import rls, stock_db
from app.models import Base
from app.models.inventory import NEW_TABLES

revision: str = '7a2e9c4b1d60'
down_revision: Union[str, Sequence[str], None] = 'a9e4f6b8c0d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD_UNIQUE = "stock_movements_restaurant_id_item_id_movement_type_ref_id_key"


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'purchase_return'")
        op.execute("ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'expiry_writeoff'")
    bind = op.get_bind()

    op.add_column('restaurants', sa.Column('allow_negative_stock', sa.Boolean(), server_default='true', nullable=False))
    for col in (sa.Column('sku', sa.String(60)), sa.Column('category', sa.String(60)),
                sa.Column('tracks_batches', sa.Boolean(), server_default='false', nullable=False),
                sa.Column('shelf_life_days', sa.Integer()), sa.Column('last_cost', sa.Numeric(12, 4)),
                sa.Column('balance', sa.Numeric(14, 3), server_default='0', nullable=False)):
        op.add_column('inventory_items', col)
    op.create_index('uq_inventory_items_sku', 'inventory_items', ['restaurant_id', 'sku'], unique=True,
                    postgresql_where=sa.text('sku IS NOT NULL'))

    for t in Base.metadata.sorted_tables:
        if t.name in NEW_TABLES:
            t.create(bind)

    # one default location per outlet
    op.execute("""INSERT INTO stock_locations (id, restaurant_id, outlet_id, name, kind, is_default, is_active)
                  SELECT gen_random_uuid(), o.restaurant_id, o.id, 'Main store', 'store', true, true FROM outlets o""")

    op.add_column('stock_movements', sa.Column('location_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column('stock_movements', sa.Column('batch_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column('stock_movements', sa.Column('reason_code', sa.String(20), nullable=True))
    op.add_column('stock_movements', sa.Column('ref_type', sa.String(20), nullable=True))
    op.execute("""UPDATE stock_movements m SET location_id = l.id
                  FROM outlets o JOIN stock_locations l ON l.outlet_id = o.id AND l.is_default
                  WHERE o.restaurant_id = m.restaurant_id AND o.is_default""")
    op.alter_column('stock_movements', 'location_id', nullable=False)
    op.create_foreign_key('fk_stock_movements_location', 'stock_movements', 'stock_locations', ['location_id'], ['id'])
    op.create_foreign_key('fk_stock_movements_batch', 'stock_movements', 'stock_batches', ['batch_id'], ['id'])
    op.create_index('ix_stock_movements_location_id', 'stock_movements', ['location_id'])
    op.create_index('ix_stock_movements_batch_id', 'stock_movements', ['batch_id'])

    # balances from the ledger (the trigger does not exist yet, so nothing is counted twice)
    op.execute("""UPDATE inventory_items i SET balance = s.q
                  FROM (SELECT item_id, sum(quantity) q FROM stock_movements GROUP BY item_id) s WHERE s.item_id = i.id""")
    op.execute("""INSERT INTO stock_balances (restaurant_id, item_id, location_id, balance)
                  SELECT restaurant_id, item_id, location_id, sum(quantity) FROM stock_movements GROUP BY restaurant_id, item_id, location_id""")
    op.execute("""UPDATE inventory_items i SET last_cost = s.unit_cost
                  FROM (SELECT DISTINCT ON (item_id) item_id, unit_cost FROM stock_movements
                        WHERE movement_type = 'purchase' AND unit_cost IS NOT NULL AND quantity > 0
                        ORDER BY item_id, created_at DESC, id DESC) s WHERE s.item_id = i.id""")

    op.drop_constraint(OLD_UNIQUE, 'stock_movements', type_='unique')
    op.create_index('uq_stock_movements_ref', 'stock_movements',
                    ['restaurant_id', 'item_id', 'movement_type', 'ref_id', 'location_id',
                     sa.text("coalesce(batch_id, '00000000-0000-0000-0000-000000000000'::uuid)")], unique=True)

    stock_db.create_all(bind)
    rls.enable_tables(bind, NEW_TABLES)


def downgrade() -> None:
    bind = op.get_bind()
    stock_db.drop_all(bind)
    rls.disable_tables(bind, NEW_TABLES)
    op.drop_index('uq_stock_movements_ref', table_name='stock_movements')
    # NOTE: fails if rows that differ only by location / batch exist (the old key is narrower): restore from backup then.
    op.create_unique_constraint(OLD_UNIQUE, 'stock_movements', ['restaurant_id', 'item_id', 'movement_type', 'ref_id'])
    for name in ('ix_stock_movements_batch_id', 'ix_stock_movements_location_id'):
        op.drop_index(name, table_name='stock_movements')
    op.drop_constraint('fk_stock_movements_batch', 'stock_movements', type_='foreignkey')
    op.drop_constraint('fk_stock_movements_location', 'stock_movements', type_='foreignkey')
    for c in ('ref_type', 'reason_code', 'batch_id', 'location_id'):
        op.drop_column('stock_movements', c)
    for t in reversed([t for t in Base.metadata.sorted_tables if t.name in NEW_TABLES]):
        t.drop(bind)
    op.drop_index('uq_inventory_items_sku', table_name='inventory_items')
    for c in ('balance', 'last_cost', 'shelf_life_days', 'tracks_batches', 'category', 'sku'):
        op.drop_column('inventory_items', c)
    op.drop_column('restaurants', 'allow_negative_stock')
