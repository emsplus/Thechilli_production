APPEND_ONLY_SQL = """
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
"""

# TRUNCATE bypasses row triggers, so it needs its own statement-level BEFORE TRUNCATE trigger (also fires when a
# TRUNCATE ... CASCADE on payment_intents reaches these tables). Idempotent: safe to re-run.
TRUNCATE_GUARD_SQL = """
DROP TRIGGER IF EXISTS ledger_entries_no_truncate ON ledger_entries;
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
"""

# Defence in depth: the application's runtime DB role (named payments_app; if it does not exist yet this is a no-op,
# re-run after creating it) can only INSERT/SELECT on the append-only tables. Table owners/superusers are not
# affected by REVOKE, which is why the triggers above are the primary control.
REVOKE_SQL = """
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries, audit_log FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payments_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries, audit_log FROM payments_app;
  END IF;
END $$;
"""
