"""initial schema (v1 tables: those without info["revision"])"""
from alembic import op
from app import models

revision = "0001"
down_revision = None


def upgrade():
    bind = op.get_bind()
    tables = [t for t in models.Base.metadata.sorted_tables if not t.info.get("revision")]
    models.Base.metadata.create_all(bind, tables=tables)


def downgrade():
    bind = op.get_bind()
    models.Base.metadata.drop_all(bind, tables=[t for t in models.Base.metadata.sorted_tables
                                                if not t.info.get("revision")])
