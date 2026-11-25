"""voice wake samples: testing-phase, text-only wake-word samples (docs/VOICE_WAKE_SAMPLES.md)

New tenant table voice_wake_samples (RLS via rls.VOICE_WAKE_TABLES, default privileges give pos_app DML as for every table the
owner role creates): the normalised text the business app heard (no audio, no IP, no digits / e-mail / URLs), matched or not,
wake word or command, device label. Index (restaurant_id, created_at) serves the 30-day variants query and the retention
delete; CHECK on kind. The endpoints are inert unless VOICE_SAMPLES_ENABLED=true.

Purely additive. Fully reversible (the downgrade drops the table; only the samples are lost).

Revision ID: b8d2f4a6c0e3
Revises: a7c9e1b3d5f4
Create Date: 2026-11-02 11:30:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import rls

revision: str = 'b8d2f4a6c0e3'
down_revision: Union[str, Sequence[str], None] = 'a7c9e1b3d5f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        'voice_wake_samples',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('device', sa.String(length=64), server_default=sa.text("''"), nullable=False),
        sa.Column('heard', sa.String(length=120), nullable=False),
        sa.Column('matched', sa.Boolean(), nullable=False),
        sa.Column('kind', sa.String(length=10), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint("kind IN ('wake', 'command')", name='ck_voice_wake_samples_kind'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_voice_wake_samples_rest_created', 'voice_wake_samples', ['restaurant_id', 'created_at'])
    rls.enable_tables(op.get_bind(), rls.VOICE_WAKE_TABLES)


def downgrade() -> None:
    rls.disable_tables(op.get_bind(), rls.VOICE_WAKE_TABLES)
    op.drop_index('ix_voice_wake_samples_rest_created', table_name='voice_wake_samples')
    op.drop_table('voice_wake_samples')
