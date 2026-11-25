import type * as T from "@/lib/api/types";

export interface MockUser extends T.UserOut { password: string }
export interface MockDb {
  users: MockUser[]; leads: T.LeadOut[]; activities: T.ActivityOut[]; demos: T.DemoOut[]; apps: T.AppOut[];
  checklist: Record<string, T.ChecklistOut[]>; documents: T.DocumentOut[]; deliveries: Record<string, T.DeliveryOut[]>; invitations: T.InvitationOut[]; referrals: T.ReferralOut[];
  attributions: T.AttributionOut[]; campaigns: T.CampaignOut[]; rules: T.RuleOut[]; entries: T.EntryOut[]; audit: T.AuditOut[];
}

export { DEMO_LOGINS } from "./accounts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ago = (days: number, hours = 0) => new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString();
const inH = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
/** Local calendar date `days` from today, YYYY-MM-DD (campaign start/end dates). */
const day = (days: number) => { const d = new Date(Date.now() + days * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** Owner name and email for the seeded onboarding applications, in order. */
const OWNERS: [string, string][] = [["Arjun Rao", "arjun@tiffinbox.in"], ["Kabir Singh", "kabir@greenbowlkitchen.in"], ["Farah Qureshi", "farah@masalamile.in"]];
let seq = 1000;
export const newId = () => id(++seq);

export function seedDb(): MockDb {
  const u = (n: number, email: string, name: string, role: T.Role): MockUser => ({ id: id(n), email, name, role, is_active: true, created_at: ago(90), password: "demo-pass-1234" });
  const users = [
    u(1, "admin@example.com", "Asha Menon", "marketing_admin"),
    u(2, "sales@example.com", "Ravi Kulkarni", "salesperson"),
    u(3, "agent@example.com", "Omar Siddiqui", "onboarding_agent"),
    u(4, "neha@example.com", "Neha Batra", "salesperson"),
  ];
  const lead = (n: number, business_name: string, contact_name: string, phone: string, city: string, stage: T.LeadStage, owner: number | null, extra: Partial<T.LeadOut> = {}): T.LeadOut => ({
    id: id(100 + n), business_name, contact_name, phone, phone_norm: "+" + phone.replace(/\D/g, ""), email: null, city,
    business_type: "restaurant", source: "manual", stage, lost_reason: null, notes: null, owner_id: owner ? id(owner) : null,
    campaign_id: null, referral_code_id: null, created_by: id(owner ?? 1), created_at: ago(20 - n), updated_at: ago(n), ...extra,
  });
  const leads = [
    lead(1, "Sharma Dhaba", "Ravi Sharma", "+91 98100 11111", "Indore", "new", 2),
    lead(2, "Kaapi Kottai Cafe", "Priya Nair", "+91 98100 22222", "Kochi", "contacted", 2, { campaign_id: id(300) }),
    lead(3, "Nizam's Spice Route", "Imran Khan", "+91 98100 33333", "Hyderabad", "qualified", 2),
    lead(4, "Bombay Bakers", "Seema Shah", "+91 98100 44444", "Mumbai", "demo_scheduled", 2, { email: "seema@bombaybakers.in" }),
    lead(5, "Tiffin Box Cloud Kitchen", "Arjun Rao", "+91 98100 55555", "Bengaluru", "demo_done", 2, { business_type: "cloud_kitchen" }),
    lead(6, "Tandoor Tales", "Meera Iyer", "+91 98100 66666", "Chennai", "negotiation", 4),
    lead(7, "Green Bowl Kitchen", "Kabir Singh", "+91 98100 77777", "Delhi", "won", 2, { email: "kabir@greenbowlkitchen.in" }),
    lead(8, "Park Street Social", "Vikram Das", "+91 98100 88888", "Kolkata", "lost", 4, { lost_reason: "Chose a competitor" }),
    lead(9, "Kesar Chai Adda", "Anita Roy", "+91 98100 99999", "Pune", "new", null, { source: "public_form" }),
    lead(10, "Mylari Dosa Corner", "Gopal Krishna", "+91 98100 10101", "Mysuru", "contacted", 4),
    lead(11, "Lucknowi Biryani House", "Salim Ali", "+91 98100 12121", "Lucknow", "qualified", 4, { campaign_id: id(300) }),
  ];
  const act = (n: number, lead_id: string, type: T.ActivityType, summary: string, due: string | null, done: boolean, assignee = 2): T.ActivityOut => ({
    id: id(400 + n), lead_id, type, summary, due_at: due, completed_at: done ? ago(1) : null, assignee_id: id(assignee), created_by: id(assignee), created_at: ago(3),
  });
  const activities = [
    act(1, id(101), "call", "Intro call, send brochure on WhatsApp", inH(2), false),
    act(2, id(102), "whatsapp", "Share pricing sheet", inH(-5), false),
    act(3, id(103), "visit", "Visit the outlet, meet the owner", inH(6), false),
    act(4, id(104), "call", "Confirm demo time", inH(30), false),
    act(5, id(105), "email", "Send proposal", null, true),
    act(6, id(106), "call", "Negotiate annual plan", inH(3), false, 4),
  ];
  const demo = (n: number, lead_id: string, at: string, status: T.DemoStatus = "scheduled", assignee = 2): T.DemoOut => ({
    id: id(500 + n), lead_id, assignee_id: id(assignee), scheduled_at: at, duration_minutes: 30, mode: "online", location: null, status, outcome_notes: null, created_at: ago(2),
  });
  const demos = [demo(1, id(104), inH(4)), demo(2, id(105), ago(2), "completed"), demo(3, id(103), inH(52))];
  const app = (n: number, business_name: string, lead_id: string | null, status: T.AppStatus, agent: number | null, source: T.AppSource = "assisted", extra: Partial<T.AppOut> = {}): T.AppOut => ({
    id: id(600 + n), lead_id, agent_id: agent ? id(agent) : null, source, status, business_name, owner_name: OWNERS[n - 1]![0], owner_email: OWNERS[n - 1]![1],
    owner_phone: null, referral_code_id: null, contract_value_minor: 2_998_800, currency: "INR", external_business_id: null, provisioning_error: null, provisioned_at: null, platform_status: null, billing_status: null, status_checked_at: null, created_at: ago(8 - n), ...extra,
  });
  const apps = [
    app(1, "Tiffin Box Cloud Kitchen", id(105), "in_progress", 3),
    app(2, "Green Bowl Kitchen", id(107), "provisioned", 3, "assisted", { contract_value_minor: 14_994_000, external_business_id: "6f1c2a9e-3b7d-4e52-9a18-2c4d7e8f0b31", provisioned_at: ago(4), platform_status: "provisioned", billing_status: "trialing", status_checked_at: ago(1) }),
    app(3, "Masala Mile", null, "draft", 3, "self_signup", { contract_value_minor: 0 }),
  ];
  const item = (key: T.ChecklistKey, status: T.ChecklistStatus, data: Record<string, unknown> = {}): T.ChecklistOut => ({ key, status, data, updated_at: ago(1) });
  const checklist: MockDb["checklist"] = {
    [id(601)]: [
      item("business_type", "done", { business_type: "cloud_kitchen" }),
      item("outlet", "done", { name: "Koramangala", city: "Bengaluru", country: "IN" }),
      item("menu", "in_progress", { source: "upload", item_count: 24, ready: false }),
      item("staff", "pending"), item("documents", "pending"),
    ],
    [id(602)]: [
      item("business_type", "done", { business_type: "restaurant" }), item("outlet", "done", { name: "Hauz Khas", city: "Delhi", country: "IN" }),
      item("menu", "done", { source: "manual", item_count: 40, ready: true }), item("staff", "done", { staff_count: 14, planned_roles: ["owner", "cashier"] }),
      item("documents", "done", { documents: [{ type: "trade_licence", status: "verified", reference: "doc-1" }, { type: "owner_id", status: "verified", reference: "doc-2" }] }),
    ],
    [id(603)]: (["business_type", "outlet", "menu", "staff", "documents"] as T.ChecklistKey[]).map((k) => item(k, "pending")),
  };
  const invitations: T.InvitationOut[] = [
    { id: id(700), email: "seema@bombaybakers.in", lead_id: id(104), application_id: null, referral_code_id: null, expires_at: inH(48), used_at: null, revoked_at: null, created_at: ago(1) },
    { id: id(701), email: "kabir@greenbowlkitchen.in", lead_id: id(107), application_id: id(602), referral_code_id: null, expires_at: ago(3), used_at: ago(5), revoked_at: null, created_at: ago(7) },
  ];
  const referrals: T.ReferralOut[] = [
    { id: id(800), code: "RAVI2026", owner_id: id(2), campaign_id: id(300), is_active: true, max_uses: 50, expires_at: null, created_at: ago(30), uses: 3 },
    { id: id(801), code: "NEHA10", owner_id: id(4), campaign_id: null, is_active: true, max_uses: null, expires_at: null, created_at: ago(20), uses: 1 },
  ];
  const attributions: T.AttributionOut[] = [
    { id: id(850), referral_code_id: id(800), lead_id: id(102), application_id: null, created_at: ago(10) },
    { id: id(851), referral_code_id: id(800), lead_id: id(107), application_id: id(602), created_at: ago(12) },
  ];
  const campaigns: T.CampaignOut[] = [
    { id: id(300), name: "Diwali Restaurant Push", channel: "whatsapp", status: "active", budget_minor: 50_000_000, currency: "INR", starts_on: day(-30), ends_on: day(30), created_at: ago(30) },
    { id: id(301), name: "Cafe Owners Meetup, Bengaluru", channel: "events", status: "draft", budget_minor: 15_000_000, currency: "INR", starts_on: null, ends_on: null, created_at: ago(5) },
    { id: id(302), name: "Cloud Kitchen Webinar Series", channel: "webinar", status: "paused", budget_minor: 7_500_000, currency: "INR", starts_on: day(-21), ends_on: day(40), created_at: ago(25) },
    { id: id(303), name: "Monsoon WhatsApp Offer", channel: "whatsapp", status: "ended", budget_minor: 24_000_000, currency: "INR", starts_on: day(-120), ends_on: day(-60), created_at: ago(125) },
    { id: id(304), name: "Restaurant Partner Referrals", channel: "referral", status: "active", budget_minor: 120_000_000, currency: "INR", starts_on: day(-90), ends_on: null, created_at: ago(92) },
  ];
  const rules: T.RuleOut[] = [
    { id: id(900), name: "Salesperson 5% of contract", recipient: "lead_owner", calc: "percent_bps", flat_amount_minor: 0, rate_bps: 500, cap_minor: 500_000, min_base_minor: 0, currency: "INR", is_active: true, valid_from: null, valid_to: null },
    { id: id(901), name: "Onboarding flat fee", recipient: "application_agent", calc: "flat", flat_amount_minor: 250_000, rate_bps: 0, cap_minor: null, min_base_minor: 0, currency: "INR", is_active: true, valid_from: null, valid_to: null },
  ];
  const entry = (n: number, user: number, status: T.EntryStatus, amount: number, application: number | null, extra: Partial<T.EntryOut> = {}): T.EntryOut => ({
    id: id(1100 + n), kind: "commission", rule_id: id(900), user_id: id(user), application_id: application ? id(600 + application) : null, lead_id: null,
    base_amount_minor: 14_994_000, amount_minor: amount, currency: "INR", status, reverses_entry_id: null, decided_by: null, decided_at: null, note: null, created_at: ago(4), ...extra,
  });
  const entries = [
    entry(1, 2, "pending", 500_000, 2),
    entry(2, 3, "pending", 250_000, 2, { rule_id: id(901) }),
    entry(3, 1, "pending", 149_900, null, { base_amount_minor: 2_998_800 }),
    entry(4, 2, "paid", 4_250_000, null, { base_amount_minor: 85_000_000, decided_by: id(1), decided_at: ago(20) }),
    entry(5, 4, "approved", 1_875_000, null, { base_amount_minor: 37_500_000, decided_by: id(1), decided_at: ago(6) }),
  ];
  const audit: T.AuditOut[] = [
    { id: id(1300), actor_id: id(2), action: "lead.created", entity_type: "lead", entity_id: id(101), meta: { source: "manual", duplicate_forced: false }, created_at: ago(9) },
    { id: id(1301), actor_id: id(1), action: "commission.approved", entity_type: "commission_entry", entity_id: id(1105), meta: { amount_minor: 1_875_000, status: "approved" }, created_at: ago(6) },
    { id: id(1302), actor_id: id(3), action: "onboarding.provisioned", entity_type: "onboarding_application", entity_id: id(602), meta: { business_id: "6f1c2a9e-3b7d-4e52-9a18-2c4d7e8f0b31" }, created_at: ago(4) },
  ];
  return { users, leads, activities, demos, apps, checklist, documents: [], deliveries: {}, invitations, referrals, attributions, campaigns, rules, entries, audit };
}
