"""Bootstrap the first super_admin:  python scripts/create_super_admin.py you@example.com "Your Name"   (prompts for password)."""
import getpass
import sys

sys.path.insert(0, ".")
from sqlalchemy import select  # noqa: E402

from app.api.auth import check_password_policy  # noqa: E402
from app.core.db import SessionLocal  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models import StaffUser  # noqa: E402
from app.services.audit import audit  # noqa: E402

email, name = sys.argv[1].lower(), sys.argv[2]
pw = getpass.getpass("Password: ")
check_password_policy(pw)
with SessionLocal() as db:
    if db.scalar(select(StaffUser).where(StaffUser.email == email)):
        sys.exit("already exists")
    u = StaffUser(email=email, name=name, role="super_admin", password_hash=hash_password(pw))
    db.add(u)
    db.flush()
    audit(db, None, "staff.bootstrap_super_admin", "staff_user", u.id, after={"email": email})
    db.commit()
print("created", email)
