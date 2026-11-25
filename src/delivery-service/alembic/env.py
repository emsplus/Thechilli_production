from sqlalchemy import create_engine, text

from alembic import context
from app import models  # noqa: F401
from app.core.config import settings
from app.core.db import Base

target_metadata = Base.metadata


def run():
    # Owner/migrator connection (not the RLS-filtered app role).
    engine = create_engine(settings.admin_database_url or settings.database_url)
    with engine.begin() as conn:  # SET ROLE autobegins a transaction alembic treats as external: connect() rolled it all back
        if settings.migration_role:
            assert settings.migration_role.replace("_", "").isalnum()
            conn.execute(text(f"SET ROLE {settings.migration_role}"))
        context.configure(connection=conn, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


run()
