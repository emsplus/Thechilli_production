import type * as T from "@/lib/api/types";
import { seedCredit, type CreditStore } from "./credit";
import { DEMO_RECOVERY_CODES, DEMO_TOTP_SECRET, type MockGrant } from "./stepup";

/** Demo data for HQ_API_MODE=mock. Platform facts only: businesses, plans, invoices, tickets, logs. No tenant operations. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
const ahead = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();
const DAY = 1440;

export interface StaffRecord extends T.StaffUser { password: string }
export interface Store {
  staff: StaffRecord[];
  tenants: (T.Tenant & { profile: T.BusinessProfile; outlets: T.Outlet[] })[];
  onboarding: (T.OnboardingApplication & { events: T.OnboardingEvent[] })[];
  features: T.Feature[];
  plans: T.Plan[];
  subs: T.Subscription[];
  overrides: T.EntitlementOverride[];
  entHistory: T.EntitlementHistoryRow[];
  invoices: (T.Invoice & { lines: T.InvoiceLine[] })[];
  payments: T.Payment[];
  tickets: (T.Ticket & { comments: T.TicketComment[] })[];
  grants: T.SupportGrant[];
  audit: T.AuditEntry[];
  security: T.SecurityEvent[];
  ai: T.AiUsageSummaryRow[];
  jobs: Omit<T.JobHealth, "age_seconds" | "stale" | "healthy">[];
  config: T.ConfigEntry[];
  /** Sessions (refresh families) and TOTP state, as platform-core keeps them. */
  sessions: { id: string; staff_id: string; started_at: string; last_active_at: string; ip: string; user_agent: string; mfa: boolean; revoked: boolean }[];
  mfa: Record<string, { secret: string; confirmed: boolean; last_step: number | null; recovery: string[]; recoveryUsed: string[]; /** seeded demo factor: sign-in stays password-only unless the role is mandatory */ demo?: boolean }>;
  /** Single-use step-up grants (./stepup.ts). */
  stepUp: MockGrant[];
  mfaFailures: Record<string, number>;
  planVersions: Record<string, T.PlanVersion[]>;
  marketing: { members: T.MarketingMember[]; referrals: T.MarketingReferral[]; entries: T.CommissionEntry[]; rules: T.CommissionRule[] };
  /** PAYG credit wallets (Chilli's prepaid credit per business), see ./credit.ts. */
  credit: CreditStore;
  seq: number;
}

export const DEMO_PASSWORD = "ChilliDemo1";
export const DEMO_ACCOUNTS = [
  { email: "super@chilli.test", role: "super_admin" },
  { email: "admin@chilli.test", role: "platform_admin" },
  { email: "support@chilli.test", role: "support" },
  { email: "finance@chilli.test", role: "finance" },
] as const;

/** Earlier (provisioned) signups for the analytics months: real-sounding Indian restaurants, cafes and cloud kitchens. */
const EARLIER = ["Udupi Upahar", "Rajdhani Rasoi", "Chettinad Mess", "Bawarchi Kitchen", "Amritsari Kulcha Co", "Goa Fish Curry House", "Momo Mantra", "Kolkata Kathi Rolls", "Malabar Biryani Point", "Filter Kaapi Corner", "Punjab Grill Express", "Bombay Vada Pav Co", "Hyderabadi Haleem House", "Mysore Masala Dosa", "Lucknowi Kebab Corner", "Kerala Sadya Kitchen", "Delhi Chaat Junction", "Jaipur Thali House", "Assam Tea Stall", "Coorg Coffee Works", "Chennai Idli Shop"];
const OWNERS = ["Rahul Verma", "Sneha Kulkarni", "Abdul Rahman", "Priya Menon", "Gurpreet Singh", "Anjali Desai", "Suresh Pillai", "Fatima Sheikh"];
const marketing_name = (u: number) => ["Meera Kapoor", "Arjun Nair", "Zoya Khan"][u];

export function seed(): Store {
  const staff: StaffRecord[] = DEMO_ACCOUNTS.map((a, i) => ({
    id: id(100 + i), email: a.email, name: ["Asha Rao", "Vikram Shah", "Neha Iyer", "Rohit Menon"][i], role: a.role, is_active: true,
    must_change_password: false, last_login_at: ago(60 * (i + 1)), created_at: ago(90 * DAY), password: DEMO_PASSWORD,
  }));

  /** Demo-only 14-digit FSSAI licence numbers, one per tenant above (state-licence style: 2 + state code + year + issuer + serial). Fake, deliberately varied. */
  const DEMO_FSSAI = ["22921014582367", "22918006419753", "23620005173829", "22719012864095", null, null, "23317003290548"] as const;
  const tdefs: [string, string, T.TenantStatus, string, string, string | null, number][] = [
    ["Saffron Table", "saffron-table", "active", "29", "Bengaluru", "29ABCDE1234F1Z5", 3],
    ["Dosa Junction", "dosa-junction", "active", "29", "Mysuru", "29AAACD5678K1Z2", 2],
    ["Biryani Bazaar", "biryani-bazaar", "active", "36", "Hyderabad", "36AAGCB9012L1Z8", 4],
    ["Cafe Monsoon", "cafe-monsoon", "suspended", "27", "Pune", "27AAHCC3456M1Z1", 1],
    ["Tandoor Tales", "tandoor-tales", "active", "07", "Delhi", null, 2],
    ["Kesar Chai Adda", "kesar-chai-adda", "pending", "29", "Bengaluru", null, 1],
    ["Old Harbour Grill", "old-harbour-grill", "closed", "33", "Chennai", "33AAIFO7890P1Z4", 1],
  ];
  const tenants = tdefs.map(([name, slug, status, sc, city, gstin, nOut], i) => {
    const tid = id(1 + i);
    return {
      id: tid, slug, display_name: name, status, status_reason: status === "suspended" ? "Unpaid invoice, 2 reminders sent" : status === "closed" ? "Owner closed business" : null,
      status_changed_at: status === "active" || status === "pending" ? null : ago(12 * DAY), pos_tenant_ref: status === "pending" ? null : `pos-${slug}`, business_types: ["restaurant"] as T.BusinessType[], created_at: ago((120 - i * 9) * DAY),
      profile: { tenant_id: tid, legal_name: `${name} Pvt Ltd`, gstin, pan: gstin ? gstin.slice(2, 12) : null, fssai: gstin ? DEMO_FSSAI[i] ?? null : null, state_code: sc, address: `${12 + i}, ${["100 Feet Road, Indiranagar", "Sayyaji Rao Road", "Road No. 36, Jubilee Hills", "FC Road, Shivajinagar", "Khan Market", "Koramangala 5th Block", "Besant Nagar"][i]}`, city, pincode: ["560038", "570001", "500033", "411005", "110003", "560095", "600090"][i], contact_name: ["Meera Nair", "Ravi Kumar", "Imran Khan", "Sara D'Souza", "Pooja Gill", "Arun Das", "Joseph Thomas"][i], contact_email: `owner@${slug.replace(/-/g, "")}.in`, contact_phone: `98450${10000 + i * 111}` },
      outlets: Array.from({ length: nOut }, (_, k) => ({
        id: id(200 + i * 10 + k), tenant_id: tid, name: `${name} ${[city, "Indiranagar", "Airport", "Phoenix Mall"][k]}`, code: `O${k + 1}`, city, state_code: sc,
        status: (status === "closed" || (k === 2 && i === 2) ? "inactive" : "active") as "active" | "inactive", pos_outlet_ref: `pos-${slug}-${k + 1}`, created_at: ago((110 - i * 9) * DAY),
      })),
    };
  });

  const features: T.Feature[] = [
    ["pos.counter", "Counter billing", "flag", null], ["kds", "Kitchen display", "flag", null], ["multi_outlet", "Multi-outlet", "flag", null],
    ["ai.assistant", "AI assistant", "flag", null], ["online.ordering", "Online ordering", "flag", null],
    ["limit.outlets", "Outlet limit", "limit", "outlets"], ["limit.staff_users", "User limit", "limit", "users"], ["limit.ai_calls", "AI calls per month", "limit", "calls"],
  ].map(([code, name, kind, unit]) => ({ code: code!, name: name!, description: null, kind: kind as "flag" | "limit", unit, is_active: true }));
  const pf = (codes: string[], limits: Record<string, number>): T.PlanFeature[] => features.map((f) => ({ feature_code: f.code, enabled: codes.includes(f.code) || f.code in limits, limit_value: limits[f.code] ?? null })).filter((x) => x.enabled);
  const plans: T.Plan[] = [
    { id: id(300), code: "starter", name: "Starter", description: "One outlet, counter billing", price_paise: 99900, billing_period: "month", is_active: true, version: 1, retired_at: null, created_at: ago(120 * DAY), features: pf(["pos.counter"], { "limit.outlets": 1, "limit.staff_users": 5 }) },
    { id: id(301), code: "growth", name: "Growth", description: "Kitchen display and online orders", price_paise: 249900, billing_period: "month", is_active: true, version: 1, retired_at: null, created_at: ago(120 * DAY), features: pf(["pos.counter", "kds", "online.ordering"], { "limit.outlets": 3, "limit.staff_users": 25, "limit.ai_calls": 500 }) },
    { id: id(302), code: "pro", name: "Pro", description: "Everything, multi-outlet", price_paise: 599900, billing_period: "month", is_active: true, version: 1, retired_at: null, created_at: ago(120 * DAY), features: pf(["pos.counter", "kds", "online.ordering", "multi_outlet", "ai.assistant"], { "limit.outlets": 20, "limit.staff_users": 200, "limit.ai_calls": 5000 }) },
  ];
  const planFor = ["growth", "starter", "pro", "growth", "starter", null, "starter"];
  const subStatus: T.SubscriptionStatus[] = ["active", "trialing", "active", "past_due", "active", "active", "cancelled"];
  const subs: T.Subscription[] = tenants.flatMap((t, i) => {
    const code = planFor[i];
    if (!code) return [];
    const plan = plans.find((p) => p.code === code)!;
    return [{ id: id(400 + i), tenant_id: t.id, plan_id: plan.id, status: subStatus[i], trial_end: subStatus[i] === "trialing" ? ahead(9 * DAY) : null, current_period_start: ago(10 * DAY), current_period_end: ahead(20 * DAY), cancel_at_period_end: false, ended_at: subStatus[i] === "cancelled" ? ago(12 * DAY) : null, created_at: ago(100 * DAY) }];
  });

  const gst = (taxable: number, buyerState: string | null) => {
    const total = Math.round(taxable * 0.18);
    if (buyerState === "29") { const c = Math.floor((total + 1) / 2); return { cgst: c, sgst: total - c, igst: 0, total: taxable + total }; }
    return { cgst: 0, sgst: 0, igst: total, total: taxable + total };
  };
  const mkInv = (n: number, ti: number, plan: T.Plan, status: T.InvoiceStatus, num: string | null, discount = 0) => {
    const t = tenants[ti]; const sub = subs.find((s) => s.tenant_id === t.id);
    const taxable = plan.price_paise - discount; const g = gst(taxable, t.profile.state_code);
    return {
      id: id(500 + n), tenant_id: t.id, subscription_id: sub?.id ?? null, number: num, status, currency: "INR", period_start: ago(40 * DAY), period_end: ago(10 * DAY),
      subtotal_paise: plan.price_paise, discount_paise: discount, taxable_paise: taxable, gst_rate_bps: 1800, cgst_paise: g.cgst, sgst_paise: g.sgst, igst_paise: g.igst, total_paise: g.total,
      supplier_gstin: "29AABCC1234D1Z9", supplier_state_code: "29", buyer_gstin: t.profile.gstin, buyer_state_code: t.profile.state_code, sac_code: "998314", tax_needs_ca_verification: true,
      issued_at: status === "draft" ? null : ago(38 * DAY), due_at: status === "draft" ? null : ago(24 * DAY), paid_at: status === "paid" ? ago(30 * DAY) : null, void_reason: status === "void" ? "Raised against wrong plan" : null, created_at: ago(40 * DAY),
      lines: [{ id: n, description: `${plan.name} plan (monthly)`, quantity: 1, unit_price_paise: plan.price_paise, amount_paise: plan.price_paise }],
    } satisfies T.Invoice & { lines: T.InvoiceLine[] };
  };
  const invoices = [
    mkInv(1, 0, plans[1], "paid", "CH-2026-000001"), mkInv(2, 1, plans[0], "paid", "CH-2026-000002"), mkInv(3, 2, plans[2], "issued", "CH-2026-000003"),
    mkInv(4, 3, plans[1], "issued", "CH-2026-000004"), mkInv(5, 4, plans[0], "draft", null), mkInv(6, 6, plans[0], "void", "CH-2026-000005"), mkInv(7, 2, plans[2], "paid", "CH-2026-000006", 50000),
  ];
  const pay = (n: number, inv: number, status: T.PaymentStatus, method: string) => ({
    id: id(600 + n), tenant_id: invoices[inv].tenant_id, invoice_id: invoices[inv].id, provider: "manual", provider_ref: `UTR${700000 + n * 37}`, amount_paise: invoices[inv].total_paise, currency: "INR", method, status, created_at: ago((30 - n) * DAY), updated_at: ago((29 - n) * DAY),
  });
  const payments = [pay(1, 0, "succeeded", "upi"), pay(2, 1, "succeeded", "bank_transfer"), pay(3, 3, "failed", "card"), pay(4, 5, "refunded", "upi"), pay(5, 6, "succeeded", "bank_transfer")];

  const mkEv = (n: number, app: string, from: T.OnboardingStatus | null, to: T.OnboardingStatus, actor: string, note: string | null, mins: number): T.OnboardingEvent => ({ id: n, application_id: app, from_status: from, to_status: to, actor, note, created_at: ago(mins) });
  const mkApp = (n: number, name: string, status: T.OnboardingStatus, source: T.OnboardingSource, plan: string | null, extra: Partial<T.OnboardingApplication> = {}) => {
    const aid = id(700 + n);
    return { id: aid, source, status, business_name: name, contact_name: ["Kiran Patil", "Lata Subramaniam", "Dev Arora", "Maya Reddy", "Ishaan Bose"][n % 5], email: `hello@${name.toLowerCase().replace(/[^a-z]+/g, "")}.in`, phone: `98${String(12345670 + n * 1111).padStart(8, "0")}`, plan_code: plan, business_types: ["restaurant"], provision_state: null, provision_next_at: null, provision_error_code: null, owner_invited_at: null, live_at: null, invite_sends: 0, marketing_ref: source === "marketing" ? `lead-${n}` : null, tenant_id: null, attempts: 0, last_error: null, reject_reason: null, created_at: ago((n + 1) * 2 * DAY), updated_at: ago(n * DAY), events: [mkEv(n * 10, aid, null, "received", source === "self_signup" ? "anon" : "service:marketing", source, (n + 1) * 2 * DAY)], ...extra } as T.OnboardingApplication & { events: T.OnboardingEvent[] };
  };
  const onboarding = [
    mkApp(0, "Spice Route Kitchen", "received", "self_signup", "growth"), mkApp(1, "Idli Express", "under_review", "marketing", "starter"),
    mkApp(2, "Koyla Grill House", "approved", "staff", "pro"), mkApp(3, "Lassi Lane", "provisioning", "marketing", "starter", { attempts: 1 }),
    mkApp(4, "Kesar Chai Adda", "provisioned", "self_signup", "starter", { tenant_id: tenants[5].id }), mkApp(5, "Biryani Bazaar Express", "rejected", "self_signup", null, { reject_reason: "Duplicate of an existing business (Biryani Bazaar)" }),
  ];

  const tk = (n: number, ti: number | null, subject: string, status: T.TicketStatus, priority: T.TicketPriority, comments: number): T.Ticket & { comments: T.TicketComment[] } => ({
    id: id(800 + n), tenant_id: ti === null ? null : tenants[ti].id, subject, body: `${subject}. Reported by the business owner over phone.`, priority, status, requester_email: ti === null ? null : tenants[ti].profile.contact_email,
    assignee_id: staff[2].id, created_by: "staff:support@chilli.test", created_at: ago((n + 1) * DAY), updated_at: ago(n * 60),
    comments: Array.from({ length: comments }, (_, k) => ({ id: id(850 + n * 5 + k), ticket_id: id(800 + n), author: "support@chilli.test", body: ["Looking into this now.", "Asked the owner to retry after updating the app."][k % 2], internal: k % 2 === 0, created_at: ago((n + 1) * DAY - 30 * (k + 1)) })),
  });
  const tickets = [tk(0, 0, "Printer not detected after update", "open", "high", 2), tk(1, 2, "Need GST invoice copy for March", "in_progress", "normal", 1), tk(2, 3, "Account suspended, please advise", "waiting", "urgent", 0), tk(3, null, "Question about Pro plan limits", "resolved", "low", 2)];
  const grants: T.SupportGrant[] = [
    { id: id(900), tenant_id: tenants[0].id, staff_id: staff[2].id, ticket_id: tickets[0].id, scope: "diagnostics", reason: "Diagnose printer pairing failure", granted_by: staff[0].id, starts_at: ago(10), expires_at: ahead(50), revoked_at: null, revoked_by: null, created_at: ago(10) },
    { id: id(901), tenant_id: tenants[2].id, staff_id: staff[2].id, ticket_id: null, scope: "read_only", reason: "Check GST settings with owner on call", granted_by: staff[1].id, starts_at: ago(3 * DAY), expires_at: ago(3 * DAY - 30), revoked_at: null, revoked_by: null, created_at: ago(3 * DAY) },
    { id: id(902), tenant_id: tenants[1].id, staff_id: staff[2].id, ticket_id: null, scope: "read_only", reason: "Verify onboarding checklist", granted_by: staff[0].id, starts_at: ago(2 * DAY), expires_at: ahead(60), revoked_at: ago(2 * DAY - 20), revoked_by: staff[0].id, created_at: ago(2 * DAY) },
  ];

  const aud = (n: number, actor: string, action: string, tType: string, tId: string | null, tenant: string | null, mins: number, meta: Record<string, unknown> | null = null, before: Record<string, unknown> | null = null, after: Record<string, unknown> | null = null): T.AuditEntry => ({ id: n, at: ago(mins), actor_type: "staff", actor_id: null, actor_label: actor, action, target_type: tType, target_id: tId, tenant_id: tenant, ip: "10.0.0.12", before, after, meta });
  const audit = [
    aud(12, "admin@chilli.test", "tenant.suspended", "tenant", tenants[3].id, tenants[3].id, 12 * DAY, { reason: "Unpaid invoice, 2 reminders sent" }, { status: "active" }, { status: "suspended" }),
    aud(11, "finance@chilli.test", "invoice.issued", "invoice", invoices[2].id, invoices[2].tenant_id, 38 * DAY, null, null, { number: "CH-2026-000003" }),
    aud(10, "super@chilli.test", "support_access.granted", "support_access_grant", grants[0].id, tenants[0].id, 10, { reason: "Diagnose printer pairing failure" }),
    aud(9, "admin@chilli.test", "entitlement.override_set", "tenant", tenants[1].id, tenants[1].id, 5 * DAY, { feature: "kds" }),
    aud(8, "super@chilli.test", "config.set", "config", "maintenance.banner", null, 6 * DAY, null, { value: null }, { value: "" }),
    aud(7, "admin@chilli.test", "onboarding.approved", "onboarding_application", onboarding[2].id, null, 2 * DAY),
  ];
  const sec = (n: number, type: string, severity: T.Severity, email: string | null, mins: number, details: Record<string, unknown> | null = null): T.SecurityEvent => ({ id: n, at: ago(mins), type, severity, staff_id: null, email, ip: "10.0.0.12", details });
  const security = [
    sec(8, "login_success", "info", "super@chilli.test", 60), sec(7, "support_access_granted", "warn", "support@chilli.test", 10, { grant_id: grants[0].id }),
    sec(6, "login_failed", "warn", "finance@chilli.test", 3 * 60), sec(5, "login_locked_out", "warn", "ops@chilli.test", 5 * 60),
    sec(4, "role_changed", "warn", "admin@chilli.test", 2 * DAY, { from: "support", to: "platform_admin" }), sec(3, "refresh_token_reuse", "critical", "support@chilli.test", 4 * DAY),
  ];
  const ai: T.AiUsageSummaryRow[] = [
    { tenant_id: tenants[0].id, feature: "ask_ai", calls: 412, input_tokens: 820_000, output_tokens: 190_000, cost_micro_inr: 38_400_000 },
    { tenant_id: tenants[0].id, feature: "invoice_ocr", calls: 90, input_tokens: 210_000, output_tokens: 31_000, cost_micro_inr: 9_100_000 },
    { tenant_id: tenants[2].id, feature: "ask_ai", calls: 1280, input_tokens: 2_400_000, output_tokens: 610_000, cost_micro_inr: 112_000_000 },
    { tenant_id: tenants[4].id, feature: "voice_order", calls: 55, input_tokens: 40_000, output_tokens: 18_000, cost_micro_inr: 3_300_000 },
  ];
  const job = (job_name: string, service: string, status: "ok" | "error", ageSec: number, interval: number, dur: number | null) => ({ job_name, service, status, last_seen_at: ago(ageSec / 60), last_duration_ms: dur, expected_interval_seconds: interval, details: null });
  const jobs = [job("sync.drain", "pos-service", "ok", 40, 60, 210), job("reports.rollup", "pos-service", "ok", 800, 900, 5400), job("onboarding.provision", "platform-core", "ok", 200, 300, 900), job("campaign.send", "marketing-service", "ok", 400, 600, 800)];
  const config: T.ConfigEntry[] = [
    { key: "maintenance.banner", value: "", description: "Message shown to all businesses; empty hides it", updated_by: "super@chilli.test", updated_at: ago(6 * DAY) },
    { key: "limits.max_outlets_trial", value: 2, description: "Outlets allowed during a trial", updated_by: "super@chilli.test", updated_at: ago(20 * DAY) },
    { key: "features.signup_open", value: true, description: "Public self-signup on or off", updated_by: "super@chilli.test", updated_at: ago(40 * DAY) },
  ];
  const entHistory: T.EntitlementHistoryRow[] = [{ id: 1, tenant_id: tenants[1].id, feature_code: "kds", before: { enabled: false, limit: null, source: "plan" }, after: { enabled: true, limit: null, source: "override" }, trigger: "override_set", actor: "admin@chilli.test", reason: "Pilot for 30 days", created_at: ago(5 * DAY) }];
  const overrides: T.EntitlementOverride[] = [{ tenant_id: tenants[1].id, feature_code: "kds", enabled: true, limit_value: null, reason: "Pilot for 30 days", expires_at: ahead(25 * DAY), created_by: "admin@chilli.test" }];

  for (const p of plans) { p.version = 1; p.retired_at = null; }
  const planVersions = Object.fromEntries(plans.map((p) => [p.code, [{ version: 1, change: "created" as const, note: null, actor: "super@chilli.test", at: ago(90 * DAY), snapshot: { name: p.name, description: p.description, price_paise: p.price_paise, billing_period: p.billing_period, features: p.features } }]]));
  // older signups so the analytics charts have a few months of shape
  const bySrc: T.OnboardingSource[] = ["self_signup", "marketing", "staff", "self_signup", "marketing", "self_signup"];
  for (let m = 1; m <= 5; m++) for (let k = 0; k < 6 - m + (m % 2); k++) {
    const t = ago(m * 30 * DAY - k * DAY);
    onboarding.push({ id: id(750 + m * 10 + k), source: bySrc[(m + k) % bySrc.length], status: "provisioned", business_name: EARLIER[(m * 7 + k) % EARLIER.length], contact_name: OWNERS[(m * 3 + k) % OWNERS.length], email: `hello@${EARLIER[(m * 7 + k) % EARLIER.length].toLowerCase().replace(/[^a-z]+/g, "")}.in`, phone: null, plan_code: "starter", business_types: ["restaurant"], provision_state: "live", provision_next_at: null, provision_error_code: null, owner_invited_at: t, live_at: t, invite_sends: 1, marketing_ref: null, tenant_id: null, attempts: 1, last_error: null, reject_reason: null, created_at: t, updated_at: t, events: [] });
  }
  const U = [id(950), id(951), id(952)];
  const mk = (n: number, name: string, role: string, codes: number, uses: number, commission: T.Balances): T.MarketingMember => ({ id: U[n], name, email: `${name.split(" ")[0].toLowerCase()}@marketing.test`, role, is_active: true, referral_codes: codes, referral_uses: uses, commission });
  const marketing = {
    members: [mk(0, "Meera Kapoor", "marketing_admin", 0, 0, {}), mk(1, "Arjun Nair", "salesperson", 2, 7, { INR: { pending_minor: 450000, approved_minor: 300000, paid_minor: 1200000 } }), mk(2, "Zoya Khan", "onboarding_agent", 0, 0, { INR: { pending_minor: 150000, approved_minor: 0, paid_minor: 300000 } })],
    referrals: [
      { id: "r1", code: "ARJUN10", owner_id: U[1], owner_name: "Arjun Nair", campaign_id: null, is_active: true, max_uses: 20, expires_at: null, created_at: ago(60 * DAY), uses: 5 },
      { id: "r2", code: "DIWALI", owner_id: U[1], owner_name: "Arjun Nair", campaign_id: null, is_active: false, max_uses: 10, expires_at: ago(5 * DAY), created_at: ago(40 * DAY), uses: 2 },
    ] as T.MarketingReferral[],
    entries: ([["pending", 450000, 1], ["approved", 300000, 1], ["paid", 1200000, 1], ["pending", 150000, 2], ["paid", 300000, 2]] as [string, number, number][]).map(([status, amt, u], i): T.CommissionEntry => ({ id: `e${i}`, kind: "commission", user_id: U[u], user_name: marketing_name(u), application_id: null, base_amount_minor: amt * 10, amount_minor: amt, currency: "INR", status, decided_at: status === "pending" ? null : ago(3 * DAY), created_at: ago((i + 2) * 6 * DAY) })),
    rules: [{ id: "ru1", name: "Referrer 5%", recipient: "referrer", calc: "percent_bps", rate_bps: 500, flat_amount_minor: 0, currency: "INR", is_active: true }] as T.CommissionRule[],
  };
  const credit = seedCredit(tenants, plans, ago);
  return { staff, tenants, onboarding, features, plans, subs, overrides, entHistory, invoices, payments, tickets, grants, audit, security, ai, jobs, config, sessions: [], mfa: { [staff[0].id]: { secret: DEMO_TOTP_SECRET, confirmed: true, last_step: null, recovery: DEMO_RECOVERY_CODES.map((c) => c.replace(/-/g, "")), recoveryUsed: [], demo: true } }, stepUp: [], mfaFailures: {}, planVersions, marketing, credit, seq: 2000 };
}
