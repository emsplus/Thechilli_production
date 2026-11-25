"""hardening: refunds receipts/kinds, unallocated ledger, webhook dedupe, TRUNCATE guards

0001 builds tables from the live models (create_all), so on a fresh database these statements are mostly no-ops;
on a database created by the original 0001 they bring it up to date. Every statement is idempotent.
"""
from alembic import op
from app.ddl import REVOKE_SQL, TRUNCATE_GUARD_SQL

revision = "0002"
down_revision = "0001"

SCHEMA_SQL = """
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS receipt VARCHAR(40);
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'intent';
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS provider_payment_id VARCHAR(64);
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_kind_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_kind_check CHECK (kind IN ('intent','unallocated'));

ALTER TABLE ledger_entries ALTER COLUMN entry_type TYPE VARCHAR(24);
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_entry_type_check
  CHECK (entry_type IN ('payment','refund','unallocated','unallocated_refund'));

ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS body_hash VARCHAR(64);
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_provider_account_id_body_hash_key;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_provider_account_id_body_hash_key
  UNIQUE (provider_account_id, body_hash);

CREATE INDEX IF NOT EXISTS ix_audit_tenant_action_created ON audit_log (tenant_id, action, created_at);
"""


def upgrade():
    op.execute(SCHEMA_SQL)
    op.execute(TRUNCATE_GUARD_SQL)
    op.execute(REVOKE_SQL)


def downgrade():
    op.execute("DROP TRIGGER IF EXISTS ledger_entries_no_truncate ON ledger_entries")
    op.execute("DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log")
