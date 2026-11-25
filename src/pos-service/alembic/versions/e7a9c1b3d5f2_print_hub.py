"""print hub: printers, hubs, pairing codes, print jobs

New tables printers, print_hubs, hub_pairings, print_jobs (docs/print-hub-contract.md). Purely additive; the downgrade drops
them (queued jobs and printer settings are lost).

Revision ID: e7a9c1b3d5f2
Revises: d1f3a5c7e9b2
Create Date: 2026-10-28 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'e7a9c1b3d5f2'
down_revision: Union[str, Sequence[str], None] = 'd1f3a5c7e9b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        'printers',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('role', sa.String(length=10), server_default='counter', nullable=False),
        sa.Column('connection', sa.String(length=10), server_default='lan', nullable=False),
        sa.Column('host', sa.String(length=255), nullable=True),
        sa.Column('port', sa.Integer(), server_default='9100', nullable=False),
        sa.Column('system_name', sa.String(length=255), nullable=True),
        sa.Column('columns', sa.Integer(), server_default='42', nullable=False),
        sa.Column('codepage', sa.String(length=10), server_default='pc858', nullable=False),
        sa.Column('copies', sa.Integer(), server_default='1', nullable=False),
        sa.Column('cut', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('auto_bill', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('auto_kot', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('kot_category_ids', postgresql.ARRAY(UUID), server_default=sa.text("'{}'::uuid[]"), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('restaurant_id', 'name'),
    )
    op.create_index('ix_printers_restaurant_id', 'printers', ['restaurant_id'])

    op.create_table(
        'print_hubs',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('version', sa.String(length=40), nullable=True),
        sa.Column('os', sa.String(length=40), nullable=True),
        sa.Column('system_printers', sa.JSON(), nullable=True),
        sa.Column('printer_status', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token_hash'),
    )
    op.create_index('ix_print_hubs_restaurant_id', 'print_hubs', ['restaurant_id'])

    op.create_table(
        'hub_pairings',
        sa.Column('id', UUID, nullable=False),
        sa.Column('code_hash', sa.String(length=64), nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('created_by', UUID, nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_hub_pairings_code_hash', 'hub_pairings', ['code_hash'])
    op.create_index('ix_hub_pairings_restaurant_id', 'hub_pairings', ['restaurant_id'])
    op.create_index('ix_hub_pairings_created_by', 'hub_pairings', ['created_by'])

    op.create_table(
        'print_jobs',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('printer_id', UUID, nullable=False),
        sa.Column('kind', sa.String(length=10), nullable=False),
        sa.Column('ref_id', UUID, nullable=True),
        sa.Column('copy_no', sa.Integer(), server_default='1', nullable=False),
        sa.Column('reprint_no', sa.Integer(), server_default='0', nullable=False),
        sa.Column('payload', sa.LargeBinary(), nullable=False),
        sa.Column('status', sa.String(length=10), server_default='queued', nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('last_error', sa.String(length=500), nullable=True),
        sa.Column('created_by', UUID, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('printed_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['printer_id'], ['printers.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_print_jobs_restaurant_id', 'print_jobs', ['restaurant_id'])
    op.create_index('ix_print_jobs_printer_id', 'print_jobs', ['printer_id'])
    op.create_index('ix_print_jobs_ref_id', 'print_jobs', ['ref_id'])
    op.create_index('ix_print_jobs_created_by', 'print_jobs', ['created_by'])
    op.create_index('ix_print_jobs_queue', 'print_jobs', ['restaurant_id', 'status', 'created_at'])
    op.create_index('uq_print_jobs_ref', 'print_jobs', ['printer_id', 'kind', 'ref_id', 'copy_no', 'reprint_no'],
                    unique=True, postgresql_where=sa.text('ref_id IS NOT NULL'))


def downgrade() -> None:
    op.drop_table('print_jobs')
    op.drop_table('hub_pairings')
    op.drop_table('print_hubs')
    op.drop_table('printers')
