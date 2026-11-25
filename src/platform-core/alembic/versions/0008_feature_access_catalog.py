"""Feature-access catalog: the order types, billing options and back-office modules a super admin can grant or withhold.

Adds feature flags (kind 'flag') that pos-service turns into what a restaurant sees and may do (pos-service
app/services/feature_access.py; the restaurant owner can then switch the granted ones on or off themselves):

  order.indoor / order.outdoor / order.takeaway     the order types (delivery already exists as the `delivery` feature)
  billing.discount / billing.service_charge / billing.offers   what the bill screen may use
  reports / cash_drawer / customers / expenses      back-office modules
  table_qr                                          table QR ordering (pos-service already asks for it; it was missing here)

Nothing is taken away by this revision: every NEW feature is switched ON in EVERY existing plan, so a tenant keeps exactly what
it could do before. Withholding one is a deliberate edit afterwards (super admin: Plans, or Entitlements for one tenant).
Idempotent: a feature or a plan row that already exists is left alone, so a catalog edited by staff or by the seed script is never
overwritten, and re-running changes nothing.

Revision ID: 0008
Revises: 0007
"""
import sqlalchemy as sa
from alembic import op

revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None

NEW = (
    ("order.indoor", "Dine-in (indoor) orders", "Take dine-in orders for tables inside the restaurant."),
    ("order.outdoor", "Outdoor orders", "Take orders for outdoor / garden / terrace tables."),
    ("order.takeaway", "Takeaway orders", "Take takeaway (pickup) orders at the counter."),
    ("billing.discount", "Discounts on bills", "Give a manual discount while billing."),
    ("billing.service_charge", "Service charge", "Add the restaurant's service charge to dine-in bills."),
    ("billing.offers", "Automatic offers", "Apply the offers set up in Manage > Offers while billing."),
    ("reports", "Reports", "Sales, tax, staff and stock reports."),
    ("cash_drawer", "Cash drawer", "Open and close the cash drawer with a counted float."),
    ("customers", "Customers", "Customer list, visits and loyalty."),
    ("expenses", "Expenses", "Record and scan expenses."),
    ("table_qr", "Table QR ordering", "Guests order from a QR code on the table."),
)


def upgrade() -> None:
    feat = sa.text("insert into features (code, name, description, kind, is_active) "
                   "values (:c, :n, :d, 'flag', true) on conflict (code) do nothing")
    for code, name, desc in NEW:
        op.get_bind().execute(feat, {"c": code, "n": name, "d": desc})
    codes = ", ".join("'" + c + "'" for c, _, _ in NEW)
    op.execute(f"insert into plan_features (plan_id, feature_code, enabled, limit_value) "
               f"select p.id, f.code, true, null from plans p cross join features f where f.code in ({codes}) "
               f"on conflict (plan_id, feature_code) do nothing")


def downgrade() -> None:
    # The features stay: plans, per-tenant overrides and entitlement history may reference them (same as 0004).
    pass
