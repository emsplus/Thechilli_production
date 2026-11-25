"""pay-as-you-go wallet: billing settings, wallets, append-only ledger + usage events, receipts, top-up orders, billing outbox
(docs/PAYG_BILLING.md). Existing tenants get a wallet whose 7-day trial (PAYG_TRIAL_DAYS at upgrade time) starts NOW.

Revision ID: 0005
Revises: 0004
"""
import os

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB(astext_type=sa.Text())
TS = sa.DateTime(timezone=True)
APPEND_ONLY = ("wallet_ledger", "billing_usage_events")


def upgrade() -> None:
    op.create_table(
        'billing_settings',
        sa.Column('id', UUID, primary_key=True),
        sa.Column('plan_id', UUID, sa.ForeignKey('plans.id'), unique=True),
        sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), unique=True),
        sa.Column('billing_model', sa.String(12)),
        sa.Column('trial_days', sa.Integer()),
        sa.Column('per_bill_paise', sa.Integer()),
        sa.Column('fee_gst_mode', sa.String(10)),
        sa.Column('charge_zero_bills', sa.Boolean()),
        sa.Column('low_balance_paise', sa.BigInteger()),
        sa.Column('grace_paise', sa.BigInteger()),
        sa.Column('min_topup_paise', sa.BigInteger()),
        sa.Column('bonus_tiers', JSONB),
        sa.Column('updated_by', sa.String(100)),
        sa.Column('updated_at', TS),
        sa.CheckConstraint("(plan_id is null) <> (tenant_id is null)", name="ck_bset_scope"),
        sa.CheckConstraint("billing_model is null or billing_model in ('payg','subscription')", name="ck_bset_model"),
        sa.CheckConstraint("fee_gst_mode is null or fee_gst_mode in ('inclusive','exclusive')", name="ck_bset_gst"),
        sa.CheckConstraint("trial_days is null or trial_days between 0 and 365", name="ck_bset_trial"),
        sa.CheckConstraint("(per_bill_paise is null or per_bill_paise >= 0) and (low_balance_paise is null or low_balance_paise >= 0)"
                           " and (grace_paise is null or grace_paise >= 0) and (min_topup_paise is null or min_topup_paise >= 0)",
                           name="ck_bset_nonneg"),
    )
    op.create_table(
        'wallets',
        sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), primary_key=True),
        sa.Column('balance_paise', sa.BigInteger(), server_default='0', nullable=False),
        sa.Column('trial_started_at', TS, nullable=False),
        sa.Column('trial_ends_at', TS, nullable=False),
        sa.Column('suspended_at', TS),
        sa.Column('suspended_reason', sa.Text()),
        sa.Column('last_state', sa.String(12)),
        sa.Column('created_at', TS),
        sa.Column('updated_at', TS),
    )
    op.create_table(
        'wallet_ledger',
        sa.Column('id', sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column('tenant_id', UUID, nullable=False),
        sa.Column('kind', sa.String(20), nullable=False),
        sa.Column('amount_paise', sa.BigInteger(), nullable=False),
        sa.Column('balance_after_paise', sa.BigInteger(), nullable=False),
        sa.Column('idem_key', sa.String(120), nullable=False),
        sa.Column('source', sa.String(16), nullable=False),
        sa.Column('ref_type', sa.String(24)),
        sa.Column('ref_id', sa.String(64)),
        sa.Column('fee_base_paise', sa.BigInteger()),
        sa.Column('fee_gst_paise', sa.BigInteger()),
        sa.Column('reason', sa.Text()),
        sa.Column('actor', sa.String(100), nullable=False),
        sa.Column('meta', JSONB),
        sa.Column('at', TS),
        sa.UniqueConstraint('tenant_id', 'idem_key', name='uq_wallet_ledger_idem'),
        sa.CheckConstraint("kind in ('topup','bill_fee','void_credit_back','adjustment','promo')", name="ck_wl_kind"),
        sa.CheckConstraint("amount_paise <> 0", name="ck_wl_nonzero"),
        sa.CheckConstraint("(kind = 'bill_fee' and amount_paise < 0) or (kind in ('topup','promo','void_credit_back') and amount_paise > 0)"
                           " or kind = 'adjustment'", name="ck_wl_sign"),
    )
    op.create_index('ix_wallet_ledger_tenant_id', 'wallet_ledger', ['tenant_id'])
    op.create_index('ix_wallet_ledger_at', 'wallet_ledger', ['at'])
    op.create_index('ix_wallet_ledger_tenant_at', 'wallet_ledger', ['tenant_id', 'at', 'id'])
    op.create_table(
        'billing_usage_events',
        sa.Column('id', sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column('tenant_id', UUID, nullable=False),
        sa.Column('bill_id', sa.String(64), nullable=False),
        sa.Column('event', sa.String(10), nullable=False),
        sa.Column('outlet_id', sa.String(64)),
        sa.Column('invoice_number', sa.String(40)),
        sa.Column('bill_total_paise', sa.BigInteger(), nullable=False),
        sa.Column('occurred_at', TS, nullable=False),
        sa.Column('offline', sa.Boolean(), nullable=False),
        sa.Column('outcome', sa.String(24), nullable=False),
        sa.Column('charged_paise', sa.BigInteger(), nullable=False),
        sa.Column('ledger_id', sa.BigInteger()),
        sa.Column('source', sa.String(48), nullable=False),
        sa.Column('received_at', TS),
        sa.UniqueConstraint('tenant_id', 'bill_id', 'event', name='uq_usage_bill_event'),
        sa.CheckConstraint("event in ('finalized','voided')", name="ck_usage_event"),
        sa.CheckConstraint("charged_paise >= 0", name="ck_usage_charged"),
    )
    op.create_index('ix_billing_usage_events_tenant_id', 'billing_usage_events', ['tenant_id'])
    op.create_index('ix_billing_usage_events_received_at', 'billing_usage_events', ['received_at'])
    op.create_index('ix_usage_tenant_occurred', 'billing_usage_events', ['tenant_id', 'occurred_at'])
    op.execute("CREATE SEQUENCE wallet_receipt_seq START 1")
    op.create_table(
        'wallet_receipts',
        sa.Column('id', UUID, primary_key=True),
        sa.Column('number', sa.String(40), unique=True, nullable=False),
        sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
        sa.Column('source', sa.String(16), nullable=False),
        sa.Column('amount_paise', sa.BigInteger(), nullable=False),
        sa.Column('bonus_paise', sa.BigInteger(), nullable=False),
        sa.Column('gst_mode', sa.String(10), nullable=False),
        sa.Column('taxable_paise', sa.BigInteger(), nullable=False),
        sa.Column('gst_rate_bps', sa.Integer(), nullable=False),
        sa.Column('cgst_paise', sa.BigInteger(), nullable=False),
        sa.Column('sgst_paise', sa.BigInteger(), nullable=False),
        sa.Column('igst_paise', sa.BigInteger(), nullable=False),
        sa.Column('sac_code', sa.String(8), nullable=False),
        sa.Column('supplier_gstin', sa.String(15)),
        sa.Column('supplier_state_code', sa.String(2), nullable=False),
        sa.Column('buyer_gstin', sa.String(15)),
        sa.Column('buyer_state_code', sa.String(2)),
        sa.Column('tax_needs_ca_verification', sa.Boolean(), nullable=False),
        sa.Column('payment_ref', sa.String(100)),
        sa.Column('ledger_id', sa.BigInteger(), nullable=False),
        sa.Column('note', sa.Text()),
        sa.Column('created_by', sa.String(100), nullable=False),
        sa.Column('created_at', TS),
        sa.CheckConstraint("amount_paise > 0 and bonus_paise >= 0", name="ck_receipt_amount"),
    )
    op.create_index('ix_wallet_receipts_tenant_id', 'wallet_receipts', ['tenant_id'])
    op.create_table(
        'wallet_topup_orders',
        sa.Column('id', UUID, primary_key=True),
        sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
        sa.Column('provider', sa.String(16), nullable=False),
        sa.Column('amount_paise', sa.BigInteger(), nullable=False),
        sa.Column('bonus_paise', sa.BigInteger(), nullable=False),
        sa.Column('status', sa.String(12), nullable=False),
        sa.Column('provider_order_id', sa.String(100), unique=True),
        sa.Column('provider_payment_id', sa.String(100), unique=True),
        sa.Column('receipt_id', UUID, sa.ForeignKey('wallet_receipts.id')),
        sa.Column('requested_by', sa.String(100), nullable=False),
        sa.Column('raw', JSONB),
        sa.Column('created_at', TS),
        sa.Column('paid_at', TS),
        sa.CheckConstraint("amount_paise > 0", name="ck_topup_amount"),
        sa.CheckConstraint("status in ('created','paid','failed','expired')", name="ck_topup_status"),
    )
    op.create_index('ix_wallet_topup_orders_tenant_id', 'wallet_topup_orders', ['tenant_id'])
    op.create_table(
        'billing_outbox',
        sa.Column('id', sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column('tenant_id', UUID, nullable=False),
        sa.Column('event_type', sa.String(32), nullable=False),
        sa.Column('kind', sa.String(32), nullable=False),
        sa.Column('dedupe_key', sa.String(120), nullable=False),
        sa.Column('payload', JSONB, nullable=False),
        sa.Column('status', sa.String(8), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False),
        sa.Column('lease_until', TS),
        sa.Column('sent_at', TS),
        sa.Column('created_at', TS),
        sa.UniqueConstraint('tenant_id', 'dedupe_key', name='uq_billing_outbox_dedupe'),
        sa.CheckConstraint("status in ('pending','sent','dead')", name="ck_billing_outbox_status"),
    )
    op.create_index('ix_billing_outbox_tenant_id', 'billing_outbox', ['tenant_id'])
    op.create_index('ix_billing_outbox_pending', 'billing_outbox', ['status', 'created_at'])
    for t in APPEND_ONLY:
        op.execute(f"CREATE TRIGGER {t}_append_only BEFORE UPDATE OR DELETE ON {t} FOR EACH ROW EXECUTE FUNCTION forbid_mutation()")
    # Existing tenants: a fresh trial from the upgrade (owner to confirm, docs/PAYG_BILLING.md "Rollout").
    days = int(os.environ.get("PAYG_TRIAL_DAYS", "7"))
    op.execute(sa.text("INSERT INTO wallets (tenant_id, balance_paise, trial_started_at, trial_ends_at, created_at, updated_at) "
                       "SELECT id, 0, now(), now() + make_interval(days => :d), now(), now() FROM tenants "
                       "ON CONFLICT DO NOTHING").bindparams(d=days))


def downgrade() -> None:
    for t in ("billing_outbox", "wallet_topup_orders", "wallet_receipts", "billing_usage_events", "wallet_ledger", "wallets",
              "billing_settings"):
        op.drop_table(t)
    op.execute("DROP SEQUENCE IF EXISTS wallet_receipt_seq")
