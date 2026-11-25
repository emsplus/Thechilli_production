"""Dev-only: print what a sample bill, KOT and test page look like on a thermal slip. Needs no database and no printer.

    cd apps/api && .venv/bin/python scripts/print_preview.py [--columns 42] [--codepage pc858] [--annotate]
"""
import argparse
import sys
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace as N

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.models.core import DiningTable, Order, Restaurant, User  # noqa: E402
from app.services import escpos, escpos_preview  # noqa: E402

WHEN = datetime(2026, 10, 28, 19, 42, tzinfo=timezone.utc)


class FakeDB:
    """Just enough of a Session for the renderers: .get(Model, id)."""
    def __init__(self, order_type="takeaway", table=None):
        self.rows = {
            Restaurant: N(name="The Karahi", timezone="Asia/Kolkata"),
            Order: N(order_type=N(value=order_type), token_number=None, note=None, table_id=uuid.uuid4() if table else None, created_by=uuid.uuid4()),
            DiningTable: N(label=table or ""),
            User: N(full_name="Aisha"),
        }

    def get(self, model, _id):
        return self.rows[model]

    def scalar(self, _stmt):  # no earlier KOT: the sample is the order's first ticket
        return None


def sample_bill():
    lines = [N(description="Chicken Karahi (Large)", quantity=1, unit_price=Decimal("450.00"), line_total=Decimal("450.00")),
             N(description="Garlic Naan", quantity=3, unit_price=Decimal("60.00"), line_total=Decimal("180.00")),
             N(description="Mango Lassi", quantity=2, unit_price=Decimal("120.00"), line_total=Decimal("240.00"))]
    total = Decimal("870.00")
    return N(seller_name="The Karahi", seller_address="12 MG Road, Bengaluru 560001", seller_phone="080 4000 0000",
             seller_trn="29ABCDE1234F1Z5", invoice_number="INV/2627/000123", currency="INR", country="IN",
             prices_include_tax=True, vat_registered=True, status="active", amends_bill_id=None,
             tax_breakdown=[{"code": "standard", "rate_percent": "5", "net": "828.57", "vat": "41.43", "gross": "870.00"}],
             discount_amount=Decimal(0), service_charge_amount=Decimal(0), service_charge_percent=Decimal(0),
             lines=lines, payments=[N(amount=total, method=N(value="card"))], refunds=[], total=total,
             subtotal=Decimal("828.57"), tax_amount=Decimal("41.43"), tax_name="GST", tax_rate_percent=Decimal("5.00"),
             sale_at=WHEN, finalized_at=WHEN, customer_name=None, customer_phone=None, table_label=None,
             order_type="takeaway", cashier_name="Aisha", order_id=uuid.uuid4())


def sample_kot():
    lines = [{"item": "Chicken Tikka Starter", "qty": 2, "note": "extra hot"}, {"item": "Lamb Karahi", "qty": 1, "note": None},
             {"item": "Peshwari Naan", "qty": 2, "note": None}]
    kot = N(restaurant_id=uuid.uuid4(), order_id=uuid.uuid4(), number=3, created_at=WHEN, status=N(value="pending"))
    return kot, lines


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--columns", type=int, default=42)
    ap.add_argument("--codepage", default="pc858", choices=["pc858", "cp1252", "cp437", "none"])
    ap.add_argument("--annotate", action="store_true", help="show bold / size tags")
    a = ap.parse_args()
    opts = {"columns": a.columns, "codepage": a.codepage}
    kot, lines = sample_kot()
    slips = {
        "BILL": escpos.render_bill(None, sample_bill(), "Asia/Kolkata", **opts),
        "KOT (take away)": escpos.render_kot(FakeDB("takeaway"), kot, lines, **opts),
        "TEST PAGE": escpos.render_test("Kitchen SNBC", "Asia/Kolkata", now=WHEN, **opts),
    }
    for title, data in slips.items():
        print(f"\n===== {title} ({len(data)} bytes) =====")
        print(escpos_preview.preview(data, a.columns, a.annotate))


if __name__ == "__main__":
    main()
