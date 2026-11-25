"""security review findings 9 and 11: bills.receipt_link_gen (revocable public receipt links), users.sessions_valid_after
(access tokens die with a password reset / deactivation)

Revision ID: 5ec1a0b1c2d6
Revises: 5ec1a0b1c2d5
Create Date: 2026-10-31 20:30:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '5ec1a0b1c2d6'
down_revision: Union[str, Sequence[str], None] = '5ec1a0b1c2d5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('bills', sa.Column('receipt_link_gen', sa.Integer(), server_default='0', nullable=False))
    op.add_column('users', sa.Column('sessions_valid_after', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'sessions_valid_after')
    op.drop_column('bills', 'receipt_link_gen')
