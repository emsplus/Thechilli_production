#!/usr/bin/env python3
"""Reset a user's password from the command line (for an owner who forgot theirs and cannot ask anyone else).

Run from apps/api so `app` is importable and DATABASE_URL points at the right database:

    uv run python scripts/reset_password.py --email owner@example.ae [--restaurant-id <uuid>]

The new password is prompted for without echo (min 10 characters). The script sets the new hash, revokes every
refresh token of the user, clears the login throttle for the email and writes a `user.password_reset` audit entry.
"""
import argparse
import getpass
import sys
import uuid

MIN_LEN = 10


def reset(email: str, new_password: str, restaurant_id: uuid.UUID | None = None, db=None) -> str:
    """Returns a human message; raises SystemExit(1) on a user error. Commits on success."""
    from sqlalchemy import delete, select, text, update, func
    from app.core.tenancy import bind_tenant
    from app.core.db import SessionLocal
    from app.core.security import hash_password
    from app.models.core import AuditLog, LoginAttempt, RefreshToken, User
    from app.services.accounts import throttle_key

    if len(new_password) < MIN_LEN:
        raise SystemExit(f"Password must be at least {MIN_LEN} characters.")
    own = db is None
    db = db or SessionLocal()
    try:
        # Row Level Security: the app role sees nothing until a tenant is bound, so find the tenant through the SECURITY
        # DEFINER lookup (ids only), bind it, and load the user normally.
        found = db.execute(text("SELECT user_id, restaurant_id FROM auth_find_users(:e, CAST(:r AS uuid))"),
                           {"e": throttle_key(email), "r": str(restaurant_id) if restaurant_id else None}).all()
        users = []
        if len(found) == 1:
            bind_tenant(db, found[0].restaurant_id)
            users = [db.get(User, found[0].user_id)]
        elif found:
            users = [None, None]
        if not users:
            raise SystemExit("No user found with that email" + (" in that restaurant." if restaurant_id else "."))
        if len(users) > 1:
            raise SystemExit("That email exists in several restaurants; pass --restaurant-id.")
        u = users[0]
        u.password_hash = hash_password(new_password)
        db.execute(update(RefreshToken).where(RefreshToken.user_id == u.id, RefreshToken.revoked_at.is_(None))
                   .values(revoked_at=func.now(), revoked_reason="password_reset"))
        db.execute(delete(LoginAttempt).where(LoginAttempt.email == throttle_key(u.email)))
        db.add(AuditLog(restaurant_id=u.restaurant_id, user_id=None, action="user.password_reset", entity="user",
                        entity_id=str(u.id), detail={"via": "cli"}))
        db.commit()
        return f"Password reset for {u.email} (restaurant {u.restaurant_id}). All their sessions are signed out."
    finally:
        if own:
            db.close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--email", required=True)
    ap.add_argument("--restaurant-id", type=uuid.UUID)
    a = ap.parse_args(argv)
    pw = getpass.getpass("New password: ")
    if getpass.getpass("Repeat new password: ") != pw:
        print("Passwords do not match.", file=sys.stderr)
        return 1
    try:
        print(reset(a.email, pw, a.restaurant_id))
    except SystemExit as e:
        print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.path.insert(0, ".")
    raise SystemExit(main())
