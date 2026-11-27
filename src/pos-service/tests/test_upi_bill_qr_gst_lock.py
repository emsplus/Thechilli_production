"""UPI QR on the printed bill (2026-11-26) and: with GST switched off no GSTIN / GST engine can be entered."""
import os

os.environ.setdefault("ENV", "development")

from decimal import Decimal
from types import SimpleNamespace as NS

import pytest
from fastapi import HTTPException

from app.services import manage, receipt, thermal
from app.services.escpos import Escpos


def _bill(total="567.00", paid="0", status="active"):
    pays = [NS(amount=Decimal(paid))] if Decimal(paid) else []
    return NS(restaurant_id="r1", status=status, total=Decimal(total), payments=pays, seller_name="Roll Express", invoice_number="INV-7")


class _Db:
    def __init__(self, vpa): self.rest = NS(upi_vpa=vpa)
    def get(self, model, key): return self.rest


def test_uri_carries_vpa_amount_and_bill():
    uri, due, vpa = receipt.upi_pay_uri(_Db("paytmqr67x6qp@ptys"), _bill())
    assert uri.startswith("upi://pay?pa=paytmqr67x6qp@ptys&pn=Roll%20Express&am=567.00&cu=INR")
    assert due == Decimal("567.00") and vpa == "paytmqr67x6qp@ptys"


def test_partly_paid_bill_asks_only_for_the_rest():
    assert receipt.upi_pay_uri(_Db("a@b"), _bill(paid="200"))[1] == Decimal("367.00")


@pytest.mark.parametrize("db,bill", [(_Db(None), _bill()), (_Db(""), _bill()), (None, _bill()),
                                     (_Db("a@b"), _bill(paid="567")), (_Db("a@b"), _bill(status="void"))])
def test_no_qr_when_nothing_to_pay(db, bill):
    assert receipt.upi_pay_uri(db, bill) is None


def test_slip_draws_a_qr_and_still_renders_a_pdf():
    s = thermal.Slip("INV-7")
    s.line("Scan to pay by UPI", 9, True)
    s.qr("upi://pay?pa=a@b&am=10.00&cu=INR", 104)
    pdf = s.render()
    assert pdf.startswith(b"%PDF")
    plain = thermal.Slip("INV-8"); plain.line("x", 9); assert len(pdf) > len(plain.render())


def test_escpos_qr_command_present():
    e = Escpos(42, "pc858"); e.qr("upi://pay?pa=a@b&am=10.00&cu=INR", 6)
    assert b"\x1d(k" in e.finish(False)


class _R:
    trn = None; vat_registered = False
    def __init__(self): self.id = "r"

class _DbR:
    def get(self, *a, **k): return _R()


def test_gstin_refused_while_gst_is_off():
    data = NS(trn="29ABCDE1234F1Z5", vat_registered=None, name="x", address=None, model_fields_set=set(), z_report_next_number=None)
    with pytest.raises(HTTPException) as e:
        manage.update_restaurant(_DbR(), NS(restaurant_id="r"), data)
    assert e.value.status_code == 422
