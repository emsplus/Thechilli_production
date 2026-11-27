/**
 * The BFF forwards ONLY these platform-core routes. Anything else is refused before it leaves this server, so the UI cannot
 * be pointed at tenant operational data (orders, menus, customers, a restaurant's staff) even by a crafted request, and
 * cannot mint support tokens, record payments or manage service clients.
 */
interface Rule { method: string; pattern: RegExp }
const seg = "[^/]+";
const r = (method: string, p: string): Rule => ({ method, pattern: new RegExp(`^${p}$`) });

export const ALLOWED: Rule[] = [
  r("GET", "/auth/me"), r("POST", "/auth/change-password"),
  r("GET", "/auth/sessions"), r("DELETE", `/auth/sessions/${seg}`), r("POST", "/auth/sessions/revoke-others"),
  r("POST", "/auth/step-up"), // fresh code -> single-use grant for one protected action (docs/STEP_UP_UI_STATUS.md)
  r("GET", "/auth/mfa/status"), r("POST", "/auth/mfa/(enrol/start|enrol/confirm|disable|recovery-codes)"), // /auth/mfa/verify is a BFF session route, never proxied
  r("POST", `/staff/${seg}/mfa/reset`), r("DELETE", `/staff/${seg}/sessions`),
  r("GET", "/roles"), r("GET", "/staff"), r("POST", "/staff"), r("PATCH", `/staff/${seg}`), r("POST", `/staff/${seg}/reset-password`),
  r("GET", "/tenants"), r("GET", `/tenants/${seg}`),
  r("PATCH", `/tenants/${seg}`), // display_name / business_types only (platform-core body validation; never orders/menus/customers)
  r("POST", `/tenants/${seg}/(suspend|reactivate|close)`),
  r("GET", `/tenants/${seg}/subscription`), r("POST", `/tenants/${seg}/subscription`), r("POST", `/tenants/${seg}/subscription/cancel`),
  r("GET", "/onboarding/applications"), r("GET", `/onboarding/applications/${seg}`),
  r("POST", `/onboarding/applications/${seg}/(review|approve|reject|provision)`),
  r("GET", "/features"), r("GET", "/plans"), r("POST", "/plans"), r("PUT", `/plans/${seg}`), r("GET", `/plans/${seg}/versions`),
  r("POST", `/plans/${seg}/(retire|reactivate)`),
  r("GET", "/analytics/overview"), r("GET", "/analytics/export"), r("GET", "/marketing/(team|referrals|commissions)"), r("GET", "/subscriptions"),
  r("GET", `/entitlements/${seg}`), r("GET", `/entitlements/${seg}/history`),
  r("PUT", `/entitlements/${seg}/overrides/${seg}`), r("DELETE", `/entitlements/${seg}/overrides/${seg}`),
  r("GET", "/invoices"), r("GET", `/invoices/${seg}`), r("POST", `/invoices/${seg}/(issue|void)`),
  r("GET", "/payments"), // read-only: recording payments / refunds happens in the payment flow, never from HQ
  r("GET", "/tickets"), r("GET", `/tickets/${seg}`), r("PATCH", `/tickets/${seg}`), r("POST", `/tickets/${seg}/comments`),
  r("GET", "/support-access/grants"), r("POST", "/support-access/grants"), r("POST", `/support-access/grants/${seg}/revoke`),
  r("GET", "/audit-log"), r("GET", "/security-events"), r("GET", "/ai-usage/summary"),
  r("GET", "/system/health"),
  r("GET", "/config"), r("PUT", `/config/${seg}`), r("DELETE", `/config/${seg}`),
  // Chilli's own PAYG credit of a business (platform-core, staff only). Receipts (list) and the all-business monthly report feed
  // the Payments page (read-only). Single receipts, outbox, run-due and plan billing-settings are not used, so they stay closed.
  r("GET", `/admin/tenants/${seg}/wallet`), r("GET", `/admin/tenants/${seg}/wallet/ledger`),
  r("POST", `/admin/tenants/${seg}/wallet/(adjust|suspend|resume)`),
  r("GET", `/admin/tenants/${seg}/billing-settings`), r("PUT", `/admin/tenants/${seg}/billing-settings`),
  r("GET", `/admin/tenants/${seg}/usage`), r("GET", `/admin/tenants/${seg}/receipts`), r("GET", "/admin/billing/usage"),
];

export const isAllowed = (method: string, path: string) => ALLOWED.some((a) => a.method === method.toUpperCase() && a.pattern.test(path));

/** Query params the UI actually uses (src/lib/api/endpoints.ts). Everything else is dropped before it reaches platform-core. */
export const ALLOWED_QUERY = new Set(["limit", "offset", "status", "q", "source", "tenant", "invoice_id", "active", "action", "actor_id", "since", "until", "report", "type", "severity", "from", "to", "kind", "month", "format"]);

export function filterQuery(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of sp) if (ALLOWED_QUERY.has(k) && v.length <= 200) out.append(k, v);
  return out;
}

/**
 * Request headers the BFF passes on to platform-core, each only in the shape platform-core accepts; anything else is dropped.
 *  - `Idempotency-Key` (wallet adjust: a retry replays instead of crediting twice): 8-100 characters.
 *  - `X-Step-Up-Token`: the single-use grant from POST /auth/step-up ("sut_" + url-safe base64). The browser holds it in memory
 *    only and sends it back once with the repeated request.
 */
export const STEP_UP_TOKEN_RE = /^sut_[A-Za-z0-9_-]{16,200}$/;
export function forwardHeaders(h: Headers): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const k = h.get("idempotency-key");
  if (k && /^[A-Za-z0-9._:-]{8,100}$/.test(k)) out["Idempotency-Key"] = k;
  const t = h.get("x-step-up-token")?.trim();
  if (t && STEP_UP_TOKEN_RE.test(t)) out["X-Step-Up-Token"] = t;
  return Object.keys(out).length ? out : undefined;
}
