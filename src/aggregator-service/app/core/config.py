from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

MIN_SECRET_BYTES = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "production"  # fail closed: only the literal "development" relaxes anything
    database_url: str = "postgresql+psycopg://pos:pos@localhost:5460/agg_dev"
    # Tenant callers: `Authorization: Bearer <HS256 jwt>` with claims tid, exp, aud (and iss if configured).
    jwt_secret: SecretStr = SecretStr("")
    jwt_audience: str = "aggregator-service"
    jwt_issuer: str = ""
    jwt_leeway_seconds: int = 30
    # Internal callers (worker, platform admin): a DIFFERENT secret; tokens carry role=worker|admin and no tenant.
    internal_jwt_secret: SecretStr = SecretStr("")
    # Per-store secrets are env var NAMES inside the tenant's own namespace: AGG_SECRET_<TENANT>__<NAME>.
    secret_ref_prefix: str = "AGG_SECRET_"
    enable_mock_provider: bool = False
    # Webhooks
    webhook_max_body_bytes: int = 262_144
    webhook_tolerance_seconds: int = 300
    webhook_bad_sig_limit: int = 10  # per (client ip, store mapping) per window; also bounds audit rows
    webhook_bad_sig_window_seconds: int = 60
    # pos-service (docs/DELIVERY_EXTRACTION_PLAN.md section 5)
    pos_base_url: str = ""
    pos_timeout_seconds: float = 10.0
    outbox_backoff_base_seconds: float = 5.0
    outbox_backoff_max_seconds: float = 3600.0
    outbox_max_attempts: int = 8

    @property
    def is_dev(self) -> bool:
        return self.env == "development"


settings = Settings()


def check_startup(s: Settings) -> None:
    """Refuse to start unsafe: everything except the explicit ENV=development is treated as production."""
    if s.is_dev:
        return
    for name, sec in (("JWT_SECRET", s.jwt_secret), ("INTERNAL_JWT_SECRET", s.internal_jwt_secret)):
        if len(sec.get_secret_value().encode()) < MIN_SECRET_BYTES:
            raise RuntimeError(f"{name} must be set to at least {MIN_SECRET_BYTES} bytes unless ENV=development")
    if s.jwt_secret.get_secret_value() == s.internal_jwt_secret.get_secret_value():
        raise RuntimeError("INTERNAL_JWT_SECRET must differ from JWT_SECRET")
    if s.enable_mock_provider:
        raise RuntimeError("ENABLE_MOCK_PROVIDER is only allowed when ENV=development")
    if not s.pos_base_url.startswith("https://"):
        raise RuntimeError("POS_BASE_URL must be an https URL unless ENV=development")
