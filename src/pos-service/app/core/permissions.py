"""Permission model (docs/PERMISSIONS.md, docs/PHASE1_PLAN.md section (c), PR 8-9).

Permissions are code constants: they ship with the code that checks them. A user's permissions are

* the permissions of its custom role (``users.custom_role_id`` -> ``roles`` / ``role_permissions``, tenant-scoped, RLS) when
  one is set, otherwise
* the permissions of its system role (``users.role`` enum), a dict in this module (no database hit per request).

The system map reproduces today's role checks exactly: ``tests/fixtures/route_roles.json`` is the snapshot of the old
``require_roles`` guards and ``tests/test_permissions.py`` proves every route still allows exactly the same roles.
Business rules that are not permissions stay in code (only an owner creates owners, the last active owner cannot be demoted,
the cashier discount cap value is a restaurant setting; ``bills.discount.over_limit`` decides whether the cap applies).
"""
from __future__ import annotations

from typing import Iterable

from app.models.core import Role


class P:
    """Permission names, ``<area>.<action>``."""
    # orders / kitchen
    ORDERS_CREATE = "orders.create"
    ORDERS_UPDATE = "orders.update"
    ORDERS_CANCEL = "orders.cancel"
    ORDERS_CANCEL_UNSENT = "orders.cancel_unsent"  # cancel an order / remove a line the kitchen has NOT been sent (waiter app)
    ORDERS_REQUEST_BILL = "orders.request_bill"    # "bring the bill": flag an order for the cashier
    ORDERS_TRANSFER = "orders.transfer"            # move an order to another table / merge two orders (same outlet)
    ORDERS_CANCEL_AFTER_KITCHEN = "orders.cancel_after_kitchen"  # cancel an order the kitchen already has (docs/ORDER_RULES.md)
    KOT_SEND = "kot.send"
    KOT_VIEW = "kot.view"
    KOT_UPDATE_STATUS = "kot.update_status"
    DELIVERY_ACCEPT = "delivery.accept"  # accept a delivery order into the kitchen, confirm its payment (staff)
    DELIVERY_MANAGE = "delivery.manage"  # delivery settings, webhook secret, public ordering link, outbox (back office)
    # shifts and table assignment (waiter app)
    SHIFTS_USE = "shifts.use"        # open / close the caller's OWN shift, read own shift and own tables
    SHIFTS_MANAGE = "shifts.manage"  # who is on shift, shift history, close anyone's shift
    TABLES_ASSIGN = "tables.assign"  # assign tables to the user of an open shift
    # billing
    BILLS_FINALIZE = "bills.finalize"
    BILLS_RECEIPT = "bills.receipt"
    BILLS_DISCOUNT = "bills.discount"
    BILLS_DISCOUNT_OVER_LIMIT = "bills.discount.over_limit"  # not subject to the cashier discount cap
    BILLS_AMEND = "bills.amend"
    BILLS_VOID = "bills.void"
    BILLS_SKIP_KITCHEN = "bills.skip_kitchen"  # bill a dine-in order before every item went to the kitchen (with a reason)
    PAYMENTS_RECORD = "payments.record"
    PAYMENTS_ONLINE = "payments.online"  # start / poll / sync a UPI QR or payment link through payments-service
    PAYMENTS_SETUP = "payments.setup"    # register the restaurant's payment-provider account (secret references)
    REFUNDS_CREATE = "refunds.create"
    CASHIER_SHIFT = "cashier.shift"  # open / close own cash session (docs/CASH_SESSIONS.md)
    # POS runtime
    SYNC_PUSH = "sync.push"
    PRINTING_USE = "printing.use"
    VOICE_USE = "voice.use"
    CRM_READ = "crm.read"
    CRM_WRITE = "crm.write"
    # back office
    MENU_MANAGE = "menu.manage"  # also modifier groups and combos (docs/MODIFIERS_OFFERS.md)
    MENU_SOLD_OUT = "menu.sold_out"  # mark a dish sold out for today / available again (docs/ORDER_RULES.md)
    OFFERS_MANAGE = "offers.manage"  # create / edit / switch off automatic offers (docs/MODIFIERS_OFFERS.md)
    TABLES_MANAGE = "tables.manage"
    INVENTORY_MANAGE = "inventory.manage"
    PURCHASES_MANAGE = "purchases.manage"
    PURCHASES_RECEIVE = "purchases.receive"  # post goods receipts (GRN) against purchase orders
    WASTAGE_RECORD = "wastage.record"  # write stock off with a reason code, expiry write-offs
    INVENTORY_COUNT = "inventory.count"  # stocktakes: open, count, post variances
    EXPENSES_MANAGE = "expenses.manage"
    REPORTS_VIEW = "reports.view"
    REPORTS_CLOSE_DAY = "reports.close_day"
    AUDIT_VIEW = "audit.view"
    PRINTING_MANAGE = "printing.manage"
    AI_USE = "ai.use"
    SYSTEM_VIEW = "system.view"
    SETTINGS_MANAGE = "settings.manage"
    OUTLETS_MANAGE = "outlets.manage"
    OUTLETS_ACCESS_ALL = "outlets.access_all"  # reaches every outlet of the tenant (else user_outlet_access applies)
    # staff
    STAFF_VIEW = "staff.view"
    STAFF_CREATE = "staff.create"
    STAFF_MANAGE_ROLES = "staff.manage_roles"
    STAFF_DEACTIVATE = "staff.deactivate"
    STAFF_RESET_PASSWORD = "staff.reset_password"
    STAFF_MANAGE_OUTLET_ACCESS = "staff.manage_outlet_access"
    SETTINGS_OWNER = "settings.owner"
    # roles API (docs/ROLES_API.md): deliberately NOT in manager's default set
    ROLES_MANAGE = "roles.manage"  # create / edit / clone / delete custom roles
    USERS_MANAGE = "users.manage"  # assign a role to a user, manage a user's outlet access
    # table reservations, staff attendance, first-run setup checklist (docs/RESERVATIONS_ATTENDANCE_SETUP_API.md)
    RESERVATIONS_MANAGE = "reservations.manage"  # book, edit, cancel, seat, no-show, send a reminder; list the day
    ATTENDANCE_CLOCK = "attendance.clock"        # clock the caller in / out, read own attendance
    ATTENDANCE_MANAGE = "attendance.manage"      # everyone's attendance: corrections (with reason), schedules, reports
    SETUP_MANAGE = "setup.manage"                # read the setup checklist, skip / un-skip a step
    # platform credit (PAYG wallet held by platform-core, docs/PAYG_BILLING.md)
    BILLING_VIEW = "billing.view"    # the restaurant's own wallet: balance, trial, ledger, monthly usage, receipts
    BILLING_TOPUP = "billing.topup"  # start an online top-up (flagged off until Razorpay is wired)
    # device sessions, counter devices, staff PINs (docs/STAFF_PIN_DEVICES_API.md)
    DEVICES_MANAGE = "devices.manage"      # everyone's signed-in devices (list / revoke), register / revoke counter devices
    STAFF_PIN_MANAGE = "staff.pin.manage"  # set / clear / unlock another user's counter PIN


ALL_PERMISSIONS: frozenset[str] = frozenset(v for k, v in vars(P).items() if not k.startswith("_") and isinstance(v, str))

# Permission groups, derived from today's role tuples (ADMIN, CASHIER, POS_ROLES, STAFF, TAKES_ORDERS, owner-only).
_POS = frozenset({P.DELIVERY_ACCEPT, P.ORDERS_CREATE, P.ORDERS_UPDATE, P.KOT_SEND, P.KOT_VIEW, P.SYNC_PUSH, P.PRINTING_USE, P.VOICE_USE,
                  P.CRM_READ, P.CRM_WRITE, P.SHIFTS_USE, P.ORDERS_REQUEST_BILL, P.ORDERS_TRANSFER,
                  P.ORDERS_CANCEL_UNSENT})                                        # owner manager cashier waiter
_CASHIER = frozenset({P.MENU_SOLD_OUT, P.ORDERS_CANCEL, P.CASHIER_SHIFT, P.BILLS_FINALIZE, P.BILLS_RECEIPT, P.BILLS_DISCOUNT, P.PAYMENTS_RECORD, P.PAYMENTS_ONLINE})  # + cashier
_KITCHEN = frozenset({P.KOT_VIEW, P.KOT_UPDATE_STATUS})                            # owner manager kitchen
_ADMIN = frozenset({
    P.DELIVERY_MANAGE, P.REFUNDS_CREATE, P.BILLS_AMEND, P.BILLS_VOID, P.BILLS_DISCOUNT_OVER_LIMIT, P.MENU_MANAGE, P.OFFERS_MANAGE, P.TABLES_MANAGE, P.INVENTORY_MANAGE,
    P.PURCHASES_MANAGE, P.PURCHASES_RECEIVE, P.WASTAGE_RECORD, P.INVENTORY_COUNT, P.EXPENSES_MANAGE, P.REPORTS_VIEW, P.REPORTS_CLOSE_DAY, P.AUDIT_VIEW, P.PRINTING_MANAGE, P.AI_USE,
    P.SYSTEM_VIEW, P.SETTINGS_MANAGE, P.OUTLETS_MANAGE, P.OUTLETS_ACCESS_ALL, P.STAFF_VIEW, P.STAFF_CREATE,
    P.SHIFTS_MANAGE, P.TABLES_ASSIGN, P.BILLING_VIEW, P.ORDERS_CANCEL_AFTER_KITCHEN, P.BILLS_SKIP_KITCHEN})  # owner manager
_FRONT = frozenset({P.RESERVATIONS_MANAGE})                                       # owner manager cashier waiter
_CLOCK = frozenset({P.ATTENDANCE_CLOCK})                                          # every system role
_BACK = frozenset({P.ATTENDANCE_MANAGE, P.SETUP_MANAGE, P.DEVICES_MANAGE, P.STAFF_PIN_MANAGE})  # owner manager
_OWNER = frozenset({P.STAFF_MANAGE_ROLES, P.STAFF_DEACTIVATE, P.STAFF_RESET_PASSWORD, P.STAFF_MANAGE_OUTLET_ACCESS,
                    P.SETTINGS_OWNER, P.PAYMENTS_SETUP,
                    P.ROLES_MANAGE, P.USERS_MANAGE, P.BILLING_TOPUP})                             # owner only

SYSTEM_ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    Role.owner.value: _POS | _CASHIER | _KITCHEN | _ADMIN | _OWNER | _FRONT | _CLOCK | _BACK,
    Role.manager.value: _POS | _CASHIER | _KITCHEN | _ADMIN | _FRONT | _CLOCK | _BACK,
    Role.cashier.value: _POS | _CASHIER | _FRONT | _CLOCK,
    Role.waiter.value: _POS | _FRONT | _CLOCK,
    Role.kitchen.value: _KITCHEN | _CLOCK,
}
SYSTEM_ROLE_NAMES = {"owner": "Owner", "manager": "Manager", "cashier": "Cashier", "waiter": "Waiter", "kitchen": "Kitchen"}
assert all(perms <= ALL_PERMISSIONS for perms in SYSTEM_ROLE_PERMISSIONS.values())


def system_role_permissions(role: Role | str) -> frozenset[str]:
    return SYSTEM_ROLE_PERMISSIONS[role.value if isinstance(role, Role) else role]


def roles_with(*perms: str) -> frozenset[str]:
    """System roles that hold ANY of the permissions (what ``require_perm(*perms)`` lets through)."""
    return frozenset(r for r, have in SYSTEM_ROLE_PERMISSIONS.items() if have & set(perms))


def validate(perms: Iterable[str]) -> frozenset[str]:
    perms = frozenset(perms)
    unknown = perms - ALL_PERMISSIONS
    if unknown:
        raise ValueError(f"unknown permissions: {sorted(unknown)}")
    return perms


def resolve(db, user) -> frozenset[str]:
    """Effective permissions of a user. A custom role (own tenant only) replaces the system role's permissions; a custom role
    that cannot be read (another tenant's, deleted, inactive) grants NOTHING: fail closed, never fall back to the enum role."""
    from sqlalchemy import select

    from app.models.core import RoleDef, RolePermission

    if user.custom_role_id is None:
        return system_role_permissions(user.role)
    role = db.get(RoleDef, user.custom_role_id)
    if role is None or not role.is_active or (role.restaurant_id is not None and role.restaurant_id != user.restaurant_id):
        return frozenset()
    if role.is_system:
        return SYSTEM_ROLE_PERMISSIONS.get(role.key, frozenset())
    return frozenset(db.scalars(select(RolePermission.permission).where(RolePermission.role_id == role.id))) & ALL_PERMISSIONS


def seed_system_roles(conn) -> None:
    """Inserts the five system roles (restaurant_id NULL) with their permission rows. Idempotent; run as the owner role
    (the app role may not write system rows). The code dict stays authoritative for system roles; the rows exist so custom
    roles / reports can reference them and so the matrix is visible in SQL."""
    from sqlalchemy import text

    for key, name in SYSTEM_ROLE_NAMES.items():
        conn.execute(text(
            "INSERT INTO roles (id, restaurant_id, key, name, is_system, is_active) "
            "SELECT gen_random_uuid(), NULL, CAST(:k AS varchar), CAST(:n AS varchar), true, true "
            "WHERE NOT EXISTS (SELECT 1 FROM roles WHERE restaurant_id IS NULL AND key = :k)"), {"k": key, "n": name})
        conn.execute(text("DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE restaurant_id IS NULL AND key = :k)"),
                     {"k": key})
        for perm in sorted(SYSTEM_ROLE_PERMISSIONS[key]):
            conn.execute(text("INSERT INTO role_permissions (role_id, permission) "
                              "SELECT id, CAST(:p AS varchar) FROM roles WHERE restaurant_id IS NULL AND key = :k"), {"k": key, "p": perm})
