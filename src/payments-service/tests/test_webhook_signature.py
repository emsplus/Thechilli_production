import hashlib
import hmac

from app.providers.razorpay import RazorpayAdapter


def _adapter():
    return RazorpayAdapter(key_id="k", key_secret="s", webhook_secret="whsec", base_url="http://x")


def test_valid_signature_accepted():
    body = b'{"event":"x"}'
    sig = hmac.new(b"whsec", body, hashlib.sha256).hexdigest()
    assert _adapter().verify_webhook(body, sig) is True


def test_non_ascii_signature_rejected_not_crash():
    assert _adapter().verify_webhook(b"{}", "caféé") is False


def test_wrong_signature_rejected():
    assert _adapter().verify_webhook(b"{}", "00" * 32) is False
