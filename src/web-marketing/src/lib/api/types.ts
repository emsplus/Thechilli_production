// Hand-written from marketing-service OpenAPI (openapi/marketing-service.json). Money is integer minor units.
// A contract test (src/lib/api/contract.test.ts) checks that every endpoint the client calls exists in the schema.

export type Role = "marketing_admin" | "salesperson" | "onboarding_agent";
export const ROLES: Role[] = ["marketing_admin", "salesperson", "onboarding_agent"];

export type LeadStage = "new" | "contacted" | "qualified" | "demo_scheduled" | "demo_done" | "negotiation" | "won" | "lost";
export type ActivityType = "call" | "whatsapp" | "email" | "visit" | "note" | "follow_up";
export type DemoStatus = "scheduled" | "completed" | "cancelled" | "no_show";
export type AppStatus = "draft" | "in_progress" | "ready" | "provisioned" | "cancelled";
export type AppSource = "assisted" | "self_signup";
export type ChecklistKey = "business_type" | "outlet" | "menu" | "staff" | "documents";
export type ChecklistStatus = "pending" | "in_progress" | "done";
export type CampaignStatus = "draft" | "active" | "paused" | "ended";
export type Recipient = "lead_owner" | "application_agent" | "referrer";
export type Calc = "flat" | "percent_bps";
export type EntryKind = "commission" | "reversal";
export type EntryStatus = "pending" | "approved" | "rejected" | "paid";

export interface TokenOut { access_token: string; refresh_token: string; token_type: string }
export interface UserOut { id: string; email: string; name: string; role: Role; is_active: boolean; created_at: string }
export interface UserCreate { email: string; name: string; password: string; role: Role }
export interface UserUpdate { name?: string; role?: Role; is_active?: boolean; password?: string }

export interface LeadOut {
  id: string; business_name: string; contact_name: string; phone: string | null; phone_norm: string | null;
  email: string | null; city: string | null; business_type: string | null; source: string; stage: LeadStage;
  lost_reason: string | null; notes: string | null; owner_id: string | null; campaign_id: string | null;
  referral_code_id: string | null; created_by: string | null; created_at: string; updated_at: string;
}
export interface LeadCreate {
  business_name: string; contact_name: string; phone?: string | null; email?: string | null; city?: string | null;
  business_type?: string | null; source?: string; notes?: string | null; campaign_id?: string | null;
  referral_code?: string | null; owner_id?: string | null;
}
export type LeadUpdate = Partial<Omit<LeadCreate, "referral_code" | "owner_id">>;
export interface DuplicateOut { id: string; business_name: string; stage: LeadStage; owner_id: string | null }
export interface LeadQuery {
  stage?: LeadStage; owner_id?: string; campaign_id?: string; unassigned?: boolean; q?: string; limit?: number; offset?: number;
}

export interface ActivityCreate { type: ActivityType; summary: string; due_at?: string | null; assignee_id?: string | null; completed?: boolean }
export interface ActivityOut {
  id: string; lead_id: string; type: ActivityType; summary: string; due_at: string | null; completed_at: string | null;
  assignee_id: string | null; created_by: string; created_at: string;
}
export interface ActivityQuery { status?: "pending" | "overdue" | "completed" | "all"; due_before?: string; mine?: boolean; limit?: number }

export interface DemoCreate { scheduled_at: string; duration_minutes?: number; mode?: "online" | "on_site"; location?: string | null; assignee_id?: string | null }
export interface DemoUpdate { scheduled_at?: string; duration_minutes?: number; location?: string | null; status?: DemoStatus; outcome_notes?: string | null; assignee_id?: string | null }
export interface DemoOut {
  id: string; lead_id: string; assignee_id: string; scheduled_at: string; duration_minutes: number; mode: string;
  location: string | null; status: DemoStatus; outcome_notes: string | null; created_at: string;
}
export interface DemoQuery { status?: DemoStatus; lead_id?: string; assignee_id?: string; start?: string; end?: string; limit?: number }

export interface AppCreate {
  lead_id?: string | null; business_name?: string | null; owner_name?: string | null; owner_email?: string | null;
  owner_phone?: string | null; contract_value_minor?: number; currency?: string | null; agent_id?: string | null;
}
export interface AppUpdate { business_name?: string; owner_name?: string | null; owner_email?: string | null; owner_phone?: string | null; contract_value_minor?: number }
export interface AppOut {
  id: string; lead_id: string | null; agent_id: string | null; source: AppSource; status: AppStatus; business_name: string;
  owner_name: string | null; owner_email: string | null; owner_phone: string | null; referral_code_id: string | null;
  contract_value_minor: number; currency: string; external_business_id: string | null; provisioning_error: string | null;
  provisioned_at: string | null; platform_status: string | null; billing_status: string | null; status_checked_at: string | null; created_at: string;
}
export interface ActivationOut {
  application_id: string; status: AppStatus; external_business_id: string | null; platform_status: string | null; billing_status: string | null;
  activated: boolean; paying: boolean; status_checked_at: string | null;
}
export interface DocumentOut { id: string; application_id: string; doc_type: DocType; filename: string; content_type: string; size_bytes: number; status: "received" | "verified" | "rejected"; created_at: string }
export interface DeliveryOut { id: string; channel: string; provider: string; status: "sent" | "failed"; error: string | null; created_at: string }
export interface AppQuery { status?: AppStatus; agent_id?: string; limit?: number; offset?: number }
export interface ChecklistOut { key: ChecklistKey; status: ChecklistStatus; data: Record<string, unknown>; updated_at: string }
export interface Readiness { status: AppStatus; ready: boolean; blockers: string[]; items: { key: ChecklistKey; status: ChecklistStatus }[] }

// Checklist payloads (marketing-service app/schemas/checklist.py, extra=forbid: no restaurant operational data).
export type BusinessKind = "restaurant" | "cafe" | "bakery" | "cloud_kitchen" | "food_truck" | "bar" | "other";
export type DocType = "trade_licence" | "owner_id" | "tax_certificate" | "other";
export interface DocumentRef { type: DocType; status: "received" | "verified" | "rejected"; reference: string }
export interface ChecklistPayloads {
  business_type: { business_type: BusinessKind; cuisine?: string | null };
  outlet: { name: string; city: string; country: string; address_line?: string | null; timezone?: string | null; expected_tables?: number | null };
  menu: { source: "manual" | "upload" | "pos_import"; item_count: number; ready: boolean };
  staff: { staff_count: number; planned_roles: ("owner" | "manager" | "cashier" | "waiter" | "kitchen")[] };
  documents: { documents: DocumentRef[] };
}

export interface InvitationCreate { email: string; lead_id?: string | null; application_id?: string | null; referral_code?: string | null; ttl_hours?: number | null; send?: boolean }
export interface InvitationOut {
  id: string; email: string; lead_id: string | null; application_id: string | null; referral_code_id: string | null;
  expires_at: string; used_at: string | null; revoked_at: string | null; created_at: string; delivery_status?: "sent" | "failed" | null;
}
export interface InvitationCreated extends InvitationOut { token: string }

export interface ReferralCreate { code?: string | null; owner_id?: string | null; campaign_id?: string | null; max_uses?: number | null; expires_at?: string | null }
export interface ReferralUpdate { is_active?: boolean; max_uses?: number | null; expires_at?: string | null }
export interface ReferralOut {
  id: string; code: string; owner_id: string; campaign_id: string | null; is_active: boolean; max_uses: number | null;
  expires_at: string | null; created_at: string; uses: number;
}
export interface AttributionOut { id: string; referral_code_id: string; lead_id: string | null; application_id: string | null; created_at: string }

export interface CampaignCreate { name: string; channel: string; status?: CampaignStatus; budget_minor?: number; currency?: string | null; starts_on?: string | null; ends_on?: string | null }
export type CampaignUpdate = Partial<Omit<CampaignCreate, "currency">>;
export interface CampaignOut {
  id: string; name: string; channel: string; status: CampaignStatus; budget_minor: number; currency: string;
  starts_on: string | null; ends_on: string | null; created_at: string;
}
export interface CampaignStats {
  campaign_id: string; leads: number; by_stage: Record<LeadStage, number>; won: number; conversion_bps: number;
  cost_per_lead_minor: number | null; referral_attributions: number; currency: string;
}

export interface RuleCreate {
  name: string; recipient: Recipient; calc: Calc; flat_amount_minor?: number; rate_bps?: number; cap_minor?: number | null;
  min_base_minor?: number; currency?: string | null; valid_from?: string | null; valid_to?: string | null;
}
export interface RuleUpdate { is_active?: boolean; valid_to?: string | null; cap_minor?: number | null }
export interface RuleOut {
  id: string; name: string; recipient: Recipient; calc: Calc; flat_amount_minor: number; rate_bps: number; cap_minor: number | null;
  min_base_minor: number; currency: string; is_active: boolean; valid_from: string | null; valid_to: string | null;
}
export interface EntryOut {
  id: string; kind: EntryKind; rule_id: string | null; user_id: string; application_id: string | null; lead_id: string | null;
  base_amount_minor: number; amount_minor: number; currency: string; status: EntryStatus; reverses_entry_id: string | null;
  decided_by: string | null; decided_at: string | null; note: string | null; created_at: string;
}
export interface EntryQuery { status?: EntryStatus; user_id?: string; limit?: number; offset?: number }
export interface CommissionSummary {
  user_id: string;
  balances: Record<string, { pending_minor: number; approved_minor: number; paid_minor: number }>;
}
export interface AuditOut {
  id: string; actor_id: string | null; action: string; entity_type: string; entity_id: string | null;
  meta: Record<string, unknown> | null; created_at: string;
}
export interface AuditQuery { entity_type?: string; entity_id?: string; actor_id?: string; action?: string; limit?: number; offset?: number }
