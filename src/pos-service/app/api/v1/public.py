"""Public, token-gated receipt PDFs (no login: the signed, expiring URL is the capability).
Every failure (malformed, forged, expired, bill gone, tenant mismatch) is the same plain 404."""
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.tenancy import bind_tenant
from app.models.core import Bill, Restaurant
from app.services import audit, receipt_links
from app.services.receipt import render_receipt

router = APIRouter(tags=["public"])


@router.get("/public/receipts/{token}.pdf", include_in_schema=True)
def public_receipt(token: str, request: Request, db: Session = Depends(get_db)):
    ip = request.client.host if request.client else "unknown"
    if not receipt_links.limiter.allow(ip, settings.public_rate_limit_per_minute):
        raise HTTPException(429, "Too many requests", headers={"Retry-After": "60"})
    ids = receipt_links.verify(token)
    if not ids:
        raise HTTPException(404, "Not found")
    bind_tenant(db, ids[1])  # the tenant comes from the verified HMAC token, before anything is read
    bill = db.get(Bill, ids[0])
    if not bill or bill.restaurant_id != ids[1] or ids[2] != (bill.receipt_link_gen or 0):  # revoked links: same 404
        raise HTTPException(404, "Not found")
    rest = db.get(Restaurant, bill.restaurant_id)
    pdf = render_receipt(bill, rest.timezone, "thermal", db)
    audit.record(db, SimpleNamespace(restaurant_id=bill.restaurant_id, user_id=None),
                 "bill.public_download", "bill", bill.id)
    db.commit()
    return Response(pdf, media_type="application/pdf", headers={
        "Content-Disposition": f'inline; filename="{bill.invoice_number}.pdf"',
        "Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex"})
