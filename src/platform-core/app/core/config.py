from typing import Literal

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "production"  # fail closed: local dev, tests and CI must set ENV=development
    database_url: str = "postgresql+psycopg://pos:pos@localhost:5460/plat_dev"
    cors_origins: list[str] = ["http://localhost:3200"]

    # JWT (RS256, see docs/DESIGN.md "Token contract"). Keyring is JSON text or a file path; required in production.
    jwt_keyring: str = ""
    jwt_keyring_file: str = ""
    jwt_issuer: str = "chilli-platform-core"
    jwt_audience_staff: str = "chilli-platform-admin"
    jwt_audience_support: str = "chilli-support-access"
    access_token_minutes: int = 15
    refresh_token_days: int = 14
    refresh_reuse_grace_seconds: int = 10

    # Staff MFA (TOTP). Roles listed here MUST have MFA: after the password step they are forced to enrol (if not yet) or
    # verify a code before any session is issued. Other roles may enrol voluntarily; once enrolled, MFA is always required.
    mfa_required_roles: str = "super_admin,finance"
    mfa_issuer: str = "Chilli HQ"
    # Fernet key (urlsafe base64, 32 bytes) encrypting TOTP secrets at rest: python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"
    # Required in production; development falls back to a fixed insecure key.
    mfa_encryption_key: str = ""
    mfa_challenge_minutes: int = 5  # lifetime of the post-password step-up token
    mfa_max_failures: int = 5  # failed codes per staff member per window before 429
    mfa_window_minutes: int = 15
    mfa_recovery_codes: int = 10
    # Per-action step-up (docs/STEP_UP.md): sensitive routes need X-Step-Up-Token from POST /auth/step-up (a fresh code).
    # Unset = ON everywhere except ENV=development (local dev and tests); set true/false to force.
    step_up_required: bool | None = None
    step_up_minutes: int = 5  # grant lifetime
    step_up_max_uses: int = 1  # protected requests one grant may authorize (1 = single use)

    # marketing-service read client (team / referral / commission views). Both empty = views answer 503.
    # MARKETING_SERVICE_KEY is a scoped, read-only service key (sent as X-Service-Key; marketing-service keeps only its sha256
    # in its SERVICE_KEYS with scope marketing.read). It replaced the 365-day marketing_admin bearer token
    # (MARKETING_SERVICE_TOKEN, security review finding 5), which is no longer read.
    marketing_service_url: str = ""  # e.g. http://marketing-service:8200/api/v1
    marketing_service_key: SecretStr = SecretStr("")
    marketing_timeout_seconds: float = 5.0

    # Machine callers configured from env (in addition to DB service clients). JSON object:
    #   {"marketing-service": {"key_sha256": "<hex sha256 of the key>", "scopes": ["onboarding.submit", ...]}}
    # Only the hash is configured, never the key. Scopes may be written "a.b" or "a:b".
    service_keys: str = ""

    # Comma-separated IPs/CIDRs of reverse proxies whose X-Forwarded-For is trusted. Empty = never trust the header.
    trusted_proxies: str = ""

    # Login rate limits (DB-backed so they hold across workers)
    login_max_attempts_email: int = 5  # free failures per (email, ip) before delays start
    login_delay_base_seconds: int = 2  # delay after the first over-limit failure; doubles per further failure
    login_delay_max_seconds: int = 300
    login_max_attempts_email_global: int = 30  # failures for one email across all IPs before a (capped) brake applies
    login_global_delay_seconds: int = 30
    login_max_attempts_ip: int = 20
    login_window_minutes: int = 15
    public_intake_per_ip_per_hour: int = 10

    # Support access
    support_access_max_minutes: int = 240
    support_token_max_minutes: int = 30

    # GST: configuration only. NOT tax advice. Rate/SAC/seller details must be VERIFIED BY A CA before production.
    gst_rate_bps: int = 1800  # basis points: 1800 = 18.00%
    gst_sac_code: str = "998314"
    seller_state_code: str = "29"  # 2-digit GST state code of the supplier (place of supply logic)
    seller_gstin: str = ""
    seller_legal_name: str = "Chilli Technologies Pvt Ltd"
    invoice_due_days: int = 7

    # Entitlements
    past_due_keeps_entitlements: bool = True

    # Onboarding
    onboarding_auto_approve: bool = False  # every source (legacy switch); prefer ONBOARDING_AUTO_APPROVE_SOURCES
    # Single sign-up workflow (pos-service docs/STAFF_WIRING_CHECK.md "Sign-up"): sources whose applications are approved on
    # arrival, comma separated (self_signup, marketing, staff). Empty = every application waits for staff review.
    onboarding_auto_approve_sources: str = ""
    # Provision at once when an application is approved (auto or by staff) instead of waiting for the sweep / run-due: the
    # owner gets the set-password email within the same request. A failed attempt keeps its normal retry schedule.
    onboarding_provision_on_approve: bool = False
    default_trial_plan_code: str = "starter"
    default_trial_days: int = 7  # PAYG plans use the effective billing setting trial_days (PAYG_TRIAL_DAYS) instead
    provisioner: str = "http"  # http (pos-service, app/services/provisioner.py) | fake (in-memory, tests and demos)
    # pos-service call-out (docs/PROVISIONING.md). POS_PROVISION_KEY is the plaintext key whose sha256 pos-service holds in its
    # PROVISION_KEY_SHA256; it is sent as X-Provision-Key and never logged.
    pos_service_url: str = ""  # origin, e.g. http://pos-service:8000 (no trailing slash, no /api/v1)
    pos_provision_key: SecretStr = SecretStr("")
    pos_timeout_seconds: float = 10.0
    pos_call_retries: int = 2  # extra tries INSIDE one attempt for transport errors / 5xx / 429 (same Idempotency-Key)
    pos_call_backoff_seconds: float = 0.5  # doubles per in-call retry
    # India only, INR only (docs/INR_ONLY.md): any other value fails at start-up.
    pos_default_country: Literal["IN"] = "IN"
    pos_default_timezone: Literal["Asia/Kolkata"] = "Asia/Kolkata"
    pos_default_currency: Literal["INR"] = "INR"
    # Workflow retries (across attempts): next try after base * 2^(attempts-1) seconds, capped; after MAX attempts only staff can retry.
    provision_max_attempts: int = 6
    provision_backoff_base_seconds: int = 30
    provision_backoff_max_seconds: int = 3600
    # Retention purge (security review finding 14, app/services/retention.py). Days; 0 = keep forever.
    retention_login_days: int = 30  # login_attempts, mfa_attempts
    retention_refresh_token_days: int = 30  # after expiry / revocation
    retention_security_event_days: int = 365  # never below 90 (database trigger)
    retention_audit_days: int = 730  # never below 90 (database trigger); NEEDS LEGAL REVIEW
    retention_sweep_seconds: int = 86400  # background purge interval; 0 = off (run `python -m app.services.retention`)
    provision_sweep_seconds: int = 0  # background sweep (queued / due retries / owner_invited -> live); 0 = off, POST /onboarding/provisioning/run-due instead
    provision_stale_minutes: int = 10  # an application stuck in `provisioning` this long is reclaimed by the sweep
    # Owner invite email. {token} (and {tenant_id}) are substituted into the template; the page must POST the token and the new
    # password to pos-service /api/v1/auth/accept-invite.
    owner_invite_url_template: str = "http://localhost:3010/accept-invite?token={token}"
    mailer: str = "smtp"  # smtp | fake
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_security: str = "ssl"  # ssl | starttls | none
    smtp_user: str = ""
    smtp_password: SecretStr = SecretStr("")
    smtp_from: str = ""  # defaults to SMTP_USER
    smtp_timeout: float = 20.0
    # Mail policy (docs/PROVISIONING.md "Email"; same rules as pos-service docs/EMAIL.md): real = everyone; allowlist = only
    # MAIL_ALLOWLIST_DOMAINS domains or exactly SMTP_TEST_TO get real mail, everyone else goes to the catcher MAILPIT_SMTP_HOST
    # (plain SMTP, no login); mailpit = everything to the catcher; log = nothing sent. Empty = real in production, else allowlist.
    mail_policy: str = ""
    mail_allowlist_domains: str = "zonov.ai"
    smtp_test_to: str = ""
    mailpit_smtp_host: str = ""
    mailpit_smtp_port: int = 1025

    # Pay-as-you-go wallet (docs/PAYG_BILLING.md). Platform-wide DEFAULTS; plans and tenants override them in billing_settings.
    payg_billing_model: str = "payg"  # payg | subscription (subscription = old behaviour: trial end switches features off, no metering)
    payg_trial_days: int = 7
    payg_per_bill_paise: int = 500  # â¹5.00 per finalized bill
    payg_fee_gst_mode: str = "inclusive"  # inclusive: the â¹5 contains GST | exclusive: â¹5 + GST is debited. OPEN QUESTION (CA)
    payg_charge_zero_bills: bool = False  # bills with total <= 0 are not charged
    payg_low_balance_paise: int = 10000  # â¹100 (= 20 bills at â¹5): state `low` below this
    payg_grace_paise: int | None = None  # explicit overdraft in paise; None = CHILLI_GRACE_ORDERS x the fee per bill
    chilli_grace_orders: int = 20  # after the balance reaches 0 the restaurant may take this many MORE orders (20 x 5 = 100 Chilli of debt), then `blocked`
    payg_min_topup_paise: int = 200000  # Rs 2,000 = 2,000 Chilli: minimum ONLINE recharge (whole rupees; admin credit is not limited)
    payg_bonus_tiers: str = ""  # JSON list [{"min_paise": 50000, "bonus_paise": 2500}], empty = no bonus
    billing_timezone: str = "Asia/Kolkata"  # month boundaries of usage statements
    billing_sweep_seconds: int = 0  # background trial-notice / trial-conversion sweep; 0 = off (POST /admin/billing/run-due)
    billing_outbox_lease_seconds: int = 120
    billing_outbox_max_attempts: int = 10
    receipt_prefix: str = "CR"  # wallet receipt numbers CR/2627/000001 (financial year series; CA to confirm)
    # Chilli recharge (docs/CHILLI_WALLET.md). 1 rupee paid = 1 Chilli. Chilli's OWN single Razorpay account (not per tenant).
    topup_online_enabled: bool = False  # recharge links on/off (503 topup_unavailable while off)
    razorpay_webhook_enabled: bool = False  # webhook answers 404 while off (it is also on when TOPUP_ONLINE_ENABLED)
    razorpay_webhook_secret: SecretStr = Field(SecretStr(""), validation_alias=AliasChoices("CHILLI_RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_WEBHOOK_SECRET"))
    chilli_razorpay_key_id: str = ""
    chilli_razorpay_key_secret: SecretStr = SecretStr("")
    chilli_payment_provider: Literal["razorpay", "fake"] = "razorpay"  # `fake` = local/e2e only, refused when ENV=production
    chilli_razorpay_api_base: str = "https://api.razorpay.com"
    chilli_billing_return_url: str = ""  # where Razorpay sends the owner after paying: the business app's Billing page
    chilli_max_topup_paise: int = 10_000_000  # Rs 1,00,000 per recharge
    chilli_link_ttl_minutes: int = 60  # a payment link expires after this (Razorpay minimum 15)
    chilli_intents_per_hour: int = 20  # recharge links one restaurant may create per hour

    heartbeat_stale_factor: float = 2.5
    max_request_bytes: int = 1024 * 1024

    @property
    def mfa_roles(self) -> frozenset[str]:
        return frozenset(r.strip() for r in self.mfa_required_roles.split(",") if r.strip())

    @property
    def step_up_enforced(self) -> bool:
        if self.step_up_required is not None:
            return self.step_up_required
        return self.env.lower() != "development"

    @property
    def is_production(self) -> bool:
        return self.env.lower() == "production"


settings = Settings()
