import type { HttpClient, Query } from "./client";
import type * as T from "./types";
import type { StepUpGrantOut } from "../step-up";

const enc = encodeURIComponent;
export interface ListParams { limit?: number; offset?: number }

/** Typed wrappers over the platform-core routes this UI is allowed to call. Paths are relative to /api/v1. */
export function createApi(http: HttpClient) {
  return {
    auth: {
      me: () => http.get<T.Me>("/auth/me"),
      sessions: () => http.get<T.Items<T.AuthSession>>("/auth/sessions"),
      revokeSession: (id: string) => http.delete<T.Ok>(`/auth/sessions/${enc(id)}`),
      revokeOtherSessions: () => http.post<{ ok: true; revoked: number }>("/auth/sessions/revoke-others"),
      mfaStatus: () => http.get<T.MfaStatus>("/auth/mfa/status"),
      mfaEnrolStart: () => http.post<T.MfaEnrolStart>("/auth/mfa/enrol/start"),
      mfaEnrolConfirm: (code: string) => http.post<T.MfaEnrolDone>("/auth/mfa/enrol/confirm", { code }),
      mfaDisable: (password: string, code: string) => http.post<T.Ok>("/auth/mfa/disable", { password, code }),
      /** Fresh code for one protected action. `code`: 6-digit authenticator code or one recovery code. Never answered with another prompt. */
      stepUp: (code: string) => http.post<StepUpGrantOut>("/auth/step-up", { code }, { noStepUp: true }),
      mfaRecoveryCodes: (password: string, code: string) => http.post<{ recovery_codes: string[] }>("/auth/mfa/recovery-codes", { password, code }),
    },
    staff: {
      roles: () => http.get<T.RoleMatrix>("/roles"),
      list: (p: ListParams = {}) => http.get<T.Page<T.StaffUser>>("/staff", { limit: 200, ...p }),
      create: (b: { email: string; name: string; role: T.Role; password: string }) => http.post<T.StaffUser>("/staff", b),
      update: (id: string, b: { name?: string; role?: T.Role; is_active?: boolean }) => http.patch<T.StaffUser>(`/staff/${enc(id)}`, b),
      resetPassword: (id: string, new_password: string) => http.post<T.Ok>(`/staff/${enc(id)}/reset-password`, { new_password }),
      resetMfa: (id: string) => http.post<T.Ok>(`/staff/${enc(id)}/mfa/reset`),
      revokeSessions: (id: string) => http.delete<{ ok: true; revoked: number }>(`/staff/${enc(id)}/sessions`),
    },
    tenants: {
      list: (q: ListParams & { status?: string; q?: string } = {}) => http.get<T.Page<T.Tenant>>("/tenants", { limit: 50, ...q } as Query),
      get: (ref: string) => http.get<T.TenantDetail>(`/tenants/${enc(ref)}`),
      suspend: (ref: string, reason: string) => http.post<T.TenantDetail>(`/tenants/${enc(ref)}/suspend`, { reason }),
      reactivate: (ref: string, reason: string) => http.post<T.TenantDetail>(`/tenants/${enc(ref)}/reactivate`, { reason }),
      close: (ref: string, reason: string) => http.post<T.TenantDetail>(`/tenants/${enc(ref)}/close`, { reason }),
    },
    onboarding: {
      list: (q: ListParams & { status?: string; source?: string } = {}) => http.get<T.Page<T.OnboardingApplication>>("/onboarding/applications", { limit: 50, ...q } as Query),
      get: (id: string) => http.get<T.OnboardingDetail>(`/onboarding/applications/${enc(id)}`),
      review: (id: string, note?: string) => http.post<T.OnboardingApplication>(`/onboarding/applications/${enc(id)}/review`, { note }),
      approve: (id: string, note?: string) => http.post<T.OnboardingApplication>(`/onboarding/applications/${enc(id)}/approve`, { note }),
      reject: (id: string, reason: string) => http.post<T.OnboardingApplication>(`/onboarding/applications/${enc(id)}/reject`, { reason }),
      provision: (id: string) => http.post<T.OnboardingApplication>(`/onboarding/applications/${enc(id)}/provision`),
    },
    catalog: {
      features: () => http.get<T.Items<T.Feature>>("/features"),
      plans: () => http.get<T.Items<T.Plan>>("/plans"),
      createPlan: (b: { code: string; name: string; description?: string | null; price_paise: number; billing_period: "month" | "year"; features: T.PlanFeature[] }) => http.post<T.Plan>("/plans", b),
      editPlan: (code: string, b: T.PlanEditIn) => http.put<T.Plan>(`/plans/${enc(code)}`, b),
      retirePlan: (code: string, reason: string) => http.post<T.Plan>(`/plans/${enc(code)}/retire`, { reason }),
      reactivatePlan: (code: string, reason: string) => http.post<T.Plan>(`/plans/${enc(code)}/reactivate`, { reason }),
      planVersions: (code: string) => http.get<T.Items<T.PlanVersion>>(`/plans/${enc(code)}/versions`),
      subscriptions: (status?: string) => http.get<T.Items<T.Subscription>>("/subscriptions", { status }),
      tenantSubscription: (ref: string) => http.get<T.TenantSubscription>(`/tenants/${enc(ref)}/subscription`),
      assignPlan: (ref: string, b: { plan_code: string; trial_days?: number; reason?: string }) => http.post<T.Subscription>(`/tenants/${enc(ref)}/subscription`, b),
      cancelSubscription: (ref: string, b: { at_period_end: boolean; reason?: string }) => http.post<T.Subscription>(`/tenants/${enc(ref)}/subscription/cancel`, b),
      entitlements: (ref: string) => http.get<T.Entitlements>(`/entitlements/${enc(ref)}`),
      entitlementHistory: (ref: string, limit = 100) => http.get<T.Items<T.EntitlementHistoryRow>>(`/entitlements/${enc(ref)}/history`, { limit }),
      setOverride: (ref: string, feature: string, b: T.OverrideIn) => http.put<T.EntitlementOverride>(`/entitlements/${enc(ref)}/overrides/${enc(feature)}`, b),
      removeOverride: (ref: string, feature: string) => http.delete<T.Ok>(`/entitlements/${enc(ref)}/overrides/${enc(feature)}`),
    },
    billing: {
      invoices: (q: ListParams & { tenant?: string; status?: string } = {}) => http.get<T.Page<T.Invoice>>("/invoices", { limit: 50, ...q } as Query),
      invoice: (id: string) => http.get<T.InvoiceDetail>(`/invoices/${enc(id)}`),
      issue: (id: string) => http.post<T.InvoiceDetail>(`/invoices/${enc(id)}/issue`),
      void: (id: string, reason: string) => http.post<T.InvoiceDetail>(`/invoices/${enc(id)}/void`, { reason }),
      payments: (q: ListParams & { tenant?: string; invoice_id?: string } = {}) => http.get<T.Page<T.Payment>>("/payments", { limit: 50, ...q } as Query),
    },
    /** Chilli's prepaid PAYG credit of a business (platform-core /admin/..., docs/PAYG_BILLING.md 7.3). */
    credit: {
      wallet: (ref: string) => http.get<T.AdminWallet>(`/admin/tenants/${enc(ref)}/wallet`),
      ledger: (ref: string, q: T.LedgerQuery = {}) => http.get<T.Page<T.LedgerRow>>(`/admin/tenants/${enc(ref)}/wallet/ledger`, { limit: 25, ...q } as Query),
      /** `idempotencyKey`: one per dialog open, so a double click or a retried request never credits twice (server replays). */
      adjust: (ref: string, b: T.WalletAdjustIn, idempotencyKey: string) => http.post<T.WalletAdjustOut>(`/admin/tenants/${enc(ref)}/wallet/adjust`, b, { headers: { "Idempotency-Key": idempotencyKey } }),
      suspend: (ref: string, reason: string) => http.post<{ billing: T.BillingBlock }>(`/admin/tenants/${enc(ref)}/wallet/suspend`, { reason }),
      resume: (ref: string, reason: string) => http.post<{ billing: T.BillingBlock }>(`/admin/tenants/${enc(ref)}/wallet/resume`, { reason }),
      settings: (ref: string) => http.get<T.TenantBillingSettings>(`/admin/tenants/${enc(ref)}/billing-settings`),
      putSettings: (ref: string, b: T.BillingSettingsPut) => http.put<T.TenantBillingSettings>(`/admin/tenants/${enc(ref)}/billing-settings`, b),
      /** Monthly statement CSV, built (formula-injection safe) by platform-core: opening balance, the month's lines, closing. */
      statementCsv: (ref: string, month: string) => http.getText(`/admin/tenants/${enc(ref)}/usage`, { month, format: "csv" }),
      /** Top-up receipts of one business (numbered, with the CA-unverified GST split). */
      receipts: (ref: string, p: ListParams = {}) => http.get<T.Page<T.WalletReceiptRow>>(`/admin/tenants/${enc(ref)}/receipts`, { limit: 50, ...p } as Query),
      /** Every business with a wallet: the month's statement summary (top-ups, promo, fees, balances). */
      allUsage: (month: string) => http.get<T.AllUsage>("/admin/billing/usage", { month }),
      allUsageCsv: (month: string) => http.getText("/admin/billing/usage", { month, format: "csv" }),
    },
    support: {
      tickets: (q: ListParams & { status?: string; tenant?: string } = {}) => http.get<T.Page<T.Ticket>>("/tickets", { limit: 50, ...q } as Query),
      ticket: (id: string) => http.get<T.TicketDetail>(`/tickets/${enc(id)}`),
      updateTicket: (id: string, b: { status?: T.TicketStatus; priority?: T.TicketPriority; assignee_id?: string }) => http.patch<T.Ticket>(`/tickets/${enc(id)}`, b),
      comment: (id: string, b: { body: string; internal: boolean }) => http.post<T.TicketComment>(`/tickets/${enc(id)}/comments`, b),
      grants: (q: ListParams & { tenant?: string; active?: boolean } = {}) => http.get<T.Page<T.SupportGrant>>("/support-access/grants", { limit: 50, ...q } as Query),
      createGrant: (b: T.GrantIn) => http.post<T.SupportGrant>("/support-access/grants", b),
      revokeGrant: (id: string) => http.post<T.SupportGrant>(`/support-access/grants/${enc(id)}/revoke`),
    },
    logs: {
      audit: (q: ListParams & { action?: string; tenant?: string; actor_id?: string; since?: string } = {}) => http.get<T.Page<T.AuditEntry>>("/audit-log", { limit: 50, ...q } as Query),
      security: (q: ListParams & { type?: string; severity?: string } = {}) => http.get<T.Page<T.SecurityEvent>>("/security-events", { limit: 50, ...q } as Query),
    },
    ai: {
      summary: (since?: string) => http.get<T.Items<T.AiUsageSummaryRow>>("/ai-usage/summary", { since }),
    },
    analytics: {
      overview: (q: { since?: string; until?: string } = {}) => http.get<T.Overview>("/analytics/overview", q as Query),
      exportCsv: (report: T.ExportReport, q: { since?: string; until?: string } = {}) => http.getText("/analytics/export", { report, ...q } as Query),
    },
    marketing: {
      team: () => http.get<T.Page<T.MarketingMember>>("/marketing/team"),
      referrals: () => http.get<T.Page<T.MarketingReferral>>("/marketing/referrals"),
      commissions: (status?: string) => http.get<T.Commissions>("/marketing/commissions", { status }),
    },
    system: {
      health: () => http.get<T.SystemHealth>("/system/health"),
    },
    config: {
      list: () => http.get<T.Items<T.ConfigEntry>>("/config"),
      set: (key: string, b: { value: unknown; description?: string }) => http.put<T.ConfigEntry>(`/config/${enc(key)}`, b),
      remove: (key: string) => http.delete<T.Ok>(`/config/${enc(key)}`),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
