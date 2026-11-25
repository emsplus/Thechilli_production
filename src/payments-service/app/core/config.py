from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "production"  # fail closed: dev/tests/CI must set ENV=development
    database_url: str = "postgresql+psycopg://pos:pos@localhost:5460/pay_dev"
    # Callers present a tenant-bound signed JWT: `Authorization: Bearer <jwt>` with claims tid, exp (and aud).
    # HS256 with a shared secret for now; the verifier is pluggable (see app.core.security.TokenVerifier) so a JWKS
    # (RS256/ES256) verifier can replace it without touching routes. Empty/short secret = every route 503.
    jwt_secret: SecretStr = SecretStr("")
    jwt_audience: str = "payments-service"
    jwt_issuer: str = ""  # if set, the iss claim must equal it
    jwt_leeway_seconds: int = 30
    # Razorpay API base; tests never reach it (fake transport).
    razorpay_base_url: str = "https://api.razorpay.com"
    provider_timeout_seconds: float = 15.0
    # Provider credentials are referenced by env var NAME (must start with this prefix); values never enter the DB.
    secret_ref_prefix: str = "PAY_SECRET_"
    max_webhook_bytes: int = 256 * 1024
    # Webhook route is unauthenticated: cap requests per (client ip, account) per minute. Process-local; put a real
    # limiter at the edge (ingress/WAF) when running more than one replica.
    webhook_rate_limit_per_minute: int = 120
    bad_signature_audit_window_seconds: int = 60  # at most one audit row per account per window
    min_intent_amount: int = 100  # paise (Rs 1)
    max_intent_amount: int = 50_000_000  # paise (Rs 5 lakh)


settings = Settings()
