"""PR 5b (docs/PHASE1_PLAN.md, docs/OUTLETS.md): contract. Re-runs the idempotent backfill (catches rows written between 5a and
the code deploy), VALIDATEs the composite FKs and makes outlet_id NOT NULL. Ship this revision only after the code that writes
outlet_id (PR 5a) is deployed everywhere: an older API replica would fail inserts afterwards.

Downgrade relaxes NOT NULL again (always safe).

Revision ID: c6f3e4a5b7d8
Revises: b5e2d3f4a6c7
Create Date: 2026-10-29 22:30:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op



revision: str = 'c6f3e4a5b7d8'
down_revision: Union[str, Sequence[str], None] = 'b5e2d3f4a6c7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLES = ("devices", "dining_tables", "orders", "kot_tickets", "bills", "payments", "refunds",
          "printers", "print_hubs", "hub_pairings", "print_jobs")


def backfill(bind) -> None:  # same statement as 5a (a revision never imports another)
    for t in TABLES:
        before = bind.scalar(sa.text(f"SELECT count(*) FROM {t} WHERE outlet_id IS NULL"))
        bind.execute(sa.text(
            f"UPDATE {t} x SET outlet_id = o.id FROM outlets o "
            f"WHERE o.restaurant_id = x.restaurant_id AND o.is_default AND x.outlet_id IS NULL"))
        after = bind.scalar(sa.text(f"SELECT count(*) FROM {t} WHERE outlet_id IS NULL"))
        print(f"outlet_id backfill {t}: null before={before} after={after}")


def upgrade() -> None:
    bind = op.get_bind()
    backfill(bind)
    for t in TABLES:
        op.execute(f"ALTER TABLE {t} VALIDATE CONSTRAINT fk_{t}_outlet")
        # NOT NULL through a validated CHECK first: PG12+ then skips the full-table scan
        op.execute(f"ALTER TABLE {t} ADD CONSTRAINT {t}_outlet_nn CHECK (outlet_id IS NOT NULL) NOT VALID")
        op.execute(f"ALTER TABLE {t} VALIDATE CONSTRAINT {t}_outlet_nn")
        op.alter_column(t, 'outlet_id', nullable=False)
        op.execute(f"ALTER TABLE {t} DROP CONSTRAINT {t}_outlet_nn")


def downgrade() -> None:
    for t in TABLES:
        op.alter_column(t, 'outlet_id', nullable=True)
