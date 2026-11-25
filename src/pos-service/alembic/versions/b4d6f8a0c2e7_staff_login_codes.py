"""Staff wiring (docs/STAFF_WIRING_CHECK.md): restaurant login codes, staff without email (phone / username), one-time
passwords.

* restaurants.login_code: 6 characters (A-Z without O/I/L, 2-9), unique; existing restaurants get a random one here.
* users.email becomes optional; users.phone / users.username (unique per restaurant, partial indexes); at least one of the
  three is required (CHECK).
* users.must_change_password: set when the password was generated (one-time password from the owner).
* auth_find_users: case-insensitive email match.
* auth_restaurant_by_code(text): SECURITY DEFINER lookup of the tenant of a code (login runs before a tenant is bound).

Revision ID: b4d6f8a0c2e7
Revises: c4e8a1f7b2d9
Create Date: 2026-10-31 23:30:00.000000

"""
import secrets
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.core import definer

revision: str = 'b4d6f8a0c2e7'
down_revision: Union[str, Sequence[str], None] = 'c4e8a1f7b2d9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # = app.models.core.LOGIN_CODE_ALPHABET (frozen copy for this revision)


def upgrade() -> None:
    op.add_column("restaurants", sa.Column("login_code", sa.String(8), nullable=True))
    conn = op.get_bind()
    used: set[str] = set()
    for (rid,) in conn.execute(sa.text("SELECT id FROM restaurants ORDER BY created_at")).all():
        code = "".join(secrets.choice(_ALPHABET) for _ in range(6))
        while code in used:
            code = "".join(secrets.choice(_ALPHABET) for _ in range(6))
        used.add(code)
        conn.execute(sa.text("UPDATE restaurants SET login_code = :c WHERE id = :i"), {"c": code, "i": rid})
    op.alter_column("restaurants", "login_code", nullable=False)
    op.create_unique_constraint("restaurants_login_code_key", "restaurants", ["login_code"])

    op.alter_column("users", "email", nullable=True)
    op.add_column("users", sa.Column("phone", sa.String(20), nullable=True))
    op.add_column("users", sa.Column("username", sa.String(40), nullable=True))
    op.add_column("users", sa.Column("must_change_password", sa.Boolean(), server_default=sa.text("false"), nullable=False))
    op.create_index("uq_users_restaurant_phone", "users", ["restaurant_id", "phone"], unique=True,
                    postgresql_where=sa.text("phone IS NOT NULL"))
    op.create_index("uq_users_restaurant_username", "users", ["restaurant_id", "username"], unique=True,
                    postgresql_where=sa.text("username IS NOT NULL"))
    op.create_check_constraint("ck_users_has_identifier", "users",
                               "email IS NOT NULL OR phone IS NOT NULL OR username IS NOT NULL")

    op.execute(definer.FUNCTIONS["auth_find_users"][1])  # email sign-in becomes case-insensitive (staff emails are stored lower-case)
    args, sql = definer.FUNCTIONS["auth_restaurant_by_code"]
    op.execute(sql)
    op.execute(f"REVOKE ALL ON FUNCTION auth_restaurant_by_code({args}) FROM PUBLIC")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS auth_restaurant_by_code(text)")
    op.drop_constraint("ck_users_has_identifier", "users", type_="check")
    op.drop_index("uq_users_restaurant_username", table_name="users")
    op.drop_index("uq_users_restaurant_phone", table_name="users")
    op.drop_column("users", "must_change_password")
    op.drop_column("users", "username")
    op.drop_column("users", "phone")
    # staff without email cannot exist before this revision: give them an unroutable placeholder (rows are referenced by orders)
    op.execute("UPDATE users SET email = 'staff-' || id || '@no-email.invalid' WHERE email IS NULL")
    op.alter_column("users", "email", nullable=False)
    op.drop_constraint("restaurants_login_code_key", "restaurants", type_="unique")
    op.drop_column("restaurants", "login_code")
