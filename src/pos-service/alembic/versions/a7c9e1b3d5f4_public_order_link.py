"""public ordering link: delivery_settings.public_order_enabled / public_order_url / service_token_enc

delivery-service owns the slug (docs/PUBLIC_ORDER_LINK.md there); pos-service stores only the owner's choice, a cache of the
last URL and, per tenant, the Fernet-encrypted token used to call delivery-service. delivery_settings already has RLS
(d4a6c8e0f2b1): adding columns changes no policy. Existing rows get public_order_enabled = false.

Revision ID: a7c9e1b3d5f4
Revises: f1a3c5e7b9d2
Create Date: 2026-11-01 10:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a7c9e1b3d5f4'
down_revision: Union[str, Sequence[str], None] = 'f1a3c5e7b9d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("delivery_settings", sa.Column("public_order_enabled", sa.Boolean(), server_default="false", nullable=False))
    op.add_column("delivery_settings", sa.Column("public_order_url", sa.String(500), nullable=True))
    op.add_column("delivery_settings", sa.Column("service_token_enc", sa.String(600), nullable=True))


def downgrade() -> None:
    op.drop_column("delivery_settings", "service_token_enc")
    op.drop_column("delivery_settings", "public_order_url")
    op.drop_column("delivery_settings", "public_order_enabled")
