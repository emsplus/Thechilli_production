import httpx

from app.core.config import settings
from app.core.errors import AppError
from app.core.security import resolve_secret
from app.providers.base import PaymentProvider
from app.providers.razorpay import RazorpayAdapter

# Tests set this to an httpx.MockTransport so no request ever leaves the process.
transport_override: httpx.BaseTransport | None = None


def get_provider(account) -> PaymentProvider:
    if account.provider == "razorpay":
        return RazorpayAdapter(
            key_id=resolve_secret(account.key_id_ref, account.tenant_id),
            key_secret=resolve_secret(account.key_secret_ref, account.tenant_id),
            webhook_secret=resolve_secret(account.webhook_secret_ref, account.tenant_id), base_url=settings.razorpay_base_url,
            timeout=settings.provider_timeout_seconds, transport=transport_override)
    raise AppError(f"unsupported provider {account.provider}", code="unsupported_provider", status=422)
