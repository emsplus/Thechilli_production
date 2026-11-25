"""India-first column defaults (owner decision 2026-10-31: all money is INR).

Server defaults only: restaurants / outlets country 'IN', currency 'INR', timezone 'Asia/Kolkata'; bills.country 'IN'.
NO existing row is rewritten (legacy AE / GB restaurants and every bill keep their values). Converting one restaurant is
an explicit operator step: scripts/convert_restaurant_to_india.py <restaurant_id>.

Revision ID: f1a2b3c4d5e6
Revises: e2b7c9d4f6a1
Create Date: 2026-10-31 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'e2b7c9d4f6a1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW = {
    "restaurants": {"country": "'IN'", "currency": "'INR'", "timezone": "'Asia/Kolkata'"},
    "outlets": {"country": "'IN'", "currency": "'INR'", "timezone": "'Asia/Kolkata'"},
    "bills": {"country": "'IN'"},
}
_OLD = {  # before: country 'AE', currency / timezone without a server default
    "restaurants": {"country": "'AE'", "currency": None, "timezone": None},
    "outlets": {"country": "'AE'", "currency": None, "timezone": None},
    "bills": {"country": "'AE'"},
}


def _apply(spec: dict) -> None:
    for table, cols in spec.items():
        for col, default in cols.items():
            if default is None:
                op.execute(f'ALTER TABLE {table} ALTER COLUMN {col} DROP DEFAULT')
            else:
                op.execute(f'ALTER TABLE {table} ALTER COLUMN {col} SET DEFAULT {default}')


def upgrade() -> None:
    _apply(_NEW)


def downgrade() -> None:
    _apply(_OLD)
