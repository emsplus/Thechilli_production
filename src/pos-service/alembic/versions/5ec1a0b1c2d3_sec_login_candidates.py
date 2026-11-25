"""security review finding 1: auth_login_candidates SECURITY DEFINER lookup (login checks the password per account first)

Revision ID: 5ec1a0b1c2d3
Revises: 7c3e9a1f5b2d
Create Date: 2026-10-31 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

from app.core import definer

revision: str = '5ec1a0b1c2d3'
down_revision: Union[str, Sequence[str], None] = '7c3e9a1f5b2d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    args, sql = definer.FUNCTIONS["auth_login_candidates"]
    op.execute(sql)
    op.execute(f"REVOKE ALL ON FUNCTION auth_login_candidates({args}) FROM PUBLIC")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS auth_login_candidates(text, uuid)")
