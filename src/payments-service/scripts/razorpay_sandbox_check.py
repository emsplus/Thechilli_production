#!/usr/bin/env python
"""Verify the Razorpay adapter's assumptions against the real API in TEST mode.

Reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from the environment ONLY (never from args or files, never printed).
Refuses to run with anything but rzp_test_ keys. Prints the field names and status values Razorpay actually returns
so they can be compared with app/providers/razorpay.py. Makes no call at all without keys.

    set -a; . ../infra/compose/.env.secrets; set +a   # owner-provided, gitignored
    python scripts/razorpay_sandbox_check.py

Refund coverage needs a captured TEST payment on the account (pay the printed QR/link with a test UPI id such as
success@razorpay); otherwise the refund step is reported as not verified.
"""
import os
import sys
import time

import httpx

BASE = "https://api.razorpay.com"


def _shape(label: str, d, out):
    if isinstance(d, dict):
        out(f"  {label}: fields={sorted(d)}")
        scalars = {k: d[k] for k in ("status", "entity", "currency", "amount", "payment_amount", "receipt") if k in d}
        out(f"  {label}: status={d.get('status')} " + " ".join(f"{k}={v!r}" for k, v in scalars.items() if k != "status"))
    else:
        out(f"  {label}: (non-object response of type {type(d).__name__})")


def main(argv=None, env=None, transport=None, out=print) -> int:
    env = os.environ if env is None else env
    key_id, secret = env.get("RAZORPAY_KEY_ID", ""), env.get("RAZORPAY_KEY_SECRET", "")
    if not key_id or not secret:
        out("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set; nothing was called.")
        return 2
    if key_id.startswith("rzp_live_"):
        out("Refusing to run: a LIVE key (rzp_live_) was provided. This script only runs against TEST mode.")
        return 3
    if not key_id.startswith("rzp_test_"):
        out("Refusing to run: key id does not look like a Razorpay TEST key (rzp_test_...).")
        return 3
    base = env.get("RAZORPAY_BASE_URL", BASE)
    stamp = str(int(time.time()))
    with httpx.Client(base_url=base, auth=(key_id, secret), timeout=20, transport=transport) as c:
        def call(method, path, **kw):
            try:
                r = c.request(method, path, **kw)
            except httpx.HTTPError as e:
                out(f"  {method} {path}: transport error {type(e).__name__}")
                return None
            try:
                body = r.json()
            except ValueError:
                body = None
            out(f"{method} {path} -> HTTP {r.status_code}")
            if r.status_code >= 400:
                err = (body or {}).get("error", {}) if isinstance(body, dict) else {}
                out(f"  error fields={sorted(err)} code={err.get('code')!r} description={str(err.get('description'))[:120]!r}")
                return None
            return body

        order = call("POST", "/v1/orders", json={"amount": 10000, "currency": "INR", "receipt": f"chk_{stamp}"})
        if order:
            _shape("order", order, out)
        qr = call("POST", "/v1/payments/qr_codes", json={
            "type": "upi_qr", "usage": "single_use", "fixed_amount": True, "payment_amount": 10000,
            "description": "sandbox check", "notes": {"intent_id": f"chk_{stamp}"}})
        payments = []
        if qr:
            _shape("qr_code", qr, out)
            out(f"  qr_code: id prefix={str(qr.get('id'))[:3]} image_url present={'image_url' in qr}")
            lst = call("GET", f"/v1/payments/qr_codes/{qr.get('id')}/payments", params={"count": 10})
            if isinstance(lst, dict):
                out(f"  qr payments list: fields={sorted(lst)} count={len(lst.get('items') or [])}")
        recent = call("GET", "/v1/payments", params={"count": 20})
        if isinstance(recent, dict):
            payments = [p for p in recent.get("items") or [] if p.get("status") == "captured"]
            out(f"  recent payments: {len(recent.get('items') or [])} (captured: {len(payments)})")
        if not payments:
            out("No captured TEST payment on this account: refund shape NOT verified. "
                "Pay the QR above with a test UPI id, then re-run.")
            return 0
        pay = payments[0]
        _shape("payment", pay, out)
        receipt = f"rf_chk_{stamp}"[:40]
        rf = call("POST", f"/v1/payments/{pay['id']}/refund", json={
            "amount": min(100, int(pay.get("amount", 100))), "receipt": receipt, "notes": {"refund_id": receipt}})
        if rf:
            _shape("refund", rf, out)
            out(f"  refund receipt echoed={rf.get('receipt') == receipt}")
            lst = call("GET", f"/v1/payments/{pay['id']}/refunds", params={"count": 10})
            if isinstance(lst, dict):
                items = lst.get("items") or []
                out(f"  refunds list: fields={sorted(lst)} receipt lookup works="
                    f"{any(i.get('receipt') == receipt for i in items)}")
            one = call("GET", f"/v1/refunds/{rf.get('id')}")
            if one:
                _shape("refund(fetch)", one, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
