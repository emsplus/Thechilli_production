import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core.config import settings
from app.core.db import get_db
from app.schemas.online_payments import (
    BillOnlineOut, OnlinePaymentIn, OnlinePaymentOut, ProviderAccountIn, ProviderAccountOut,
)
from app.services import online_payments as svc
from app.services.payments_client import PaymentsClient, get_payments_client, is_configured, secret_prefix_for

router = APIRouter(tags=["online-payments"])


def _account_out(p: Principal, acc) -> ProviderAccountOut:
    path = f"/api/v1/webhooks/{acc.provider}/{acc.remote_account_id}"
    base = settings.payments_public_url.rstrip("/")
    return ProviderAccountOut(provider=acc.provider, remote_account_id=acc.remote_account_id, key_id_ref=acc.key_id_ref,
                              key_secret_ref=acc.key_secret_ref, webhook_secret_ref=acc.webhook_secret_ref,
                              secret_prefix=secret_prefix_for(p.restaurant_id), webhook_path=path,
                              webhook_url=base + path if base else None)


@router.get("/payments/online/config")
def online_config(p: Principal = Depends(require_perm(P.PAYMENTS_ONLINE, P.PAYMENTS_SETUP)), db: Session = Depends(get_db),
                  client: PaymentsClient | None = Depends(get_payments_client)):
    """What a client needs to decide whether to offer online payment. Online payment needs the network: an offline client must
    not offer it (the server also answers 503 online_payments_unavailable); cash is unaffected."""
    acc = svc.active_account(db, p.restaurant_id)
    return {"enabled": client is not None and acc is not None, "service_configured": is_configured() or client is not None,
            "provider_account": acc is not None, "provider": acc.provider if acc else None,
            "methods": ["upi_qr", "payment_link"], "requires_network": True,
            "secret_prefix": secret_prefix_for(p.restaurant_id)}


@router.put("/payments/provider-account", response_model=ProviderAccountOut)
def setup_provider(data: ProviderAccountIn, p: Principal = Depends(require_perm(P.PAYMENTS_SETUP)),
                   db: Session = Depends(get_db), client: PaymentsClient | None = Depends(get_payments_client)):
    """Owner: registers (or replaces) the restaurant's provider account. Only environment variable NAMES are sent and stored."""
    return _account_out(p, svc.setup_account(db, p, client, **data.model_dump()))


@router.get("/payments/provider-account", response_model=ProviderAccountOut | None)
def get_provider(p: Principal = Depends(require_perm(P.PAYMENTS_SETUP)), db: Session = Depends(get_db)):
    acc = svc.active_account(db, p.restaurant_id)
    return _account_out(p, acc) if acc else None


@router.post("/bills/{bill_id}/online-payments", response_model=OnlinePaymentOut, status_code=201)
def start_online(bill_id: uuid.UUID, data: OnlinePaymentIn, response: Response,
                 p: Principal = Depends(require_perm(P.PAYMENTS_ONLINE)), db: Session = Depends(get_db),
                 client: PaymentsClient | None = Depends(get_payments_client)):
    """Starts a UPI QR / payment link for (part of) a bill. 201 new, 200 replay of the same idempotency_key. The bill is NOT
    paid by this call: it is paid when payments-service reports the money (poll GET /online-payments/{id})."""
    op, created = svc.start(db, p, client, bill_id, data.idempotency_key, data.method, data.amount, data.description)
    if not created:
        response.status_code = 200
    return op


@router.get("/bills/{bill_id}/online-payments", response_model=BillOnlineOut)
def bill_online(bill_id: uuid.UUID, p: Principal = Depends(require_perm(P.PAYMENTS_ONLINE)), db: Session = Depends(get_db),
                client: PaymentsClient | None = Depends(get_payments_client)):
    """All online attempts of the bill with due / paid / unallocated. Refreshes every open attempt first (best effort), so a
    payment that completed while nobody was polling is applied the next time anyone looks."""
    return svc.summary(db, p, client, bill_id)


@router.get("/online-payments/{op_id}", response_model=OnlinePaymentOut)
def poll_online(op_id: uuid.UUID, p: Principal = Depends(require_perm(P.PAYMENTS_ONLINE)), db: Session = Depends(get_db),
                client: PaymentsClient | None = Depends(get_payments_client)):
    """Poll every 2-3 s while the QR is on screen. Reads payments-service's state and applies captured money to the bill."""
    return svc.refresh(db, p, client, op_id)


@router.post("/online-payments/{op_id}/sync", response_model=OnlinePaymentOut)
def sync_online(op_id: uuid.UUID, p: Principal = Depends(require_perm(P.PAYMENTS_ONLINE)), db: Session = Depends(get_db),
                client: PaymentsClient | None = Depends(get_payments_client)):
    """Like the poll, but payments-service asks the provider directly (reconciles a webhook that never arrived)."""
    return svc.refresh(db, p, client, op_id, deep=True)
