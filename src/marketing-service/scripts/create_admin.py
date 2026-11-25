"""Create the first marketing_admin:  uv run python scripts/create_admin.py admin@example.com 'Name' 'password-10+chars'"""
import sys

from app.core.db import SessionLocal
from app.core.security import hash_password
from app.models import MarketingUser, Role

if __name__ == "__main__":
    if len(sys.argv) != 4 or len(sys.argv[3]) < 10:
        sys.exit(__doc__)
    email, name, password = sys.argv[1].lower(), sys.argv[2], sys.argv[3]
    with SessionLocal() as db:
        if db.query(MarketingUser).filter_by(email=email).first():
            sys.exit("user already exists")
        db.add(MarketingUser(email=email, name=name, role=Role.marketing_admin, password_hash=hash_password(password)))
        db.commit()
    print("created", email)
