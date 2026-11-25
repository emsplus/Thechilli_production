"""tenant-scoped unique constraints (no cross-tenant collisions on outlet/item/order/payout ids)

Revision ID: 0002
Revises: 0001
"""
from alembic import op

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None

# (table, old constraint name, old columns, new columns)
CHANGES = [
    ("store_mappings", "store_mappings_outlet_id_provider_key", ["outlet_id", "provider"],
     ["tenant_id", "outlet_id", "provider"]),
    ("menu_mappings", "menu_mappings_outlet_id_provider_external_item_id_key",
     ["outlet_id", "provider", "external_item_id"], ["tenant_id", "outlet_id", "provider", "external_item_id"]),
    ("orders", "orders_provider_external_order_id_key", ["provider", "external_order_id"],
     ["tenant_id", "provider", "external_order_id"]),
    ("payouts", "payouts_provider_external_payout_id_key", ["provider", "external_payout_id"],
     ["tenant_id", "provider", "external_payout_id"]),
]


def upgrade() -> None:
    for table, old, _, new in CHANGES:
        op.drop_constraint(old, table, type_="unique")
        op.create_unique_constraint(None, table, new)
    # job idempotency keys are now "<tenant>:<key>"
    op.execute("UPDATE outbound_jobs SET idempotency_key = tenant_id || ':' || idempotency_key")


def downgrade() -> None:
    op.execute("UPDATE outbound_jobs SET idempotency_key = substr(idempotency_key, length(tenant_id) + 2)")
    for table, old, cols, new in CHANGES:
        op.drop_constraint(f"{table}_{'_'.join(new)}_key", table, type_="unique")
        op.create_unique_constraint(old, table, cols)
