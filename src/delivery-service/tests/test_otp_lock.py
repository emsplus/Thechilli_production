from unittest.mock import MagicMock, patch

from app.services import orders as svc


def test_rider_deliver_locks_order_row_before_checking_otp():
    o = MagicMock(status="delivered")
    with patch.object(svc, "_rider_ctx", return_value=(o, MagicMock())):
        db = MagicMock()
        assert svc.rider_deliver(db, {}, "123456") is o
    db.refresh.assert_called_once_with(o, with_for_update=True)
