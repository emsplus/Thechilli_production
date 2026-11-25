import type { ApplicationIn, PlanOut } from "@/lib/api/types";
import { PLANS } from "@/lib/plans";

/** In-memory stand-in for platform-core (onboarding, plans) and marketing-service (referral codes, invitations). Mirrors their contract,
 *  including anonymous idempotency: the receipt is returned once; a replay without it gets {accepted, duplicate}. */
export const MOCK_REFERRAL_CODES = ["CHILLI10", "WELCOME"];
/** Mock invitation tokens. PLAIN answers like marketing-service today ({valid, expires_at}); RICH also returns the optional
 *  prefill/partner fields the page supports (docs/INVITE_LINK_GAP.md). Anything else is invalid; a redeemed token is used up. */
export const MOCK_INVITE_PLAIN = "invite-plain-token-0001";
export const MOCK_INVITE_RICH = "invite-rich-token-0002";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const err = (status: number, code: string, message: string, headers?: Record<string, string>) => json({ error: { code, message } }, status, headers);
const unprocessable = (field: string, msg: string) => json({ detail: [{ loc: ["body", field], msg, type: "value_error" }] }, 422);

interface Stored { app: Record<string, unknown>; receipt: string }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function randomToken() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createMockFetch(): typeof fetch {
  const byKey = new Map<string, Stored>();
  const usedInvites = new Set<string>();
  return async (input, init) => {
    await new Promise((r) => setTimeout(r, 120));
    const url = new URL(String(input), "http://mock.local");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const path = url.pathname.replace(/^\/mock\/(platform|marketing)/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "POST" && path === "/api/v1/onboarding/applications") {
      const b = body as ApplicationIn;
      if (!b?.business_name || b.business_name.length < 2) return unprocessable("business_name", "String should have at least 2 characters");
      if (!b.contact_name || b.contact_name.length < 2) return unprocessable("contact_name", "String should have at least 2 characters");
      if (!b.email || !EMAIL.test(b.email)) return unprocessable("email", "value is not a valid email address");
      if (b.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(b.gstin.toUpperCase())) return unprocessable("gstin", "invalid GSTIN format");
      if (b.state_code && !/^\d{2}$/.test(b.state_code)) return unprocessable("state_code", "String should match pattern '^\\d{2}$'");
      // docs/BUSINESS_TYPES.md: optional (defaults to ["restaurant"]); 422 for an empty list or an unknown id.
      const types = (body as { business_types?: unknown }).business_types;
      if (types !== undefined && (!Array.isArray(types) || types.length === 0 || types.some((x) => !["restaurant", "cloud_kitchen", "hotel_kitchen"].includes(x as string))))
        return unprocessable("business_types", "Choose one or more of restaurant, cloud_kitchen, hotel_kitchen");
      if (b.business_name.includes("[429]")) return err(429, "rate_limited", "Too many applications from this address. Try again later.", { "Retry-After": "3600" });
      if (b.business_name.includes("[500]")) return err(500, "internal", "Something went wrong");
      const key = b.idempotency_key ? `self_signup:${b.idempotency_key}` : undefined;
      const existing = key ? byKey.get(key) : undefined;
      if (existing) {
        const sent = headers.get("X-Idempotency-Receipt");
        return sent && sent === existing.receipt ? json({ ...existing.app, duplicate: true }, 201) : json({ accepted: true, duplicate: true }, 201);
      }
      const app = {
        id: crypto.randomUUID(), status: "received", source: "self_signup", business_name: b.business_name, contact_name: b.contact_name,
        email: b.email.toLowerCase(), phone: b.phone ?? null, plan_code: b.plan_code ?? null, created_at: new Date().toISOString(),
      };
      const receipt = randomToken();
      if (key) byKey.set(key, { app, receipt });
      return json({ ...app, duplicate: false, ...(key ? { idempotency_receipt: receipt } : {}) }, 201);
    }

    if (method === "POST" && path === "/api/v1/public/invitations/validate") {
      const tok = (body as { token?: string } | undefined)?.token;
      if (!tok || tok.length < 10) return unprocessable("token", "String should have at least 10 characters");
      if (tok === MOCK_INVITE_PLAIN && !usedInvites.has(tok)) return json({ valid: true, expires_at: new Date(Date.now() + 72 * 3600e3).toISOString() });
      if (tok === MOCK_INVITE_RICH && !usedInvites.has(tok))
        return json({ valid: true, expires_at: new Date(Date.now() + 72 * 3600e3).toISOString(), invited_by: "Meera Joshi", business_name: "Green Leaf Kitchen", contact_name: "Farah Khan" });
      return json({ valid: false });
    }
    if (method === "POST" && path === "/api/v1/public/invitations/redeem") {
      const b = body as { token?: string; owner_name?: string; business_name?: string; owner_phone?: string } | undefined;
      if (!b?.token || b.token.length < 10) return unprocessable("token", "String should have at least 10 characters");
      if (!b.owner_name) return unprocessable("owner_name", "Field required");
      if (!b.business_name) return unprocessable("business_name", "Field required");
      if (![MOCK_INVITE_PLAIN, MOCK_INVITE_RICH].includes(b.token) || usedInvites.has(b.token)) return json({ detail: "This invitation is invalid, already used or expired" }, 410);
      if (b.business_name.includes("[500]")) return err(500, "internal", "Something went wrong");
      usedInvites.add(b.token);
      return json({ application_id: crypto.randomUUID(), status: "draft" }, 201);
    }

    const ref = /^\/api\/v1\/public\/referral-codes\/([^/]+)$/.exec(path);
    if (method === "GET" && ref) {
      return MOCK_REFERRAL_CODES.includes(decodeURIComponent(ref[1]!).trim().toUpperCase())
        ? json({ valid: true })
        : json({ detail: "Referral code not found or no longer valid" }, 404);
    }

    if (method === "GET" && path === "/api/v1/plans") {
      const items: PlanOut[] = PLANS.map((p) => ({ code: p.code, name: p.name, price_paise: p.pricePaise, features: p.features.map((f) => ({ feature_code: f.code, enabled: true, limit_value: f.limit ?? null })) }));
      return json({ items });
    }
    return err(404, "not_found", "Not found");
  };
}
