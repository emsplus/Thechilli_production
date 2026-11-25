import re

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "production"  # fail closed: local dev, tests and CI must set ENV=development
    database_url: str = "postgresql+psycopg://pos:pos@localhost:5460/pos"
    # DB role split (docs/PHASE1_PLAN.md PR 1). DATABASE_URL is the API's login (pos_app: no superuser, no BYPASSRLS, owns
    # nothing). MIGRATION_DATABASE_URL is the migrator's login (pos_migrator), read only by alembic/env.py and
    # docker/migrate.py; empty = DATABASE_URL, so a setup without the split behaves exactly as before. MIGRATION_ROLE is the
    # role Alembic switches to (`SET ROLE`, e.g. pos_owner) so objects it creates are owned by the owner role, not the login.
    migration_database_url: str = ""
    migration_role: str = ""
    # Emergency override of the startup role check (app/core/db_roles.check_runtime_role): start even though the API's database
    # login is a superuser / BYPASSRLS / owns tenant tables. Logged as an error on every start.
    allow_privileged_db_role: bool = False
    # TENANT_GUARD (docs/PHASE1_PLAN.md PR 2 "staging guard"): off (default) | log | raise. log/raise report every statement
    # that touches a tenant table while no tenant is bound to the transaction (app/core/tenancy.py). Staging only.
    tenant_guard: str = "off"
    jwt_secret: str = "dev-only-secret-change-me-0123456789abcdef"
    jwt_algorithm: str = "HS256"
    jwt_issuer: str = "pos-service"  # `iss` / `aud` of access tokens; decode requires both (tokens minted before this are refused once)
    jwt_audience: str = "pos-api"
    # API docs (/api/v1/docs, openapi.json) are served only in development unless DOCS_ENABLED=true / false says otherwise.
    docs_enabled: bool | None = None
    access_token_minutes: int = 15  # security review finding 11: was 30; logout leaves at most this long
    refresh_token_days: int = 30  # rotating refresh tokens; a device idle longer than this must sign in again
    refresh_reuse_grace_seconds: int = 10  # a just-rotated token replayed within this window is NOT treated as theft
    # CORS_ORIGINS. capacitor://localhost is the iOS waiter app's WebView origin (keep it last: the first entry is the fallback
    # base URL of emailed links, services/account_mail.py).
    cors_origins: list[str] = ["http://localhost:3000", "capacitor://localhost"]
    # POST /auth/register-restaurant is public: sign-ups per client IP and in total per hour (services/abuse.py), 429 beyond.
    register_per_ip_per_hour: int = 5
    register_global_per_hour: int = 100
    # Login throttle (security review finding 4), three budgets over LOGIN_WINDOW_MINUTES, all DB-backed:
    #  * (email, client IP): LOGIN_MAX_ATTEMPTS failures -> that SOURCE waits until the window ends. Someone hammering a
    #    victim's address from their own network locks out only themselves, never the victim on another network.
    #  * client IP, any email: LOGIN_MAX_ATTEMPTS_IP failures -> that IP waits (password spraying, credential stuffing).
    #  * email, any IP: more than LOGIN_MAX_ATTEMPTS_EMAIL_GLOBAL failures -> a brake of LOGIN_EMAIL_GLOBAL_DELAY_SECONDS
    #    between attempts on that email (a distributed attack slows to a crawl; the owner can still get in between).
    login_max_attempts: int = 5
    login_max_attempts_ip: int = 20
    login_max_attempts_email_global: int = 25
    login_email_global_delay_seconds: int = 30
    # SELF_REGISTER_ENABLED (docs/STAFF_WIRING_CHECK.md "Sign-up"): POST /auth/register-restaurant creates a tenant directly,
    # outside platform-core's provisioning workflow. Production sign-up goes through platform-core POST
    # /onboarding/applications (one workflow for self-signup and assisted onboarding), so the direct path is for local / e2e /
    # demo only. Unset = on when ENV=development, off otherwise; true / false forces it. Off: 403 self_register_disabled with
    # `signup_url` (SIGNUP_URL, e.g. https://thechilli.ai/signup) in the error details.
    self_register_enabled: bool | None = None
    signup_url: str = ""
    login_window_minutes: int = 15
    # Optional TOTP for owners / managers (security review finding 7, docs/AUTH_CONTRACT.md). MFA_REQUIRED_ROLES
    # (comma separated, e.g. "owner,manager"; default empty = optional for everyone) forces enrolment at the next sign-in.
    # MFA_ENCRYPTION_KEY: Fernet key for the TOTP secrets; required outside development before anyone can enrol.
    mfa_required_roles: str = ""
    mfa_encryption_key: SecretStr = SecretStr("")
    mfa_issuer: str = "TheChilli.ai"
    mfa_challenge_minutes: int = 5
    max_request_bytes: int = 12 * 1024 * 1024  # > max_upload_bytes to leave room for multipart overhead

    # Owner decision 2026-10-31: India only, all money INR. Country, currency and timezone are not settings: they are the
    # constants of app/services/localisation.py (IN / INR / Asia/Kolkata), and the database refuses anything else.
    # COMMS_ENABLE_LANGUAGES=1: emails and WhatsApp templates may be sent in Hindi when asked (`language` / `locale` field,
    # Accept-Language). Off (default): always English. Voice ordering stays multilingual regardless.
    comms_enable_languages: bool = False
    # ATTENDANCE_GEO=1: clock-in / clock-out store the optional {lat, lng, accuracy_m} the device sends. Off (default): any
    # location in the request is ignored and never stored.
    attendance_geo: bool = False

    receipt_link_days: int = 7  # RECEIPT_LINK_DAYS: lifetime of WhatsApp/share receipt links (was 30; security review 9)
    # PUBLIC_BASE_URL: externally reachable origin of this API, e.g. https://pos.example.com. Empty = derive from the
    # request's Host header (works only where that host is reachable, e.g. the same laptop in development).
    public_base_url: str = ""
    public_rate_limit_per_minute: int = 30  # per client IP on the public receipt route
    # Table QR codes and guest reviews (docs/TABLE_QR_REVIEWS.md). TABLE_QR_BASE_URL: origin the printed QR codes point at, e.g.
    # https://order.thechilli.zonov.ai (needs the router lines of deploy/PATCH-QR-routes.md); empty = PUBLIC_BASE_URL (the API
    # host, where this service already answers /m/ and /rv/). Set it BEFORE printing: a printed QR keeps the origin it was made with.
    table_qr_base_url: str = ""
    # TABLE_QR_SECRET (>= 32 chars, optional): signs the QR tokens. Empty = a key derived from JWT_SECRET, so rotating JWT_SECRET
    # would also kill every printed QR; set this to keep printed codes alive across a JWT secret rotation.
    table_qr_secret: str = ""
    table_qr_menu_per_minute: int = 60  # public menu loads per client IP (per process, in memory)
    table_qr_menu_cache_seconds: int = 30  # server cache of a restaurant's public menu; browsers may keep it 60 s
    review_per_ip_table_per_hour: int = 5  # review submissions per client IP and QR (table or general)
    review_per_ip_per_hour: int = 15  # review submissions per client IP over all tables / restaurants
    review_per_table_per_hour: int = 60  # review submissions per QR (flood guard: a leaked code cannot fill the list)
    review_lookup_per_ip_per_minute: int = 30  # unknown / invalid review tokens per client IP before a short lockout

    gemini_api_key: str = ""
    # Test hook, off by default: a folder of `<sha256 of the uploaded file>.json` files (an `Extracted` each). A scan whose file
    # matches one is "read" from it instead of calling Gemini; any other file goes to the normal extractor. The e2e suite
    # uses it to scan a known bill without a Gemini key.
    ocr_fixture_dir: str = ""
    # GEMINI_MODEL has no default on purpose: set a valid id (see app/services/gemini.py; startup logs a warning when it is
    # empty or unknown). Last checked against Google's docs 2026-10-30: gemini-3.8-flash is stable.
    gemini_model: str = ""
    # Invoice scanning (OCR). GEMINI_OCR_FAST_MODEL is tried first (about 2x faster); its answer is only kept when the numbers add
    # up (see services/ocr.py `consistent`), otherwise the main model reads the bill again. "" = always the main model.
    # GEMINI_OCR_THINKING is the thinking level of the main model ("low" measured ~35% faster with the same lines and totals).
    gemini_ocr_fast_model: str = "gemini-3.5-flash-lite"  # 3.1-flash-lite shuts down 2027-05-07 (Google recommends 3.5)
    gemini_ocr_thinking: str = "low"
    # Voice / typed order taking (POST /ai/voice-order). GEMINI_VOICE_MODEL empty = GEMINI_MODEL. GEMINI_VOICE_THINKING is
    # the Gemini 3 thinking level ("low" measured ~2x faster than the default with the same answers on the Karahi menu;
    # "" = the model's default). A model that rejects the level is retried once without it.
    gemini_voice_model: str = ""
    gemini_voice_thinking: str = "low"
    # Voice provider: "local" (default; deterministic parser, text only, no network, no cost), "gemini" (real API, needs
    # GEMINI_API_KEY + a model id; audio orders need it), "auto" (gemini when GEMINI_API_KEY is set, else local) or "fake"
    # (tests). The real API is never reached by default.
    voice_provider: str = "local"
    # Testing-phase switch (docs/VOICE_WAKE_SAMPLES.md): the Chilli Agent business app may send TEXT-ONLY wake-word samples
    # (POST /voice/wake-samples) and fetch learned wake variants (GET /voice/wake-config). Default OFF: the POST is a 404 and the
    # GET says share_samples=false. Set VOICE_SAMPLES_ENABLED=true only for the owner's own testers; leave it off for real customers.
    voice_samples_enabled: bool = False
    voice_samples_per_user_per_hour: int = 30  # POST /voice/wake-samples calls per signed-in user per hour (429 beyond)
    voice_rate_per_user_per_minute: int = 20
    voice_rate_per_tenant_per_minute: int = 60
    voice_daily_request_cap: int = 2000  # per restaurant per UTC day; 0 = no cap
    # Estimated AI provider cost in millionths of a rupee (all money is INR): cap per restaurant per UTC day (0 = no cap),
    # and the estimate charged per typed/transcript parse and per audio parse (provider "gemini" only).
    voice_daily_cost_cap_micros: int = 420_000_000  # about ₹420 a day
    voice_cost_text_micros: int = 25_000
    voice_cost_audio_micros: int = 250_000
    voice_transcript_retention_days: int = 30  # transcripts kept this long for review; 0 = never stored. Audio is never stored.
    voice_purge_seconds: int = 3600  # background purge interval; 0 = off
    voice_menu_cache_seconds: int = 600  # compact menu text per restaurant; also re-checked against a menu fingerprint
    # Recipe suggestions (Manage > Recipes > "Suggest recipe with AI"). GEMINI_RECIPE_MODEL empty = GEMINI_MODEL.
    gemini_recipe_model: str = ""
    gemini_recipe_thinking: str = "low"
    # ---- provider choice (docs/AI_PROVIDERS.md). Keys come ONLY from the environment and are never logged, stored or returned.
    # AI_OCR_PROVIDER: gemini | xai | auto (auto = xai when its key is set, else gemini). Invoice / bill scanning.
    ai_ocr_provider: str = "auto"
    # AI_STT_PROVIDER: gemini | whisper | auto (auto = whisper when OPENAI_API_KEY is set, else gemini). Speech to text of audio orders.
    ai_stt_provider: str = "auto"
    # AI_TEXT_PROVIDER: gemini | xai | auto (auto = gemini). The language-model fallback of voice parsing and recipe suggestions.
    # Ask-AI (tool calling) stays on Gemini.
    ai_text_provider: str = "auto"
    # xAI (Grok), OpenAI-compatible API. GROK_API_KEY is accepted as an alias of XAI_API_KEY.
    xai_api_key: str = ""
    grok_api_key: str = ""
    xai_base_url: str = "https://api.x.ai/v1"
    xai_vision_model: str = "grok-4.3"  # any Grok model that accepts image input; change it in the environment
    xai_text_model: str = ""  # AI_TEXT_PROVIDER=xai; empty = XAI_VISION_MODEL
    xai_max_pages: int = 8  # PDF pages sent to the vision model
    xai_max_payload_bytes: int = 15 * 1024 * 1024  # all page images together (JPEG bytes, before base64)
    # OpenAI speech to text.
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    whisper_model: str = "whisper-1"  # or gpt-4o-transcribe / gpt-4o-mini-transcribe (see docs/AI_PROVIDERS.md)
    whisper_language: str = ""  # empty = auto-detect; "hi" or "en" force it
    whisper_prompt_max_chars: int = 500  # whisper-1 reads at most ~224 tokens of prompt
    stt_max_seconds: int = 120  # longest recording accepted (checked exactly for wav, by size for the other formats)
    stt_max_bytes: int = 10 * 1024 * 1024
    ai_http_timeout_seconds: float = 60
    ai_retry_backoff_seconds: float = 1.0  # one retry on 429 / 5xx after this pause

    # Supplier re-order emails (services/reorder.py). The mailbox comes ONLY from the environment; the password is a SecretStr
    # (repr/str show asterisks) and is never logged or returned by an endpoint. SMTP_HOST empty = email is not set up.
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_security: str = "ssl"  # ssl | starttls | none
    smtp_user: str = ""
    smtp_password: SecretStr = SecretStr("")
    smtp_from: str = ""  # defaults to SMTP_USER
    smtp_timeout: float = 20.0
    # Test hook, off by default: a folder. Instead of SMTP every email is written there as `<id>.json` (the e2e suite uses it,
    # so tests never touch a real mailbox). Counts as "configured".
    email_sink_dir: str = ""
    # Dev-only default mail sink (docs/COMMS.md): with ENV=development and no SMTP_HOST / EMAIL_SINK_DIR, password-reset and
    # notice emails are written here as JSON files instead of being sent. Never used outside development.
    mail_dev_dir: str = "storage/dev-mail"
    # Mail policy (docs/EMAIL.md): which recipients really get mail through SMTP_*. real = everyone (production);
    # allowlist = only addresses in a MAIL_ALLOWLIST_DOMAINS domain or exactly SMTP_TEST_TO, everyone else goes to the
    # local mail catcher (MAILPIT_SMTP_HOST) so demo / e2e users never trigger real mail; mailpit = everything to the
    # catcher; log = nothing is sent (a redacted log line; in development also a MAIL_DEV_DIR file).
    # Empty = real when ENV=production, allowlist otherwise.
    mail_policy: str = ""
    mail_allowlist_domains: str = "zonov.ai"  # comma separated
    smtp_test_to: str = ""  # one extra address that is always really sent under the allowlist policy
    mailpit_smtp_host: str = ""  # local SMTP catcher (compose: mailpit); plain SMTP, no login
    mailpit_smtp_port: int = 1025
    # E-mail one-time codes (services/otp.py): sign-up verification and password reset. 6 digits, single use, stored as an
    # HMAC only, at most OTP_MAX_ATTEMPTS wrong tries, one new code per OTP_RESEND_SECONDS, hourly limits per email and per IP.
    otp_minutes: int = 10
    otp_max_attempts: int = 5
    otp_resend_seconds: int = 60
    otp_per_email_per_hour: int = 5
    otp_per_ip_per_hour: int = 20
    otp_verify_per_ip_per_hour: int = 60
    # SIGNUP_EMAIL_VERIFICATION (default on): POST /auth/register-restaurant only stores a pending sign-up and emails a code;
    # POST /auth/verify-email creates the restaurant and returns the session. Off = the old immediate sign-up.
    signup_email_verification: bool = True
    # PASSWORD_RESET_MODE: otp (default; POST /auth/forgot-password emails a 6-digit code, then /auth/password-reset/verify and
    # /complete) | link (the older emailed link to /reset-password). /auth/reset-password keeps accepting links already sent.
    password_reset_mode: str = "otp"
    # End of day report email (services/daily_report.py): sweep interval (0 = off) and whether the PDF is attached.
    daily_report_sweep_seconds: int = 300
    daily_report_attach_pdf: bool = True
    # Origin of the web app the password-reset link points to (e.g. https://app.example.com); empty = PUBLIC_BASE_URL.
    app_base_url: str = ""
    password_reset_minutes: int = 30
    forgot_per_ip_per_hour: int = 10  # POST /auth/forgot-password, per client IP and per email (abuse counters)
    forgot_per_email_per_hour: int = 3
    reset_per_ip_per_hour: int = 30  # POST /auth/reset-password attempts per client IP
    # WhatsApp (services/whatsapp.py). WHATSAPP_PROVIDER: meta | file (dev log sink) | none. Empty = file in development, none
    # elsewhere. The access token / app secret / verify token are SecretStr: never logged or returned.
    whatsapp_provider: str = ""
    whatsapp_phone_number_id: str = ""
    whatsapp_access_token: SecretStr = SecretStr("")
    whatsapp_app_secret: SecretStr = SecretStr("")  # signs inbound webhook posts (X-Hub-Signature-256)
    whatsapp_verify_token: SecretStr = SecretStr("")  # echoed by the webhook subscription handshake
    whatsapp_api_version: str = "v21.0"
    whatsapp_timeout: float = 15.0
    whatsapp_default_region: str = "IN"  # numbers without a country code are read in this country
    whatsapp_sweep_seconds: int = 30  # outbox runner interval; 0 = off
    whatsapp_max_attempts: int = 6
    whatsapp_backoff_seconds: str = "30,120,600,3600,21600"  # wait after attempt 1, 2, ...; tests set zeros
    whatsapp_dev_dir: str = "storage/dev-whatsapp"
    reorder_sweep_seconds: int = 300  # background sweep for low items that waited for their supplier's window; 0 = off
    storage_dir: str = "storage"
    max_upload_bytes: int = 10 * 1024 * 1024
    max_image_bytes: int = 5 * 1024 * 1024  # menu photos (re-encoded to small WebP files anyway)
    # Print hub pairing brute-force limits (services/printing.py pair_hub), DB-backed. Failed attempts per client IP, per code
    # and globally within the window lock that key for the lockout.
    hub_pair_ip_max_failures: int = 5
    hub_pair_code_max_failures: int = 5
    hub_pair_global_max_failures: int = 100
    hub_pair_window_minutes: int = 15
    hub_pair_lockout_minutes: int = 15
    # Device sessions, counter devices, staff PINs (docs/STAFF_PIN_DEVICES_API.md, services/devices.py, services/staff_pin.py).
    device_retention_days: int = 90  # a signed-in device unseen this long (and with no live refresh token) is deleted
    pin_session_retention_days: int = 30  # ended / expired PIN sessions are deleted after this
    pin_idle_minutes: int = 15  # a PIN session with no request for this long is locked (sign in with the PIN again)
    pin_session_max_hours: int = 12  # hard maximum of a PIN session however active it is
    pin_max_failures: int = 5  # wrong PINs per (user, counter device) before a lockout
    pin_lockout_minutes: int = 15  # first lockout; each further lockout doubles it ...
    pin_lockout_max_minutes: int = 24 * 60  # ... up to this
    pin_user_failures_per_hour: int = 15  # wrong PINs of one user across all devices per hour before that user is locked everywhere
    pin_login_per_ip_per_10min: int = 60  # POST /auth/pin-login calls per client IP (every call counts)
    pin_login_per_device_per_10min: int = 30  # ... and per counter device
    # PIN_PEPPER: optional server secret mixed into every PIN before hashing (HMAC-SHA256), so a database dump alone cannot be
    # brute-forced offline. Changing or removing it makes the PINs hashed with it unusable (staff set them again).
    pin_pepper: SecretStr = SecretStr("")
    # Permissions a PIN session never gets, even when the user's role has them: account administration should need the
    # password. Comma separated; "" = a PIN session has exactly the user's permissions.
    pin_session_excluded_permissions: str = ("roles.manage,users.manage,staff.manage_roles,staff.reset_password,"
                                             "settings.owner,payments.setup,devices.manage")
    # STEP_UP_REQUIRED=1: voiding a bill and a discount above the cashier cap need a fresh step-up token (POST /auth/step-up,
    # header X-Step-Up-Token). Off (default): nothing changes.
    step_up_required: bool = False
    step_up_minutes: int = 5
    # Print hub long poll (services/printing.py): idle checks start at PRINT_POLL_INTERVAL_SECONDS and back off to the max; the
    # sweeper (stale `sent` jobs, expired slips) runs every PRINT_SWEEP_SECONDS (0 = off) instead of on every poll; a hub's
    # bearer token lookup is cached HUB_AUTH_CACHE_SECONDS (0 = off).
    print_poll_interval_seconds: float = 1.0
    print_poll_interval_max_seconds: float = 3.0
    print_sweep_seconds: int = 10
    hub_auth_cache_seconds: int = 30
    # Database pool (app/core/db.py). A long poll holds a connection only for the milliseconds of one check.
    db_pool_size: int = 10
    db_max_overflow: int = 10
    db_pool_timeout: float = 30.0
    db_pool_recycle_seconds: int = 1800
    print_retry_delays: str = "5,15,30,60,120,180,300"  # seconds to wait after each failed print attempt (about 12 minutes in all); tests set zeros
    # Delivery service principal (docs/DELIVERY_API.md). DELIVERY_TOKEN_SECRET signs the tenant-bound service tokens (HS256, its
    # own key, never the login key). DELIVERY_SERVICE_KEYS lists the tokens that are accepted, by hash only:
    # "kid:sha256hex(token):scope+scope,kid2:..." (scopes: menu:read orders:read orders:write). Empty = the delivery API is off.
    delivery_token_secret: SecretStr = SecretStr("")
    delivery_service_keys: str = ""
    delivery_outbox_sweep_seconds: int = 5  # background runner of the delivery webhook outbox; 0 = off (use scripts/run_delivery_outbox.py)
    delivery_outbox_max_attempts: int = 8  # then the event is `dead` (visible in GET /delivery/admin/outbox, retry by hand)
    delivery_outbox_backoff_base_seconds: int = 15  # attempt n waits base * 2^(n-1), capped at delivery_outbox_backoff_max_seconds
    delivery_outbox_backoff_max_seconds: int = 3600
    delivery_webhook_timeout_seconds: float = 10.0
    # Public ordering link: pos-service -> delivery-service (docs/DELIVERY_API.md). DELIVERY_SERVICE_URL = its internal base URL
    # (empty = the link feature is not connected). Per tenant token: set through PUT /delivery/settings (stored encrypted); for a
    # single-tenant stack DELIVERY_SERVICE_TOKEN is the fallback for every tenant without its own.
    delivery_service_url: str = ""
    delivery_service_token: SecretStr = SecretStr("")
    public_link_timeout_seconds: float = 2.0
    extraction_stale_minutes: int = 10  # an invoice still `uploaded` after this long is considered stuck

    # Entitlements (docs/ENTITLEMENTS.md): what platform-core says a tenant may use. ENTITLEMENTS_ENFORCE: off (default, nothing
    # is fetched or enforced) | warn (fetched, violations are logged and flagged, never blocked) | on (enforced).
    entitlements_enforce: str = "off"
    platform_core_url: str = ""  # e.g. http://platform-core:8000/api/v1 (no trailing slash)
    platform_service_key: SecretStr = SecretStr("")  # X-Service-Key, scopes entitlements:read (+ support_access.verify)
    entitlements_timeout_seconds: float = 2.0
    entitlements_cache_ttl_seconds: int = 60  # a cached answer younger than this is used without calling platform-core
    entitlements_retry_seconds: int = 10  # after a failed fetch, do not call platform-core again for this long
    # Outage grace: when platform-core cannot be reached the last known entitlements keep applying (fail OPEN) for this long
    # from the last good answer (from the first failure when there never was one), then the tenant is read-only.
    entitlements_grace_seconds: int = 86400
    entitlements_unknown_tenant: str = "allow"  # platform-core 404 (tenant not provisioned there yet): allow | deny (read-only)
    entitlements_absent_feature: str = "allow"  # a feature code missing from the tenant's map: allow (legacy tenants) | deny
    # PAYG wallet (docs/PAYG_BILLING.md). platform-core holds the wallet; pos-service reports every finalized / voided bill
    # (transactional outbox billing_usage_outbox) and refuses NEW bills when the wallet is empty / billing is suspended.
    # The service key (PLATFORM_SERVICE_KEY) needs scopes billing.read, billing.usage.write, billing.topup for this.
    # CHILLI_ENFORCE (alias WALLET_ENFORCE): off = the wallet only shows the balance and records usage (default, the demo keeps
    # working) | warn = log + X-Billing-Warning | on = a NEW order is refused with 402 chilli_empty once the Chilli are used up AND the grace
    # (CHILLI_GRACE_ORDERS, set in platform-core: 20 more orders after the balance reaches 0) is spent
    # (billing_suspended when support paused billing). An open order can always be billed and paid; synced orders never refused.
    wallet_enforce: str = Field("off", validation_alias=AliasChoices("CHILLI_ENFORCE", "WALLET_ENFORCE"))
    wallet_metering: bool = True  # write usage outbox rows (sent only when PLATFORM_CORE_URL / PLATFORM_SERVICE_KEY are set)
    billing_usage_sweep_seconds: int = 10  # background sender of the usage outbox; 0 = off (scripts/run_billing_usage.py)
    billing_usage_batch: int = 100
    billing_usage_backoff_base_seconds: int = 15  # attempt n waits base * 2^(n-1), capped; rows are NEVER dropped
    billing_usage_backoff_max_seconds: int = 3600
    billing_usage_unmanaged_retry_seconds: int = 86400  # platform-core does not know the tenant: try again this much later
    wallet_offline_max_age_hours: int = 168  # an offline bill's client time is trusted back this far (trial decision)
    billing_proxy_timeout_seconds: float = 5.0  # owner wallet / ledger / usage reads proxied to platform-core
    # Support access (platform-core RS256 tokens, verified via JWKS). Off by default.
    support_access_enabled: bool = False
    support_jwks_url: str = ""  # e.g. http://platform-core:8000/.well-known/jwks.json
    support_issuer: str = "chilli-platform-core"
    support_audience: str = "chilli-support-access"
    support_verify_grant: bool = True  # also ask platform-core whether the grant is still active (revocation), fail closed
    # payments-service (docs/PAYMENTS_INTEGRATION.md). Online payments are enabled only when BOTH the URL and the secret are set.
    # PAYMENTS_JWT_SECRET must equal payments-service's JWT_SECRET; audience / issuer must match its JWT_AUDIENCE / JWT_ISSUER
    # (an empty JWT_ISSUER there accepts any issuer). Calls carry a short-lived HS256 token whose `tid` is the restaurant id.
    payments_service_url: str = ""
    payments_jwt_secret: SecretStr = SecretStr("")
    payments_jwt_audience: str = "payments-service"
    payments_jwt_issuer: str = "pos-service"
    payments_token_ttl_seconds: int = 60
    payments_timeout_seconds: float = 5.0  # connect + read; a cashier is waiting, the call is retried by idempotency key
    # Optional public base URL of payments-service, only used to show the owner the webhook URL to paste into Razorpay.
    payments_public_url: str = ""

    # Provisioning (docs/PROVISIONING.md): platform-core creates tenants through /internal/provision/*. The credential is a
    # dedicated key whose SHA-256 (hex) is configured here, never the key itself. Empty = the endpoints answer 404 (disabled).
    provision_key_sha256: str = ""
    provision_key_scopes: str = "provision.create,provision.read"  # comma separated
    provision_ip_allowlist: str = ""  # comma separated IPs / CIDRs; empty = any address (the key is still required)
    provision_invite_hours: int = 72  # lifetime of the owner's "set your password" invite
    provision_fail_per_ip_per_15min: int = 20  # wrong keys per client IP before 429

    @field_validator("smtp_port", "smtp_timeout", "reorder_sweep_seconds", "whatsapp_timeout", "whatsapp_sweep_seconds",
                     "mailpit_smtp_port", "daily_report_sweep_seconds", mode="before")
    @classmethod
    def _blank_is_default(cls, v, info):  # `SMTP_PORT=` in a compose env file arrives as ""
        return cls.model_fields[info.field_name].default if isinstance(v, str) and not v.strip() else v

    @field_validator("tenant_guard", mode="before")
    @classmethod
    def _tenant_guard(cls, v):
        v = (v or "off").strip().lower() if isinstance(v, str) else v
        if v not in ("off", "log", "raise"):
            raise ValueError("TENANT_GUARD must be off, log or raise")
        return v

    @field_validator("whatsapp_provider", mode="before")
    @classmethod
    def _wa_provider(cls, v):
        v = (v or "").strip().lower() if isinstance(v, str) else v
        if v not in ("", "meta", "file", "none"):
            raise ValueError("WHATSAPP_PROVIDER must be meta, file or none")
        return v

    @field_validator("entitlements_enforce", "wallet_enforce", mode="before")
    @classmethod
    def _entitlements_enforce(cls, v, info):
        v = (v or "off").strip().lower() if isinstance(v, str) else v
        v = {"true": "on", "1": "on", "yes": "on", "false": "off", "0": "off", "no": "off"}.get(v, v) if isinstance(v, str) else v
        if v not in ("off", "warn", "on"):
            raise ValueError(f"{info.field_name.upper()} must be off, warn or on")
        return v

    @field_validator("entitlements_unknown_tenant", "entitlements_absent_feature", mode="before")
    @classmethod
    def _allow_deny(cls, v, info):
        v = (v or "allow").strip().lower() if isinstance(v, str) else v
        if v not in ("allow", "deny"):
            raise ValueError(f"{info.field_name.upper()} must be allow or deny")
        return v

    @field_validator("mail_policy", mode="before")
    @classmethod
    def _mail_policy(cls, v):
        v = (v or "").strip().lower() if isinstance(v, str) else v
        if v not in ("", "real", "allowlist", "log", "mailpit"):
            raise ValueError("MAIL_POLICY must be real, allowlist, log or mailpit")
        return v

    @field_validator("smtp_security", mode="before")
    @classmethod
    def _security(cls, v):
        v = (v or "ssl").strip().lower() if isinstance(v, str) else v
        if v not in ("ssl", "starttls", "none"):
            raise ValueError("SMTP_SECURITY must be ssl, starttls or none")
        return v


def self_register_allowed(s: "Settings") -> bool:
    return s.env == "development" if s.self_register_enabled is None else bool(s.self_register_enabled)


def migration_url(s: "Settings") -> str:
    """The URL migrations connect with: MIGRATION_DATABASE_URL, else DATABASE_URL (unchanged single-user setups)."""
    return s.migration_database_url.strip() or s.database_url


DEFAULT_JWT_SECRET = Settings.model_fields["jwt_secret"].default


def validate_settings(s: Settings) -> None:
    """Refuse to start outside development with a default or short signing secret."""
    if s.env != "development" and (s.jwt_secret == DEFAULT_JWT_SECRET or len(s.jwt_secret) < 32):
        raise RuntimeError("JWT_SECRET must be set to a unique value of at least 32 characters "
                           f"when ENV={s.env!r} (only ENV=development may use the default)")
    if s.delivery_service_keys.strip() and len(s.delivery_token_secret.get_secret_value()) < 32:
        raise RuntimeError("DELIVERY_TOKEN_SECRET must be at least 32 characters when DELIVERY_SERVICE_KEYS is set")
    if s.table_qr_secret and len(s.table_qr_secret) < 32:
        raise RuntimeError("TABLE_QR_SECRET must be at least 32 characters (or empty to derive the key from JWT_SECRET)")
    if s.table_qr_base_url.strip() and not re.fullmatch(r"https?://[A-Za-z0-9.-]+(:\d{1,5})?/?", s.table_qr_base_url.strip()):
        raise RuntimeError("TABLE_QR_BASE_URL must be an origin such as https://order.example.com (no path)")
    for name, value, allowed in (("AI_OCR_PROVIDER", s.ai_ocr_provider, ("gemini", "xai")),
                                 ("AI_STT_PROVIDER", s.ai_stt_provider, ("gemini", "whisper")),
                                 ("AI_TEXT_PROVIDER", s.ai_text_provider, ("gemini", "xai"))):
        if (value or "auto").strip().lower() not in (*allowed, "auto"):
            raise RuntimeError(f"{name} must be one of {', '.join(allowed)}, auto (or empty)")
    if s.whisper_language.strip() and not re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z]{2,4})?", s.whisper_language.strip()):
        raise RuntimeError("WHISPER_LANGUAGE must be a language code such as hi or en (or empty for auto-detect)")
    for name, url in (("XAI_BASE_URL", s.xai_base_url), ("OPENAI_BASE_URL", s.openai_base_url)):
        if url.strip() and not url.strip().startswith(("https://", "http://localhost", "http://127.0.0.1")) and s.env != "development":
            raise RuntimeError(f"{name} must start with https:// (the key travels in the request)")


settings = Settings()
validate_settings(settings)
