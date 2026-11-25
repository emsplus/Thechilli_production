"""Usage: LINK_SECRET=... uv run python scripts/mint_token.py <restaurant_id> [ttl_seconds]"""
import sys

from app.core.security import mint_service_token

print(mint_service_token(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 365 * 86400))
