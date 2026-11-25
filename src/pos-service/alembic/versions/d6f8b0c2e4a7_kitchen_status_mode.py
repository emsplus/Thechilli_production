"""KOT-only kitchen mode (docs/KOT_ONLY_KITCHEN.md): restaurants.kitchen_status_mode and kot_tickets.done_at.

* restaurants.kitchen_status_mode ('kot_only' | 'track', CHECK, default 'kot_only'): the owner setting "Kitchen status tracking".
  'kot_only' = the kitchen just receives the ticket and taps Done (no Preparing / Ready / Served steps); 'track' = the full workflow.
  The server default makes EVERY EXISTING restaurant KOT-only (owner decision 2026-11-02); switch one back with
  PUT /restaurant {"kitchen_status_mode": "track"} or Manage > Restaurant > Kitchen.
* restaurants.kitchen_display_minutes (5..120, CHECK, default 20): KOT-only kitchen screen shows a ticket for this long after it arrived
  (nobody clicks in the kitchen); older tickets move to "Earlier tickets" by themselves. Existing restaurants get 20.
* kot_tickets.done_at (timestamptz, null): the single "kitchen is done" flag. Backfilled from updated_at for tickets already served.

Additive: no existing row changes meaning (a ticket's status keeps working exactly as before). Fully reversible.

Revision ID: d6f8b0c2e4a7
Revises: c5e7a9b1d3f6
Create Date: 2026-11-02 16:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'd6f8b0c2e4a7'
down_revision: Union[str, Sequence[str], None] = 'c5e7a9b1d3f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("restaurants", sa.Column("kitchen_status_mode", sa.String(length=10), nullable=False, server_default="kot_only"))
    op.create_check_constraint("ck_restaurants_kitchen_status_mode", "restaurants", "kitchen_status_mode IN ('kot_only', 'track')")
    op.add_column("restaurants", sa.Column("kitchen_display_minutes", sa.Integer(), nullable=False, server_default="20"))
    op.create_check_constraint("ck_restaurants_kitchen_display_minutes", "restaurants", "kitchen_display_minutes BETWEEN 5 AND 120")
    op.add_column("kot_tickets", sa.Column("done_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE kot_tickets SET done_at = updated_at WHERE status = 'served'")


def downgrade() -> None:
    op.drop_column("kot_tickets", "done_at")
    op.drop_constraint("ck_restaurants_kitchen_display_minutes", "restaurants", type_="check")
    op.drop_column("restaurants", "kitchen_display_minutes")
    op.drop_constraint("ck_restaurants_kitchen_status_mode", "restaurants", type_="check")
    op.drop_column("restaurants", "kitchen_status_mode")
