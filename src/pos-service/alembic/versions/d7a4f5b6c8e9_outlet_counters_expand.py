"""PR 6a (docs/OUTLETS.md): outlet_id on invoice_sequences and z_reports (the per-outlet counters). Expand + idempotent backfill,
exactly like 5a: every existing counter row and Z report belongs to its restaurant's default outlet, so the default outlet's
numbering CONTINUES: next INV / CN / KOT / Z number = last + 1. Row counts and the counters per kind are printed.

Downgrade drops the columns (refused once any restaurant has a second outlet).

Revision ID: d7a4f5b6c8e9
Revises: c6f3e4a5b7d8
Create Date: 2026-10-29 23:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = 'd7a4f5b6c8e9'
down_revision: Union[str, Sequence[str], None] = 'c6f3e4a5b7d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("invoice_sequences", "z_reports")


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
    for r in bind.execute(sa.text("SELECT restaurant_id, kind, year, last_number FROM invoice_sequences ORDER BY 1, 2, 3")):
        print(f"counter {r.restaurant_id} {r.kind} {r.year} last={r.last_number}")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.scalar(sa.text("SELECT count(*) FROM (SELECT restaurant_id FROM outlets GROUP BY restaurant_id HAVING count(*) > 1) s")):
        raise RuntimeError("Refusing to drop outlet_id: a restaurant has more than one outlet. Roll back the code only.")
    for t in reversed(TABLES):
        op.execute(f"ALTER TABLE {t} DROP CONSTRAINT IF EXISTS fk_{t}_outlet")
        op.drop_index(op.f(f'ix_{t}_outlet_id'), table_name=t)
        op.drop_column(t, 'outlet_id')
