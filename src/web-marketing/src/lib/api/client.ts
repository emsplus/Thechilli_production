import { createHttp, type HttpOptions } from "./http";
import type * as T from "./types";

type Id = string;

export function createApi(opts: HttpOptions) {
  const { request: r } = createHttp(opts);
  const tokens = opts.tokens;

  return {
    auth: {
      async login(email: string, password: string) {
        const t = await r<T.TokenOut>("POST", "/auth/login", { auth: false, body: { email, password } });
        tokens.set({ access: t.access_token, refresh: t.refresh_token });
        return r<T.UserOut>("GET", "/auth/me");
      },
      me: () => r<T.UserOut>("GET", "/auth/me"),
      async logout() {
        const refresh = tokens.getRefresh();
        try {
          if (refresh || tokens.mode === "cookie") await r<void>("POST", "/auth/logout", { body: { refresh_token: refresh ?? "" } });
        } finally {
          tokens.set(null);
        }
      },
      changePassword: (current_password: string, new_password: string) =>
        r<void>("POST", "/auth/change-password", { body: { current_password, new_password } }),
    },
    users: {
      list: (role?: T.Role) => r<T.UserOut[]>("GET", "/users", { query: { role } }),
      get: (id: Id) => r<T.UserOut>("GET", `/users/${id}`),
      create: (b: T.UserCreate) => r<T.UserOut>("POST", "/users", { body: b }),
      update: (id: Id, b: T.UserUpdate) => r<T.UserOut>("PATCH", `/users/${id}`, { body: b }),
    },
    leads: {
      list: (q: T.LeadQuery = {}) => r<T.LeadOut[]>("GET", "/leads", { query: q }),
      get: (id: Id) => r<T.LeadOut>("GET", `/leads/${id}`),
      /** 409 -> ApiError.duplicates; retry with force=true to override (audited). */
      create: (b: T.LeadCreate, force = false) => r<T.LeadOut>("POST", "/leads", { body: b, query: { force: force || undefined } }),
      update: (id: Id, b: T.LeadUpdate, force = false) => r<T.LeadOut>("PATCH", `/leads/${id}`, { body: b, query: { force: force || undefined } }),
      remove: (id: Id) => r<void>("DELETE", `/leads/${id}`),
      duplicates: (q: { phone?: string; email?: string }) => r<T.DuplicateOut[]>("GET", "/leads/duplicates", { query: q }),
      assign: (id: Id, owner_id: Id | null) => r<T.LeadOut>("POST", `/leads/${id}/assign`, { body: { owner_id } }),
      setStage: (id: Id, stage: T.LeadStage, lost_reason?: string) =>
        r<T.LeadOut>("POST", `/leads/${id}/stage`, { body: { stage, lost_reason: lost_reason ?? null } }),
      activities: (id: Id) => r<T.ActivityOut[]>("GET", `/leads/${id}/activities`),
      addActivity: (id: Id, b: T.ActivityCreate) => r<T.ActivityOut>("POST", `/leads/${id}/activities`, { body: b }),
      merge: (id: Id, source_id: Id) => r<T.LeadOut>("POST", `/leads/${id}/merge`, { body: { source_id } }),
      scheduleDemo: (id: Id, b: T.DemoCreate) => r<T.DemoOut>("POST", `/leads/${id}/demos`, { body: b }),
    },
    activities: {
      list: (q: T.ActivityQuery = {}) => r<T.ActivityOut[]>("GET", "/activities", { query: q }),
      complete: (id: Id) => r<T.ActivityOut>("POST", `/activities/${id}/complete`),
    },
    demos: {
      list: (q: T.DemoQuery = {}) => r<T.DemoOut[]>("GET", "/demos", { query: q }),
      update: (id: Id, b: T.DemoUpdate) => r<T.DemoOut>("PATCH", `/demos/${id}`, { body: b }),
    },
    onboarding: {
      list: (q: T.AppQuery = {}) => r<T.AppOut[]>("GET", "/onboarding/applications", { query: q }),
      get: (id: Id) => r<T.AppOut>("GET", `/onboarding/applications/${id}`),
      create: (b: T.AppCreate) => r<T.AppOut>("POST", "/onboarding/applications", { body: b }),
      update: (id: Id, b: T.AppUpdate) => r<T.AppOut>("PATCH", `/onboarding/applications/${id}`, { body: b }),
      assign: (id: Id, agent_id: Id | null) => r<T.AppOut>("POST", `/onboarding/applications/${id}/assign`, { body: { agent_id } }),
      checklist: (id: Id) => r<T.ChecklistOut[]>("GET", `/onboarding/applications/${id}/checklist`),
      saveChecklistItem: <K extends T.ChecklistKey>(id: Id, key: K, payload: T.ChecklistPayloads[K]) =>
        r<T.ChecklistOut>("PUT", `/onboarding/applications/${id}/checklist/${key}`, { body: payload }),
      readiness: (id: Id) => r<T.Readiness>("GET", `/onboarding/applications/${id}/readiness`),
      provision: (id: Id) => r<T.AppOut>("POST", `/onboarding/applications/${id}/provision`),
      cancel: (id: Id) => r<T.AppOut>("POST", `/onboarding/applications/${id}/cancel`),
      activation: (id: Id) => r<T.ActivationOut>("GET", `/onboarding/applications/${id}/activation`),
      refreshActivation: (id: Id) => r<T.ActivationOut>("POST", `/onboarding/applications/${id}/activation/refresh`),
      documents: (id: Id) => r<T.DocumentOut[]>("GET", `/onboarding/applications/${id}/documents`),
      /** Raw-body upload: the file's own Content-Type, `type` and `filename` as query parameters. */
      uploadDocument: (id: Id, type: T.DocType, file: { name: string; type: string; data: Blob | ArrayBuffer }) =>
        r<T.DocumentOut>("POST", `/onboarding/applications/${id}/documents`, { query: { type, filename: file.name }, raw: { data: file.data, contentType: file.type || "application/octet-stream" } }),
      documentContent: (id: Id, docId: Id) => r<Blob>("GET", `/onboarding/applications/${id}/documents/${docId}/content`, { blob: true }),
      decideDocument: (id: Id, docId: Id, status: "verified" | "rejected") =>
        r<T.DocumentOut>("POST", `/onboarding/applications/${id}/documents/${docId}/decision`, { body: { status } }),
      deleteDocument: (id: Id, docId: Id) => r<void>("DELETE", `/onboarding/applications/${id}/documents/${docId}`),
    },
    invitations: {
      list: (q: { limit?: number; offset?: number } = {}) => r<T.InvitationOut[]>("GET", "/invitations", { query: q }),
      create: (b: T.InvitationCreate) => r<T.InvitationCreated>("POST", "/invitations", { body: b }),
      revoke: (id: Id) => r<T.InvitationOut>("POST", `/invitations/${id}/revoke`),
      resend: (id: Id) => r<T.InvitationCreated>("POST", `/invitations/${id}/resend`),
      deliveries: (id: Id) => r<T.DeliveryOut[]>("GET", `/invitations/${id}/deliveries`),
    },
    referrals: {
      list: () => r<T.ReferralOut[]>("GET", "/referral-codes"),
      create: (b: T.ReferralCreate) => r<T.ReferralOut>("POST", "/referral-codes", { body: b }),
      update: (id: Id, b: T.ReferralUpdate) => r<T.ReferralOut>("PATCH", `/referral-codes/${id}`, { body: b }),
      attributions: (id: Id) => r<T.AttributionOut[]>("GET", `/referral-codes/${id}/attributions`),
    },
    campaigns: {
      list: () => r<T.CampaignOut[]>("GET", "/campaigns"),
      get: (id: Id) => r<T.CampaignOut>("GET", `/campaigns/${id}`),
      create: (b: T.CampaignCreate) => r<T.CampaignOut>("POST", "/campaigns", { body: b }),
      update: (id: Id, b: T.CampaignUpdate) => r<T.CampaignOut>("PATCH", `/campaigns/${id}`, { body: b }),
      stats: (id: Id) => r<T.CampaignStats>("GET", `/campaigns/${id}/stats`),
    },
    commissions: {
      rules: () => r<T.RuleOut[]>("GET", "/commission-rules"),
      createRule: (b: T.RuleCreate) => r<T.RuleOut>("POST", "/commission-rules", { body: b }),
      updateRule: (id: Id, b: T.RuleUpdate) => r<T.RuleOut>("PATCH", `/commission-rules/${id}`, { body: b }),
      entries: (q: T.EntryQuery = {}) => r<T.EntryOut[]>("GET", "/commission-entries", { query: q }),
      summary: (user_id?: Id) => r<T.CommissionSummary>("GET", "/commission-entries/summary", { query: { user_id } }),
      approve: (id: Id, note?: string) => r<T.EntryOut>("POST", `/commission-entries/${id}/approve`, { body: { note: note ?? null } }),
      reject: (id: Id, note?: string) => r<T.EntryOut>("POST", `/commission-entries/${id}/reject`, { body: { note: note ?? null } }),
      pay: (id: Id, note?: string) => r<T.EntryOut>("POST", `/commission-entries/${id}/pay`, { body: { note: note ?? null } }),
      reverse: (id: Id, note?: string) => r<T.EntryOut>("POST", `/commission-entries/${id}/reverse`, { body: { note: note ?? null } }),
    },
    audit: {
      list: (q: T.AuditQuery = {}) => r<T.AuditOut[]>("GET", "/audit-log", { query: q }),
    },
  };
}
export type Api = ReturnType<typeof createApi>;
