/**
 * Types mirror platform-core (app/models.py + app/api/*.py). Money is integer paise, AI cost is integer micro-rupees.
 * Timestamps are ISO-8601 strings. Nothing here describes tenant operational data (orders, customers, menus, staff of a
 * restaurant): platform-core has none, and this UI must never grow any.
 */
export type Uuid = string;
export type Iso = string;

export type Role = "super_admin" | "platform_admin" | "support" | "finance";
export const ROLES: readonly Role[] = ["super_admin", "platform_admin", "support", "finance"] as const;

export type Permission =
  | "staff.read" | "staff.manage" | "service_clients.manage"
  | "tenants.read" | "tenants.write" | "tenants.suspend"
  | "onboarding.read" | "onboarding.manage"
  | "catalog.read" | "catalog.manage"
  | "subscriptions.read" | "subscriptions.manage"
  | "entitlements.read" | "entitlements.override"
  | "invoices.read" | "invoices.manage" | "payments.read" | "payments.manage"
  | "tickets.read" | "tickets.manage"
  | "support_access.grant" | "support_access.use" | "support_access.read"
  | "audit.read" | "security.read" | "ai_usage.read"
  | "system.read" | "config.read" | "config.write"
  | "analytics.read" | "analytics.export" | "marketing.read"
  | "wallet.read" | "wallet.adjust" | "billing_settings.manage";

export interface Page<T> { items: T[]; total: number; limit: number; offset: number }
export interface Items<T> { items: T[] }
export interface Ok { ok: true }

/** Error envelope: { error: { code, message, details? } } */
export interface ErrorBody { error: { code: string; message: string; details?: { loc: (string | number)[]; msg: string }[] } }

// ---- auth / staff
export interface StaffUser {
  id: Uuid; email: string; name: string; role: Role; is_active: boolean; must_change_password: boolean;
  last_login_at: Iso | null; created_at?: Iso;
}
export interface Me extends StaffUser { permissions: Permission[] }
export type RoleMatrix = Record<Role, Permission[]>;
export interface ServiceClient { id: Uuid; name: string; scopes: string[]; is_active: boolean; last_used_at: Iso | null }

// ---- tenants
export type TenantStatus = "pending" | "active" | "suspended" | "closed";
/** platform-core migration 0004: one or more per business (tenants and onboarding applications). */
export type BusinessType = "restaurant" | "cloud_kitchen" | "hotel_kitchen";
export interface Tenant {
  id: Uuid; slug: string; display_name: string; status: TenantStatus; status_reason: string | null;
  status_changed_at: Iso | null; pos_tenant_ref: string | null; created_at: Iso;
  /** Always present live; optional so older fixtures still type-check. */
  business_types?: BusinessType[];
}
export interface BusinessProfile {
  tenant_id: Uuid; legal_name: string; gstin: string | null; pan: string | null; fssai: string | null; state_code: string | null;
  address: string | null; city: string | null; pincode: string | null; contact_name: string | null;
  contact_email: string | null; contact_phone: string | null;
}
export interface Outlet {
  id: Uuid; tenant_id: Uuid; name: string; code: string | null; city: string | null; state_code: string | null;
  status: "active" | "inactive"; pos_outlet_ref: string | null; created_at: Iso;
}
export interface TenantDetail extends Tenant { profile: BusinessProfile | null; outlets: Outlet[] }
export interface StatusChange { reason: string }

// ---- onboarding
export type OnboardingStatus = "received" | "under_review" | "approved" | "provisioning" | "provisioned" | "rejected" | "failed";
export type OnboardingSource = "self_signup" | "marketing" | "staff";
export interface OnboardingApplication {
  id: Uuid; source: OnboardingSource; status: OnboardingStatus; business_name: string; contact_name: string; email: string;
  phone: string | null; plan_code: string | null; marketing_ref: string | null; tenant_id: Uuid | null; attempts: number;
  last_error: string | null; reject_reason: string | null; created_at: Iso; updated_at: Iso;
  payload?: Record<string, unknown>;
  business_types?: BusinessType[];
  /** Provisioning sub-state (platform-core docs/PROVISIONING.md): queued, provisioning, owner_invited, live, failed. */
  provision_state?: string | null; provision_next_at?: Iso | null; provision_error_code?: string | null;
  owner_invited_at?: Iso | null; live_at?: Iso | null; invite_sends?: number;
}
export interface OnboardingEvent { id: number; application_id: Uuid; from_status: OnboardingStatus | null; to_status: OnboardingStatus; actor: string; note: string | null; at?: Iso; created_at?: Iso }
export interface OnboardingDetail extends OnboardingApplication { events: OnboardingEvent[] }

// ---- catalog
export interface Feature { code: string; name: string; description: string | null; kind: "flag" | "limit"; unit: string | null; is_active: boolean }
export interface PlanFeature { feature_code: string; enabled: boolean; limit_value: number | null }
export interface Plan {
  id: Uuid; code: string; name: string; description: string | null; price_paise: number; billing_period: "month" | "year";
  is_active: boolean; features: PlanFeature[]; created_at?: Iso;
  version: number; retired_at?: Iso | null; live_subscriptions?: number;
}
export interface PlanEditIn { expected_version: number; name: string; description: string | null; price_paise: number; features: PlanFeature[]; note?: string }
export interface PlanVersion { version: number; change: "created" | "edited" | "retired" | "reactivated"; note: string | null; actor: string; at: Iso; snapshot: Pick<Plan, "name" | "description" | "price_paise" | "billing_period" | "features"> }
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired";
export interface Subscription {
  id: Uuid; tenant_id: Uuid; plan_id: Uuid; status: SubscriptionStatus; trial_end: Iso | null; current_period_start: Iso;
  current_period_end: Iso; cancel_at_period_end: boolean; ended_at: Iso | null; created_at: Iso;
}
export interface TenantSubscription { current: Subscription | null; history: Subscription[] }

export interface EntitlementValue { enabled: boolean; limit: number | null; source: string }
export interface Entitlements {
  tenant_id: Uuid; tenant_status: TenantStatus; business_types?: BusinessType[]; plan_code: string | null; subscription_status: SubscriptionStatus | null;
  subscription_reason: string; features: Record<string, EntitlementValue>; version: string; generated_at: Iso;
}
export interface EntitlementHistoryRow {
  id: number; tenant_id: Uuid; feature_code: string; before: EntitlementValue | null; after: EntitlementValue | null;
  trigger: string; actor: string; reason: string | null; at?: Iso; created_at?: Iso;
}
export interface OverrideIn { enabled: boolean; limit_value?: number | null; reason: string; expires_at?: string | null }
export interface EntitlementOverride { tenant_id: Uuid; feature_code: string; enabled: boolean; limit_value: number | null; reason: string; expires_at: Iso | null; created_by: string }

// ---- billing (integer paise; GST figures are shown exactly as returned)
export type InvoiceStatus = "draft" | "issued" | "paid" | "void";
export interface InvoiceLine { id?: number; invoice_id?: Uuid; description: string; quantity: number; unit_price_paise: number; amount_paise: number }
export interface Invoice {
  id: Uuid; tenant_id: Uuid; subscription_id: Uuid | null; number: string | null; status: InvoiceStatus; currency: string;
  period_start: Iso | null; period_end: Iso | null; subtotal_paise: number; discount_paise: number; taxable_paise: number;
  gst_rate_bps: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number;
  supplier_gstin: string | null; supplier_state_code: string; buyer_gstin: string | null; buyer_state_code: string | null;
  sac_code: string; tax_needs_ca_verification: boolean; issued_at: Iso | null; due_at: Iso | null; paid_at: Iso | null;
  void_reason: string | null; created_at: Iso;
}
export interface InvoiceDetail extends Invoice { lines: InvoiceLine[]; tax_notice: string | null }
export type PaymentStatus = "initiated" | "succeeded" | "failed" | "refunded";
export interface Payment {
  id: Uuid; tenant_id: Uuid; invoice_id: Uuid | null; provider: string; provider_ref: string; amount_paise: number; currency: string;
  method: string | null; status: PaymentStatus; created_at: Iso; updated_at: Iso;
}

// ---- support
export type TicketStatus = "open" | "in_progress" | "waiting" | "resolved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export interface Ticket {
  id: Uuid; tenant_id: Uuid | null; subject: string; body: string; priority: TicketPriority; status: TicketStatus;
  requester_email: string | null; assignee_id: Uuid | null; created_by: string; created_at: Iso; updated_at: Iso;
}
export interface TicketComment { id: Uuid; ticket_id: Uuid; author: string; body: string; internal: boolean; created_at: Iso }
export interface TicketDetail extends Ticket { comments: TicketComment[] }
export type GrantScope = "read_only" | "diagnostics";
export interface SupportGrant {
  id: Uuid; tenant_id: Uuid; staff_id: Uuid; ticket_id: Uuid | null; scope: GrantScope; reason: string; granted_by: Uuid;
  starts_at: Iso; expires_at: Iso; revoked_at: Iso | null; revoked_by: Uuid | null; created_at: Iso;
}
export interface GrantIn { tenant: string; staff_id: Uuid; minutes: number; scope: GrantScope; reason: string; ticket_id?: Uuid }

// ---- logs / ops
export interface AuditEntry {
  id: number; at: Iso; actor_type: string; actor_id: string | null; actor_label: string | null; action: string;
  target_type: string | null; target_id: string | null; tenant_id: Uuid | null; ip: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; meta: Record<string, unknown> | null;
}
export type Severity = "info" | "warn" | "critical";
export interface SecurityEvent { id: number; at: Iso; type: string; severity: Severity; staff_id: Uuid | null; email: string | null; ip: string | null; details: Record<string, unknown> | null }
export interface AiUsageSummaryRow { tenant_id: Uuid; feature: string; calls: number; input_tokens: number; output_tokens: number; cost_micro_inr: number }
export interface JobHealth {
  job_name: string; service: string; status: "ok" | "error"; last_seen_at: Iso; last_duration_ms: number | null;
  expected_interval_seconds: number; details: Record<string, unknown> | null; age_seconds: number; stale: boolean; healthy: boolean;
}
export interface SystemHealth {
  status: "ok" | "degraded"; database: string; environment: string; signing_key_id: string; jobs: JobHealth[];
  failed_onboardings: number; checked_at: Iso;
}
export interface ConfigEntry { key: string; value: unknown; description: string | null; updated_by: string | null; updated_at: Iso }

// ---- session (BFF, same-origin; tokens never reach the browser)
export interface LoginIn { email: string; password: string }
/** Sign-in either completes, or needs a second step (mandatory for some roles): `verify` a code or `enrol` an authenticator first. */
export type LoginResult = { status: "signed_in"; user: Me; must_change_password: boolean } | { status: "mfa_verify" } | { status: "mfa_enrol" };
export interface MfaEnrolStart { secret: string; otpauth_uri: string; qr_svg: string | null; issuer: string; account: string }
export interface MfaStatus { enrolled: boolean; enrolled_at: Iso | null; required: boolean; recovery_codes_remaining: number }
export interface MfaEnrolDone { ok: true; recovery_codes: string[]; user?: Me; must_change_password?: boolean }
export interface AuthSession { id: Uuid; started_at: Iso; last_active_at: Iso; ip: string | null; user_agent: string | null; mfa: boolean; current: boolean }

// ---- analytics / marketing (platform-core aggregates; money in paise or the marketing currency's minor units)
export interface Overview {
  as_of: Iso; window: { since: string; until: string | null }; mrr_paise: number; arr_paise: number;
  mrr_by_plan: { plan_code: string; plan_name: string; subscriptions: number; mrr_paise: number }[];
  paying_subscriptions: number; active_tenants: number; trialing_tenants: number; tenants_by_status: Record<string, number>;
  churn: { opening_tenants: number; churned_tenants: number; rate_bps: number };
  signups: { total: number; by_source: Record<OnboardingSource, number>; by_month: ({ month: string } & Record<OnboardingSource, number>)[] };
  notes: { mrr: string; churn: string };
}
export type ExportReport = "mrr_by_plan" | "signups" | "subscriptions" | "tenants";
export type Balances = Record<string, { pending_minor: number; approved_minor: number; paid_minor: number }>;
export interface MarketingMember { id: Uuid; name: string; email: string; role: string; is_active: boolean; referral_codes: number; referral_uses: number; commission: Balances }
export interface MarketingReferral { id: string; code: string; owner_id: Uuid; owner_name: string | null; campaign_id: Uuid | null; is_active: boolean; max_uses: number | null; expires_at: Iso | null; created_at: Iso; uses: number }
export interface CommissionEntry { id: string; kind: "commission" | "reversal"; user_id: Uuid; user_name: string | null; application_id: Uuid | null; base_amount_minor: number; amount_minor: number; currency: string; status: string; decided_at: Iso | null; created_at: Iso }
export interface CommissionRule { id: string; name: string; recipient: string; calc: string; rate_bps: number; flat_amount_minor: number; currency: string; is_active: boolean }
export interface Commissions { items: CommissionEntry[]; total: number; balances: Balances; by_user: { user_id: Uuid; user_name: string | null; balances: Balances }[]; rules: CommissionRule[] }

// ---- PAYG credit wallet (platform-core app/api/wallet.py, docs/PAYG_BILLING.md). Chilli's own prepaid credit for a business,
// held by platform-core: integer paise, append-only ledger. Not a restaurant's customer wallet (that never reaches HQ).
export type BillingState = "trial" | "active" | "low" | "empty" | "suspended";
export type BillingModel = "payg" | "subscription";
export type FeeGstMode = "inclusive" | "exclusive";
export interface BonusTier { min_paise: number; bonus_paise: number }
/** UI is English only: `message.en` is shown; `hi` may be present in live data and is ignored. */
export interface BillingBanner { level: "info" | "warning" | "critical"; code: string; message: { en: string; hi?: string } }
export interface BillingBlock {
  state: BillingState; model: BillingModel; trial_ends_at: Iso; days_left: number; balance_paise: number;
  /** The debit per bill (GST added when exclusive). */
  per_bill_paise: number; fee_gst_mode: FeeGstMode; charge_zero_bills: boolean; low_balance_paise: number; grace_paise: number;
  min_topup_paise: number; bonus_tiers: BonusTier[]; can_bill: boolean; in_grace: boolean; bills_left: number | null;
  suspended_reason: string | null; banner: BillingBanner | null; topup_online: boolean;
}
export interface BillingSettingsValues {
  billing_model: BillingModel; trial_days: number; per_bill_paise: number; fee_gst_mode: FeeGstMode; charge_zero_bills: boolean;
  low_balance_paise: number; grace_paise: number; min_topup_paise: number; bonus_tiers: BonusTier[];
}
export type BillingSettingKey = keyof BillingSettingsValues;
export type SettingSource = "default" | "plan" | "tenant";
export interface EffectiveBillingSettings extends BillingSettingsValues { sources: Record<BillingSettingKey, SettingSource>; debit_per_bill_paise: number }
export interface WalletRow {
  tenant_id: Uuid; balance_paise: number; trial_started_at: Iso; trial_ends_at: Iso; suspended_at: Iso | null; suspended_reason: string | null;
  last_state: BillingState | null; created_at: Iso; updated_at: Iso;
}
export type LedgerKind = "topup" | "promo" | "void_credit_back" | "bill_fee" | "adjustment";
export interface LedgerRow {
  id: number; tenant_id: Uuid; kind: LedgerKind; amount_paise: number; balance_after_paise: number; source: string;
  ref_type: string | null; ref_id: string | null; fee_base_paise: number | null; fee_gst_paise: number | null; reason: string | null;
  actor: string; meta: Record<string, unknown> | null; at: Iso;
}
export interface AdminWallet {
  tenant_id: Uuid; tenant: string; slug: string; billing: BillingBlock; wallet: WalletRow; settings: EffectiveBillingSettings; recent_ledger: LedgerRow[];
}
export type AdjustKind = "topup" | "promo" | "adjustment";
export interface WalletAdjustIn { kind: AdjustKind; amount_paise: number; reason: string; payment_ref?: string | null; allow_negative?: boolean }
export interface WalletReceipt { id: Uuid; number: string; amount_paise: number; bonus_paise: number; payment_ref: string | null; created_at: Iso; tax_notice?: string }
/** GET /admin/tenants/{ref}/receipts item: a top-up receipt with its GST split (CA verification pending, shown as returned). */
export interface WalletReceiptRow extends WalletReceipt {
  tenant_id: Uuid; source: string; gst_mode: FeeGstMode; taxable_paise: number; gst_rate_bps: number; cgst_paise: number; sgst_paise: number;
  igst_paise: number; sac_code: string; supplier_gstin: string | null; supplier_state_code: string; buyer_gstin: string | null; buyer_state_code: string | null;
  tax_needs_ca_verification: boolean; ledger_id: number; note: string | null; created_by: string;
}
/** One business's month (GET /admin/tenants/{ref}/usage and each item of GET /admin/billing/usage). */
export interface UsageStatement {
  tenant_id: Uuid; tenant: string; month: string; timezone: string; period_start: Iso; period_end: Iso;
  opening_balance_paise: number; closing_balance_paise: number;
  bills: { reported: number; charged: number; free_trial: number; zero_total: number; voided: number; credited_back: number };
  fees_paise: number; fee_credit_backs_paise: number; net_fees_paise: number; gst_in_net_fees_paise: number;
  topups_paise: number; promo_paise: number; adjustments_paise: number;
  receipts: { id: Uuid; number: string; amount_paise: number; bonus_paise: number; created_at: Iso }[]; tax_notice: string;
}
export interface AllUsage { month: string; items: UsageStatement[] }
export interface WalletAdjustOut { replayed: boolean; ledger: LedgerRow; receipt: WalletReceipt | null; billing: BillingBlock }
export interface TenantBillingSettings {
  override: Record<BillingSettingKey, unknown>; effective: EffectiveBillingSettings; defaults: BillingSettingsValues;
  trial_started_at?: Iso; trial_ends_at: Iso;
}
/** PUT body: only the fields being changed; null clears the override (inherit plan / default). */
export type BillingSettingsPut = { [K in BillingSettingKey]?: BillingSettingsValues[K] | null } & { reason: string };
export interface LedgerQuery { from?: string; to?: string; kind?: LedgerKind | ""; limit?: number; offset?: number }
