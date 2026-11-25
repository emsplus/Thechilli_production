"""activation status columns, application documents, invitation deliveries

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("onboarding_applications", sa.Column("platform_status", sa.String(24), nullable=True))
    op.add_column("onboarding_applications", sa.Column("billing_status", sa.String(24), nullable=True))
    op.add_column("onboarding_applications", sa.Column("status_checked_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "application_documents",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("application_id", sa.Uuid(), sa.ForeignKey("onboarding_applications.id"), nullable=False),
        sa.Column("doc_type", sa.String(32), nullable=False),
        sa.Column("filename", sa.String(200), nullable=False),
        sa.Column("content_type", sa.String(60), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("storage_key", sa.String(200), nullable=False, unique=True),
        sa.Column("status", sa.Enum("received", "verified", "rejected", name="docstatus", native_enum=False, length=32), nullable=False),
        sa.Column("uploaded_by", sa.Uuid(), sa.ForeignKey("marketing_users.id"), nullable=False),
        sa.Column("decided_by", sa.Uuid(), sa.ForeignKey("marketing_users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_application_documents_application_id", "application_documents", ["application_id"])
    op.create_table(
        "invitation_deliveries",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("invitation_id", sa.Uuid(), sa.ForeignKey("signup_invitations.id"), nullable=False),
        sa.Column("channel", sa.String(16), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("provider_message_id", sa.String(120), nullable=True),
        sa.Column("status", sa.Enum("sent", "failed", name="deliverystatus", native_enum=False, length=32), nullable=False),
        sa.Column("error", sa.String(300), nullable=True),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("marketing_users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_invitation_deliveries_invitation_id", "invitation_deliveries", ["invitation_id"])


def downgrade() -> None:
    op.drop_table("invitation_deliveries")
    op.drop_table("application_documents")
    for c in ("status_checked_at", "billing_status", "platform_status"):
        op.drop_column("onboarding_applications", c)
