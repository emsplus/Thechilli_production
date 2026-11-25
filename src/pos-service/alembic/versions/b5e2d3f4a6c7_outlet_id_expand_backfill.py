"""PR 5a (docs/PHASE1_PLAN.md, docs/OUTLETS.md): outlet_id on the order / billing / KOT / table / device / print tables.
Expand: nullable column + index + composite FK (outlet_id, restaurant_id) -> outlets(id, restaurant_id) NOT VALID.
Backfill (idempotent): every existing row belongs to its restaurant's default outlet. Row counts are printed per table.

Downgrade drops the columns: refused once any restaurant has a second outlet (the data would be lost); then rollback is
code-only and the columns stay.

Revision ID: b5e2d3f4a6c7
Revises: a4f1c2d3e5b6
Create Date: 2026-10-29 22:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = 'b5e2d3f4a6c7'
down_revision: Union[str, Sequence[str], None] = 'a4f1c2d3e5b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("devices", "dining_tables", "orders", "kot_tickets", "bills", "payments", "refunds",
          "printers", "print_hubs", "hub_pairings", "print_jobs")


def backfill(bind) -> None:
    for t in TABLES:
        before = bind.scalar(sa.text(f"SELECT count(*) FROM {t} WHERE outlet_id IS NULL"))
        bind.execute(sa.text(
            f"UPDATE {t} x SET outlet_id = o.id FROM outlets o "
            f"WHERE o.restaurant_id = x.restaurant_id AND o.is_default AND x.outlet_id IS NULL"))
        after = bind.scalar(sa.text(f"SELECT count(*) FROM {t} WHERE outlet_id IS NULL"))
        print(f"outlet_id backfill {t}: null before={before} after={after}")


def upgrade() -> None:
    bind = op.get_bind()
    for t in TABLES:
        op.add_column(t, sa.Column('outlet_id', sa.UUID(), nullable=True))
        op.create_index(op.f(f'ix_{t}_outlet_id'), t, ['outlet_id'], unique=False)
        op.execute(f"ALTER TABLE {t} ADD CONSTRAINT fk_{t}_outlet FOREIGN KEY (outlet_id, restaurant_id) "
                   f"REFERENCES outlets (id, restaurant_id) NOT VALID")
    backfill(bind)


def downgrade() -> None:
    bind = op.get_bind()
    if bind.scalar(sa.text("SELECT count(*) FROM (SELECT restaurant_id FROM outlets GROUP BY restaurant_id HAVING count(*) > 1) s")):
        raise RuntimeError("Refusing to drop outlet_id: a restaurant has more than one outlet. Roll back the code only.")
    for t in reversed(TABLES):
        op.execute(f"ALTER TABLE {t} DROP CONSTRAINT IF EXISTS fk_{t}_outlet")
        op.drop_index(op.f(f'ix_{t}_outlet_id'), table_name=t)
        op.drop_column(t, 'outlet_id')
