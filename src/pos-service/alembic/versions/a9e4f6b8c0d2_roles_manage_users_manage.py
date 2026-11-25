"""roles.manage and users.manage permissions (docs/ROLES_API.md): refresh the seeded owner role rows.

Permissions are code constants; the only database effect is re-seeding the system role_permissions rows (owner gains the two
new permissions). Idempotent. Downgrade re-seeds from the code as it is (a no-op for the new names on old code).

Revision ID: a9e4f6b8c0d2
Revises: c4d8e2a6f0b3
Create Date: 2026-10-30 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

from app.core import permissions


revision: str = 'a9e4f6b8c0d2'
down_revision: Union[str, Sequence[str], None] = 'c4d8e2a6f0b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    permissions.seed_system_roles(op.get_bind())


def downgrade() -> None:
    permissions.seed_system_roles(op.get_bind())
