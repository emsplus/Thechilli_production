"""security review finding 4: login_attempts.ip (throttle per (email, IP), per IP and per email)

Revision ID: 5ec1a0b1c2d4
Revises: 5ec1a0b1c2d3
Create Date: 2026-10-31 20:10:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '5ec1a0b1c2d4'
down_revision: Union[str, Sequence[str], None] = '5ec1a0b1c2d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('login_attempts', sa.Column('ip', sa.String(length=64), nullable=True))
    op.create_index('ix_login_attempts_ip_created', 'login_attempts', ['ip', 'created_at'])


def downgrade() -> None:
    op.drop_index('ix_login_attempts_ip_created', table_name='login_attempts')
    op.drop_column('login_attempts', 'ip')
