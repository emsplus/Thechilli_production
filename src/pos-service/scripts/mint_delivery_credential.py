"""Mints a tenant-bound credential for delivery-service. Run with DELIVERY_TOKEN_SECRET set (same value as the API's).

  uv run python scripts/mint_delivery_credential.py <restaurant_id> [--kid delivery-1] [--days 365] [--scopes menu:read+orders:read+orders:write]

Prints the TOKEN (give it to delivery-service as the secret behind its pos_api_key_ref) and the ENTRY to append to the API's
DELIVERY_SERVICE_KEYS (comma separated). The entry holds only the token's hash. To revoke, remove the entry."""
import argparse
import uuid

from app.services import delivery_auth

ap = argparse.ArgumentParser()
ap.add_argument("restaurant_id")
ap.add_argument("--kid", default="delivery-1")
ap.add_argument("--days", type=int, default=365)
ap.add_argument("--scopes", default="+".join(delivery_auth.ALL_SCOPES))
a = ap.parse_args()
uuid.UUID(a.restaurant_id)
scopes = [s for s in a.scopes.split("+") if s in delivery_auth.ALL_SCOPES]
if not scopes or ":" in a.kid or "," in a.kid:
    raise SystemExit("need at least one valid scope and a kid without ':' or ','")
tok = delivery_auth.mint_token(a.restaurant_id, a.kid, a.days * 86400)
print("TOKEN=" + tok)
print(f"DELIVERY_SERVICE_KEYS entry: {a.kid}:{delivery_auth.token_hash(tok)}:{'+'.join(scopes)}")
