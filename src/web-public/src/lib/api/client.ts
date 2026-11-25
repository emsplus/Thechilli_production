import { createHttp } from "./http";
import type { ApplicationIn, InvitationCheck, PlanOut, RedeemIn, RedeemOut, ReferralCheck, SubmitResult } from "./types";

export interface ApiOptions {
  /** platform-core base including /api/v1 */
  platformUrl: string;
  /** marketing-service base including /api/v1 */
  marketingUrl: string;
  fetchImpl?: typeof fetch;
}

export function createApi(o: ApiOptions) {
  const http = createHttp({ fetchImpl: o.fetchImpl });
  const P = o.platformUrl.replace(/\/$/, "");
  const M = o.marketingUrl.replace(/\/$/, "");
  return {
    onboarding: {
      /**
       * Anonymous self-signup. The body's idempotency_key makes a retry safe. Pass `receipt` (kept from the first 201)
       * to replay and get the full record back; without it a replay only returns {accepted, duplicate}.
       */
      submit: (body: ApplicationIn, receipt?: string) =>
        http<SubmitResult>("POST", `${P}/onboarding/applications`, { body, headers: receipt ? { "X-Idempotency-Receipt": receipt } : undefined }),
    },
    marketing: {
      checkReferralCode: (code: string) => http<ReferralCheck>("GET", `${M}/public/referral-codes/${encodeURIComponent(code)}`),
      /** Always 200 with {valid}; a bad, used, revoked or expired token all look the same. Rate limited per IP. */
      validateInvitation: (token: string) => http<InvitationCheck>("POST", `${M}/public/invitations/validate`, { body: { token } }),
      /** Single use: consumes the token and creates the onboarding application with the invitation's referral attribution. 410 when invalid/used/expired. */
      redeemInvitation: (body: RedeemIn) => http<RedeemOut>("POST", `${M}/public/invitations/redeem`, { body }),
    },
    catalog: {
      /** Staff-only today (401 anonymously). Pricing falls back to static data when this fails. */
      listPlans: () => http<{ items: PlanOut[] }>("GET", `${P}/plans`),
    },
  };
}
export type Api = ReturnType<typeof createApi>;
