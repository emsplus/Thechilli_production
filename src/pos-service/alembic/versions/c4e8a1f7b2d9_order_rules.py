"""Order rules (docs/ORDER_RULES.md): kitchen ticket before a dine-in bill, default menu option, sold-out-today switch.

* restaurants.require_kot_before_bill (bool, default true): a dine-in order cannot be billed before every item went to the
  kitchen (409 kitchen_ticket_required; owners / managers may override with a reason).
* menu_variants.is_default (bool, default false): the option an order line gets when it names none (Half of Half/Full).
* menu_items.sold_out_on (date, null): "sold out today" in the restaurant's timezone; resets itself the next day.

Additive only: no existing row changes meaning (existing restaurants get the kitchen rule ON, which is the point of it).

Revision ID: c4e8a1f7b2d9
Revises: a7c2e9d4b1f3
Create Date: 2026-11-01 01:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c4e8a1f7b2d9'
down_revision: Union[str, Sequence[str], None] = 'a7c2e9d4b1f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("restaurants", sa.Column("require_kot_before_bill", sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("menu_variants", sa.Column("is_default", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("menu_items", sa.Column("sold_out_on", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("menu_items", "sold_out_on")
    op.drop_column("menu_variants", "is_default")
    op.drop_column("restaurants", "require_kot_before_bill")
