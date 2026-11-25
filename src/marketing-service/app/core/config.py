from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "production"  # fail closed: local dev, tests and CI must set ENV=development
    database_url: str = "postgresql+psycopg://pos:pos@localhost:5460/mkt_dev"
    jwt_secret: str = "dev-only-secret-change-me-0123456789abcdef"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 30
    refresh_token_days: int = 30
    refresh_reuse_grace_seconds: int = 10
    cors_origins: list[str] = ["http://localhost:3200"]
    # Login throttle (security review finding 4), three budgets over LOGIN_WINDOW_MINUTES: the (email, client IP) pair
    # (LOGIN_MAX_ATTEMPTS: only that source waits, so an attacker cannot lock a colleague out from elsewhere), the client IP
    # over all emails (LOGIN_MAX_ATTEMPTS_IP: password spraying), and the email over all IPs (more than
    # LOGIN_MAX_ATTEMPTS_EMAIL_GLOBAL: a brake of LOGIN_EMAIL_GLOBAL_DELAY_SECONDS between attempts).
    login_max_attempts: int = 5
    login_max_attempts_ip: int = 20
    login_max_attempts_email_global: int = 25
    login_email_global_delay_seconds: int = 30
    login_window_minutes: int = 15
    # Service keys (security review finding 5): JSON {"<caller>": {"key_sha256": "<hex>", "scopes": ["marketing.read"]}}.
    # Only the sha256 lives here; the caller holds the raw key and sends it as X-Service-Key. marketing.read is accepted on
    # GET /users, /referral-codes, /commission-entries and /commission-rules only (read-only by construction).
    service_keys: dict[str, dict] = {}
    # Interactive API docs and the OpenAPI schema (security review finding 10): development only unless DOCS_ENABLED=true.
    docs_enabled: bool = False
    max_request_bytes: int = 1024 * 1024
    invitation_ttl_hours: int = 72
    # India first (docs/DECISIONS.md 2026-10-31): +91 phone prefix, all money in INR (paise).
    default_country_code: str = "91"  # prefix for national-format (leading 0, or bare 10-digit) phone numbers
    default_currency: Literal["INR"] = "INR"  # INR only: any other value fails at start-up
    # platform-core client (docs/DESIGN.md section 6). Empty base URL = not configured (provisioning answers 503).
    provisioning_base_url: str = ""
    provisioning_service_key: SecretStr = SecretStr("")  # X-Service-Key holding scope onboarding.submit
    provisioning_timeout: float = 15.0
    # Invitation delivery: "mock" (in-memory outbox, nothing leaves the process) or "webhook" (POST to a mail relay).
    delivery_provider: str = "mock"
    delivery_webhook_url: str = ""
    delivery_webhook_token: SecretStr = SecretStr("")
    signup_base_url: str = "http://localhost:3200"  # public sign-up site; the invite link is {signup_base_url}/signup?token=
    # Document upload
    document_max_bytes: int = 5 * 1024 * 1024
    document_storage: str = "local"  # "local" (disk) ; tests use the in-memory store
    document_storage_dir: str = "./var/documents"


DEFAULT_JWT_SECRET = Settings.model_fields["jwt_secret"].default


def validate_settings(s: Settings) -> None:
    """Refuse to start outside development with a default or short signing secret."""
    if s.env != "development" and (s.jwt_secret == DEFAULT_JWT_SECRET or len(s.jwt_secret) < 32):
        raise RuntimeError("JWT_SECRET must be set to a unique value of at least 32 characters "
                           f"when ENV={s.env!r} (only ENV=development may use the default)")


settings = Settings()
validate_settings(settings)
