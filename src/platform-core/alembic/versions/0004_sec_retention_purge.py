"""security review finding 14: retention purge of login / security tables

audit_log and security_events stay append-only (UPDATE and DELETE are refused by the forbid_mutation trigger), with ONE
exception: a DELETE of a row older than 90 days inside a transaction that set app.retention_purge = 'on' (the retention job,
app/services/retention.py). Nothing can rewrite or delete a recent row, so the purge cannot be used to hide fresh tracks.

Revision ID: sec0004
Revises: 0003
"""
from alembic import op

revision = 'sec0004'
down_revision = '0003'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('audit_log', 'security_events')
             AND current_setting('app.retention_purge', true) = 'on' AND OLD.at < now() - interval '90 days' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
        END;
        $$ LANGUAGE plpgsql""")


def downgrade() -> None:
    op.execute("""CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END;
        $$ LANGUAGE plpgsql""")
