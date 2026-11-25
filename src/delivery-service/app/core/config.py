from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "production"  # fail closed: dev/tests/CI must set ENV=development
    # The app connects as a NON-owner role so Row Level Security applies (docs/RLS.md). Migrations use
    # ADMIN_DATABASE_URL (owner/migrator; falls back to DATABASE_URL) and optionally SET ROLE MIGRATION_ROLE.
    database_url: str = "postgresql+psycopg://pos:pos@localhost:5460/del_dev"
    admin_database_url: str = ""
    migration_role: str = ""
    app_db_role: str = ""  # role the migrations GRANT to (the user in DATABASE_URL); empty = no grants
    # Emergency override of the startup role check (app/core/db_roles.py): start although the API's role bypasses RLS
    # (superuser, BYPASSRLS or table owner). Logs an error on every start. Never set it in a deployed environment.
    allow_privileged_db_role: bool = False
    # Root secret for tenant service tokens and customer/rider/tracking links. Each audience gets its own derived key. Must be >= 32 chars.
    link_secret: SecretStr = SecretStr("")
    # Optional keyring for rotation: "kid1:secret1,kid2:secret2" (each secret >= 32 chars, kid = [A-Za-z0-9_-]{1,16}).
    # The ACTIVE key signs new tokens; every key present verifies. Remove a kid to revoke everything it signed.
    # LINK_SECRET, when set, is the legacy key with kid "k0".
    link_keyring: SecretStr = SecretStr("")
    link_active_kid: str = ""  # default: first entry of the keyring, else "k0"
    # Owner decision 2026-10-31: English only. DELIVERY_ENABLE_LANGUAGES=1 switches the Hindi catalogue (WhatsApp replies,
    # tracking page and rider screen switcher) back on; default off.
    delivery_enable_languages: bool = False
    public_base_url: str = "http://localhost:8130"
    # Host of the per-restaurant public ordering links (https://order.thechilli.ai/r/<slug>); empty = public_base_url.
    public_order_base_url: str = ""
    # Public ordering link abuse limits (token buckets in Postgres, keys are keyed hashes, never raw IP or phone).
    # Behind a reverse proxy set TRUSTED_PROXY_HOPS to the number of proxies that append to X-Forwarded-For (0 = use the socket peer).
    trusted_proxy_hops: int = 0
    public_get_ip_capacity: float = 60.0  # menu loads per IP
    public_get_ip_refill_per_second: float = 1.0
    public_miss_ip_capacity: float = 10.0  # unknown/disabled slugs per IP (stops slug guessing)
    public_miss_ip_refill_per_second: float = 1 / 6
    public_order_ip_capacity: float = 6.0  # order attempts per IP
    public_order_ip_refill_per_second: float = 1 / 120
    public_order_phone_capacity: float = 3.0  # order attempts per phone number and restaurant
    public_order_phone_refill_per_second: float = 1 / 900
    public_order_link_capacity: float = 60.0  # order attempts per public link (protects the kitchen from a flood)
    public_order_link_refill_per_second: float = 0.5
    public_max_open_orders_per_phone: int = 3  # not yet delivered or cancelled

    # WhatsApp provider: "mock" (tests/dev) or "meta" (Cloud API). Production refuses to start with it
    # unless ALLOW_MOCK_PROVIDER=true (explicit, loud opt-in).
    whatsapp_provider: str = "mock"
    allow_mock_provider: bool = False
    # Meta app secret: HMAC-SHA256 key for X-Hub-Signature-256 on inbound webhooks.
    whatsapp_app_secret: SecretStr = SecretStr("")
    # Non-secret GET handshake challenge (hub.verify_token). Deliberately separate from the signing secret.
    whatsapp_verify_token: SecretStr = SecretStr("")

    # Meta WhatsApp Cloud API (WHATSAPP_PROVIDER=meta). The access token is a secret: env only, never stored in the DB.
    whatsapp_phone_number_id: str = ""  # default sender when a restaurant has no channel number row
    whatsapp_access_token: SecretStr = SecretStr("")
    whatsapp_api_version: str = "v21.0"
    whatsapp_graph_base: str = "https://graph.facebook.com"
    whatsapp_timeout_seconds: float = 10.0
    whatsapp_default_country_code: str = "91"  # prefixed to bare 10-digit numbers
    # Outbound rate limits (token buckets in Postgres): per sender number, and per recipient (Meta pair rate limit).
    wa_send_bucket_capacity: float = 20.0
    wa_send_refill_per_second: float = 10.0
    wa_pair_bucket_capacity: float = 10.0
    wa_pair_refill_per_second: float = 1 / 6

    pos_base_url: str = "http://localhost:8000"
    pos_timeout_seconds: float = 10.0
    secret_ref_prefix: str = "DEL_SECRET_"  # restaurant rows store env var NAMES only

    pos_webhook_max_skew_seconds: int = 300
    max_webhook_bytes: int = 256 * 1024
    menu_cache_ttl_seconds: int = 120

    otp_digits: int = 6
    otp_ttl_seconds: int = 6 * 3600
    otp_max_tries: int = 3
    rider_location_ttl_seconds: int = 30 * 60
    rider_ping_min_interval_seconds: float = 3.0
    rider_max_speed_kmh: float = 150.0
    menu_link_ttl_seconds: int = 2 * 3600
    rider_link_ttl_seconds: int = 12 * 3600
    track_link_ttl_seconds: int = 6 * 3600
    outbox_max_attempts: int = 8
    outbound_max_attempts: int = 6
    reminder_stages_seconds: tuple[int, ...] = (180, 300, 480, 720)


settings = Settings()
