import os

os.environ.setdefault("ENV", "development")

from app.core import permissions as perms
from app.core.permissions import P
from app.models.core import Role


def _guard(path, method):
    from app.api.v1.setup import router
    for r in router.routes:
        if getattr(r, "path", "").endswith(path) and method in getattr(r, "methods", ()):
            return next(d.call for d in r.dependant.dependencies if hasattr(d.call, "perms"))
    raise AssertionError("route missing")


def test_cashier_can_read_upi_but_not_write():
    cashier = perms.SYSTEM_ROLE_PERMISSIONS[Role.cashier.value]
    g, w = _guard("/restaurant/upi", "GET"), _guard("/restaurant/upi", "PUT")
    assert P.PAYMENTS_RECORD in g.perms and P.SETTINGS_OWNER in g.perms
    assert cashier & set(g.perms) and P.SETTINGS_OWNER not in cashier
    assert w.perms == (P.SETTINGS_OWNER,)
