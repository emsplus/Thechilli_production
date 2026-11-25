"""voice ordering hardening: idempotent commits, transcript retention, daily usage caps

New tenant tables (RLS enabled): voice_commits (client op id -> order / KOT), voice_transcripts (text only, purged after
VOICE_TRANSCRIPT_RETENTION_DAYS), voice_usage (per restaurant per day request count and estimated cost).
New SECURITY DEFINER function voice_purge_transcripts(timestamptz).

Revision ID: c7a9e1b3d5f8
Revises: 7a2e9c4b1d60
Create Date: 2026-10-30 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import definer, rls

revision: str = 'c7a9e1b3d5f8'
down_revision: Union[str, Sequence[str], None] = '7a2e9c4b1d60'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("voice_commits", "voice_transcripts", "voice_usage")


def upgrade() -> None:
    uuid_ = postgresql.UUID(as_uuid=True)
    now = sa.text('now()')
    op.create_table(
        'voice_commits',
        sa.Column('id', uuid_, nullable=False),
        sa.Column('restaurant_id', uuid_, nullable=False),
        sa.Column('op_id', uuid_, nullable=False),
        sa.Column('order_id', uuid_, nullable=False),
        sa.Column('kot_id', uuid_, nullable=True),
        sa.Column('user_id', uuid_, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=now, nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=now, nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['order_id'], ['orders.id']),
        sa.ForeignKeyConstraint(['kot_id'], ['kot_tickets.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('restaurant_id', 'op_id'),
    )
    op.create_table(
        'voice_transcripts',
        sa.Column('id', uuid_, nullable=False),
        sa.Column('restaurant_id', uuid_, nullable=False),
        sa.Column('user_id', uuid_, nullable=True),
        sa.Column('source', sa.String(length=10), nullable=False),
        sa.Column('transcript', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=now, nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_voice_transcripts_created_at', 'voice_transcripts', ['created_at'])
    op.create_table(
        'voice_usage',
        sa.Column('restaurant_id', uuid_, nullable=False),
        sa.Column('day', sa.Date(), nullable=False),
        sa.Column('requests', sa.Integer(), server_default='0', nullable=False),
        sa.Column('cost_micros', sa.Integer(), server_default='0', nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.PrimaryKeyConstraint('restaurant_id', 'day'),
    )
    for t, cols in (('voice_commits', ('restaurant_id', 'order_id', 'kot_id', 'user_id')), ('voice_transcripts', ('restaurant_id', 'user_id'))):
        for c in cols:
            op.create_index(f'ix_{t}_{c}', t, [c])
    rls.enable_tables(op.get_bind(), TABLES)
    args, sql = definer.FUNCTIONS["voice_purge_transcripts"]
    op.execute(sql)
    op.execute(f"REVOKE ALL ON FUNCTION voice_purge_transcripts({args}) FROM PUBLIC")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS voice_purge_transcripts(timestamp with time zone)")
    rls.disable_tables(op.get_bind(), TABLES)
    op.drop_table('voice_usage')
    op.drop_index('ix_voice_transcripts_created_at', table_name='voice_transcripts')
    op.drop_table('voice_transcripts')
    op.drop_table('voice_commits')
