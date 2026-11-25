"""security review finding 4: login_attempts.ip (throttle per (email, IP), per IP and per email)

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("login_attempts", sa.Column("ip", sa.String(64), nullable=True))
    op.create_index("ix_login_attempts_ip", "login_attempts", ["ip"])


def downgrade() -> None:
    op.drop_index("ix_login_attempts_ip", table_name="login_attempts")
    op.drop_column("login_attempts", "ip")
