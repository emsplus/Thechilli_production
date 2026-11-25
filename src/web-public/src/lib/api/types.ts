/** Hand-written from the exported OpenAPI (openapi/platform-core.json, openapi/marketing-service.json); contract.test.ts keeps them honest. */
export interface OutletIn { name: string; city?: string; state_code?: string }
/** platform-core POST /onboarding/applications body (ApplicationIn). */
export interface ApplicationIn {
  business_name: string; contact_name: string; email: string;
  phone?: string; plan_code?: string; legal_name?: string; gstin?: string; state_code?: string; city?: string;
  outlets?: OutletIn[]; marketing_ref?: string; idempotency_key?: string;
}
/** 201 body for a first submission. `idempotency_receipt` is shown once, and only to anonymous callers that sent a key. */
export interface ApplicationCreated {
  id: string; status: string; source: string; business_name: string; contact_name: string; email: string;
  duplicate: false; idempotency_receipt?: string; created_at?: string;
}
/** Anonymous replay without the receipt: deliberately minimal. */
export interface ReplayAck { accepted: true; duplicate: true }
/** Replay with a valid receipt: the stored application (no payload / IP). */
export interface ApplicationReplay extends Omit<ApplicationCreated, "duplicate" | "idempotency_receipt"> { duplicate: true }
export type SubmitResult = ApplicationCreated | ApplicationReplay | ReplayAck;

export interface ReferralCheck { valid: true }

export interface PlanFeatureOut { feature_code: string; enabled: boolean; limit_value: number | null }
export interface PlanOut { code: string; name: string; price_paise: number; features: PlanFeatureOut[] }

/** marketing-service POST /public/invitations/validate. Today it answers {valid, expires_at}; the other fields are optional
 *  extras the page uses only when present (docs/INVITE_LINK_GAP.md). Treated as untrusted text. */
export interface InvitationCheck { valid: boolean; expires_at?: string; invited_by?: string; business_name?: string; contact_name?: string }
/** POST /public/invitations/redeem body (RedeemIn). The owner email comes from the invitation itself. */
export interface RedeemIn { token: string; owner_name: string; business_name: string; owner_phone?: string }
export interface RedeemOut { application_id: string; status: string }
