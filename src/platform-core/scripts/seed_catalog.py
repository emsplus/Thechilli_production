"""Create the initial feature catalog and plans. Idempotent and safe to run in production: it only ADDS what is missing and
never touches a feature or plan that already exists (an edited plan, price or feature set is left exactly as it is).

    python scripts/seed_catalog.py --dry-run                      # print what would be created, change nothing
    python scripts/seed_catalog.py                                # development: built-in starter catalog (placeholder prices)
    python scripts/seed_catalog.py --accept-placeholder-prices    # production: same built-in catalog, explicit opt-in
    python scripts/seed_catalog.py --plans-file plans.json        # production: your own plans / prices (path, or - for stdin)

Inside a running stack use infra's `scripts/seed-plans.sh` (docs/DEPLOYMENT.md). The built-in prices (paise, excl. GST) are
placeholders, not commercial decisions: in production the script refuses to use them unless --accept-placeholder-prices is given;
real prices belong in a --plans-file or are edited afterwards in super-admin (Plans), which keeps a version history.

plans.json:  {"features": [{"code": "kds", "name": "Kitchen display", "kind": "flag"}],            # optional extra features
              "plans": {"starter": {"name": "Starter", "price_paise": 99900, "features": {"pos.core": null, "outlets.max": 1}}}}
(feature value = limit for kind "limit", null for a flag). Every feature a plan uses must exist (built-in or listed above).
"""
import argparse
import json
import sys

sys.path.insert(0, ".")
from sqlalchemy import select  # noqa: E402

from app.api.catalog import _record_version  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.core.db import SessionLocal  # noqa: E402
from app.models import Feature, Plan, PlanFeature  # noqa: E402

FEATURES = [("pos.core", "Chilli Agent billing", "flag"), ("outlets.max", "Outlets", "limit"), ("kds", "Kitchen display", "flag"),
            ("inventory", "Inventory", "flag"), ("ai.copilot", "AI copilot", "flag"), ("marketing.campaigns", "Marketing campaigns", "flag"),
            ("delivery", "Delivery orders", "flag"), ("aggregator", "Aggregator orders", "flag"),
            # Feature access (alembic 0008): order types, bill options and back-office modules a super admin can grant or withhold.
            ("order.indoor", "Dine-in (indoor) orders", "flag"), ("order.outdoor", "Outdoor orders", "flag"),
            ("order.takeaway", "Takeaway orders", "flag"), ("billing.discount", "Discounts on bills", "flag"),
            ("billing.service_charge", "Service charge", "flag"), ("billing.offers", "Automatic offers", "flag"),
            ("reports", "Reports", "flag"), ("cash_drawer", "Cash drawer", "flag"), ("customers", "Customers", "flag"),
            ("expenses", "Expenses", "flag"), ("table_qr", "Table QR ordering", "flag")]
ACCESS = {c: None for c in ("order.indoor", "order.outdoor", "order.takeaway", "billing.discount", "billing.service_charge",
                            "billing.offers", "reports", "cash_drawer", "customers", "expenses", "table_qr")}  # on in every plan, like 0008
# Restaurant-only tenants get delivery/aggregator from their plan; tenants with cloud_kitchen or hotel_kitchen among their
# business_types get both regardless of plan
# (business-type defaults in app/services/entitlements.py).
PLANS = {"starter": (99900, {"pos.core": None, "outlets.max": 1, **ACCESS}), "growth": (249900, {"pos.core": None, "outlets.max": 5, "kds": None, "inventory": None, "delivery": None, **ACCESS}),
         "pro": (499900, {"pos.core": None, "outlets.max": 25, "kds": None, "inventory": None, "ai.copilot": None, "marketing.campaigns": None,
                            "delivery": None, "aggregator": None, **ACCESS})}
ACTOR = "seed-catalog"


def builtin() -> dict:
    return {"features": [{"code": c, "name": n, "kind": k} for c, n, k in FEATURES],
            "plans": {code: {"name": code.title(), "price_paise": price, "features": feats} for code, (price, feats) in PLANS.items()}}


def load_spec(path: str) -> dict:
    spec = json.load(sys.stdin if path == "-" else open(path))
    if not isinstance(spec, dict) or not isinstance(spec.get("plans"), dict) or not spec["plans"]:
        raise SystemExit("plans file: expected an object with a non-empty \"plans\" object")
    spec.setdefault("features", [])
    for f in spec["features"]:
        if not isinstance(f, dict) or not {"code", "name"} <= set(f) or f.get("kind", "flag") not in ("flag", "limit"):
            raise SystemExit(f"plans file: bad feature {f!r} (need code, name, kind flag|limit)")
    for code, p in spec["plans"].items():
        if not isinstance(p, dict) or not isinstance(p.get("price_paise"), int) or p["price_paise"] < 0 or not p.get("name"):
            raise SystemExit(f"plans file: plan {code!r} needs name and a non-negative integer price_paise")
        if not isinstance(p.get("features", {}), dict):
            raise SystemExit(f"plans file: plan {code!r}: features must be an object feature -> limit|null")
    return spec


def seed(db, spec: dict, dry_run: bool = False) -> list[str]:
    """Add the missing features and plans of `spec`; returns one report line per item. Existing rows are never modified."""
    report: list[str] = []
    known = {f.code for f in db.scalars(select(Feature))}
    for f in spec.get("features", []):
        if f["code"] in known:
            report.append(f"feature {f['code']}: exists, left untouched")
            continue
        report.append(f"feature {f['code']}: {'would create' if dry_run else 'created'}")
        known.add(f["code"])
        if not dry_run:
            db.add(Feature(code=f["code"], name=f["name"], kind=f.get("kind", "flag")))
    db.flush()
    for code, p in spec["plans"].items():
        if db.scalar(select(Plan).where(Plan.code == code)):
            report.append(f"plan {code}: exists, left untouched (price, features and status are NOT changed)")
            continue
        missing = sorted(set(p.get("features", {})) - known)
        if missing:
            raise SystemExit(f"plan {code!r} uses unknown feature(s) {missing}: add them under \"features\"")
        report.append(f"plan {code}: {'would create' if dry_run else 'created'} (price_paise={p['price_paise']}, features={sorted(p.get('features', {}))})")
        if dry_run:
            continue
        plan = Plan(code=code, name=p["name"], price_paise=p["price_paise"])
        db.add(plan)
        db.flush()
        db.add_all(PlanFeature(plan_id=plan.id, feature_code=f, limit_value=lim) for f, lim in p.get("features", {}).items())
        _record_version(db, plan, "created", ACTOR, "initial catalog (scripts/seed_catalog.py)", first=True)  # same history as POST /plans
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="print what would be created; change nothing")
    ap.add_argument("--plans-file", metavar="FILE", help="JSON with your plans / prices (path, or - for stdin) instead of the built-in starter plans")
    ap.add_argument("--accept-placeholder-prices", action="store_true", help="production: allow the built-in placeholder prices")
    a = ap.parse_args(argv)
    if a.plans_file is None and settings.is_production and not (a.accept_placeholder_prices or a.dry_run):
        print("Refusing to create the built-in plans in production: their prices are placeholders. Pass --plans-file with real plans, "
              "or --accept-placeholder-prices to use them anyway (and edit the prices in super-admin afterwards).", file=sys.stderr)
        return 2
    spec = load_spec(a.plans_file) if a.plans_file else builtin()
    with SessionLocal() as db:
        report = seed(db, spec, dry_run=a.dry_run)
        if a.dry_run:
            db.rollback()
        else:
            db.commit()
    print("\n".join(report))
    print("dry run: nothing written" if a.dry_run else "seeded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
