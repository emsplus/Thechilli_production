"""PR 6b (docs/OUTLETS.md): contract + unique-constraint swap. Re-runs the backfill, VALIDATEs the FKs, makes outlet_id NOT NULL on
invoice_sequences / z_reports, then replaces the tenant-wide uniques with per-outlet ones (new first, then the old one is
dropped, in this one transaction):

    invoice_sequences (restaurant_id, kind, year) -> (outlet_id, kind, year)
    z_reports         (restaurant_id, number)     -> (outlet_id, number)
    kot_tickets       (restaurant_id, number)     -> (outlet_id, number)
    dining_tables     (restaurant_id, label)      -> (outlet_id, label)
    printers          (restaurant_id, name)       -> (outlet_id, name)

The old constraints are found by their column list, not by name. With exactly one outlet per restaurant (all that can exist
before this ships) the new constraints are implied by the old ones, so creating them cannot fail. Ship after the code of PR 6.
The end-of-day lock key changes from the restaurant to the outlet: run a single API replica across the deploy.

Downgrade restores the tenant-wide uniques and is REFUSED once any restaurant has a second outlet (the old uniques could be
violated); then rollback is code-only.

Revision ID: e8b5a6c7d9f0
Revises: d7a4f5b6c8e9
Create Date: 2026-10-29 23:30:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = 'e8b5a6c7d9f0'
down_revision: Union[str, Sequence[str], None] = 'd7a4f5b6c8e9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COUNTER_TABLES = ("invoice_sequences", "z_reports")
# table -> (old unique columns, new unique columns)
SWAPS = {
    "invoice_sequences": (("restaurant_id", "kind", "year"), ("outlet_id", "kind", "year")),
    "z_reports": (("restaurant_id", "number"), ("outlet_id", "number")),
    "kot_tickets": (("restaurant_id", "number"), ("outlet_id", "number")),
    "dining_tables": (("restaurant_id", "label"), ("outlet_id", "label")),
    "printers": (("restaurant_id", "name"), ("outlet_id", "name")),
}


def _unique_names(bind, table: str, cols: tuple[str, ...]) -> list[str]:
    rows = bind.execute(sa.text(
        "SELECT c.conname, array_agg(a.attname::text ORDER BY a.attname) AS cols FROM pg_constraint c "
        "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) "
        "WHERE c.contype = 'u' AND c.conrelid = CAST(:t AS regclass) GROUP BY c.conname"), {"t": table}).all()
    return [r.conname for r in rows if sorted(r.cols) == sorted(cols)]


def _backfill(bind) -> None:
    for t in COUNTER_TABLES:
        bind.execute(sa.text(
            f"UPDATE {t} x SET outlet_id = o.id FROM outlets o "
            f"WHERE o.restaurant_id = x.restaurant_id AND o.is_default AND x.outlet_id IS NULL"))
        print(f"outlet_id backfill {t}: null left={bind.scalar(sa.text(f'SELECT count(*) FROM {t} WHERE outlet_id IS NULL'))}")


def upgrade() -> None:
    bind = op.get_bind()
    _backfill(bind)
    for t in COUNTER_TABLES:
        op.execute(f"ALTER TABLE {t} VALIDATE CONSTRAINT fk_{t}_outlet")
        op.execute(f"ALTER TABLE {t} ADD CONSTRAINT {t}_outlet_nn CHECK (outlet_id IS NOT NULL) NOT VALID")
        op.execute(f"ALTER TABLE {t} VALIDATE CONSTRAINT {t}_outlet_nn")
        op.alter_column(t, 'outlet_id', nullable=False)
        op.execute(f"ALTER TABLE {t} DROP CONSTRAINT {t}_outlet_nn")
    for t, (old, new) in SWAPS.items():
        old_names = _unique_names(bind, t, old)
        if not old_names:
            raise RuntimeError(f"unique constraint on {t}({', '.join(old)}) not found; refusing to guess")
        op.create_unique_constraint(f"{t}_{'_'.join(new)}_key", t, list(new))  # new first ...
        for n in old_names:  # ... then drop the old one
            op.drop_constraint(n, t, type_='unique')


def downgrade() -> None:
    bind = op.get_bind()
    if bind.scalar(sa.text("SELECT count(*) FROM (SELECT restaurant_id FROM outlets GROUP BY restaurant_id HAVING count(*) > 1) s")):
        raise RuntimeError("Refusing to restore tenant-wide uniques: a restaurant has more than one outlet. Roll back the code only.")
    for t, (old, new) in SWAPS.items():
        op.create_unique_constraint(f"{t}_{'_'.join(old)}_key", t, list(old))
        for n in _unique_names(bind, t, new):
            op.drop_constraint(n, t, type_='unique')
    for t in COUNTER_TABLES:
        op.alter_column(t, 'outlet_id', nullable=True)
