"""abuse counters (hub pairing, restaurant registration), claim_hub_pairing also returns the outlet, print sweep lookup

Creates abuse_counters (generic DB-backed counters, no RLS: the caller is unauthenticated; same class as login_attempts) and replaces the
claim_hub_pairing SECURITY DEFINER function (its return type gains outlet_id, so it is dropped and recreated).

Revision ID: b9e1c3d5f7a2
Revises: a8d3e5f7b9c1
Create Date: 2026-10-30 09:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.core import definer


revision: str = 'b9e1c3d5f7a2'
down_revision: Union[str, Sequence[str], None] = 'a8d3e5f7b9c1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'abuse_counters',
        sa.Column('key', sa.String(length=100), nullable=False),
        sa.Column('failures', sa.Integer(), nullable=False),
        sa.Column('window_start', sa.DateTime(timezone=True), nullable=False),
        sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('key'),
    )
    op.create_index('ix_print_jobs_open', 'print_jobs', ['status', 'created_at'],
                    postgresql_where=sa.text("status IN ('queued', 'sent')"))
    args, sql = definer.FUNCTIONS["print_sweep_tenants"]
    op.execute(sql)
    op.execute(f"REVOKE ALL ON FUNCTION print_sweep_tenants({args}) FROM PUBLIC")
    args, sql = definer.FUNCTIONS["claim_hub_pairing"]
    op.execute(f"DROP FUNCTION IF EXISTS claim_hub_pairing({args})")
    op.execute(sql)
    op.execute(f"REVOKE ALL ON FUNCTION claim_hub_pairing({args}) FROM PUBLIC")


def downgrade() -> None:
    op.drop_table('abuse_counters')
    op.drop_index('ix_print_jobs_open', table_name='print_jobs')
    op.execute("DROP FUNCTION IF EXISTS print_sweep_tenants(timestamp with time zone, timestamp with time zone)")
    # claim_hub_pairing keeps its wider return type: callers that read only (tenant_id, created_by) are unaffected.
