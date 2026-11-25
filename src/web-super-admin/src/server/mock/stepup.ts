import { verifyTotp } from "./totp";
import type { Store, StaffRecord } from "./seed";

/**
 * Per-action step-up, modelled like platform-core (docs/STEP_UP.md there): POST /auth/step-up trades a fresh code for a
 * single-use grant bound to the staff member AND the session, valid HQ_MOCK_STEP_UP_MINUTES (5); the protected routes answer
 * 403 step_up_required + X-Step-Up-Required until the request carries it as X-Step-Up-Token. Only the routes in
 * platform-core's table are protected, some only for certain fields. A use is taken only when the action succeeds.
 *
 * Demo: super@chilli.test has two-step set up with a fixed key, so the offline demo and tests need no authenticator app:
 *   code 123456 (always accepted for this demo factor), or the TOTP of the key, or a recovery code below.
 */
export const DEMO_STEP_UP_CODE = "123456";
export const DEMO_TOTP_SECRET = "CHILLIDEMOSTEPUPKEY234567ABCDEFG";
export const DEMO_RECOVERY_CODES = ["ABCDE-FGHJK-LMNPQ", "RSTUV-WXYZ2-34567", "23456-789AB-CDEFG"];

export interface MockGrant { id: string; token: string; staff_id: string; session_id: string | null; method: "totp" | "recovery_code"; uses_left: number; expires_at: number }

/** `HQ_MOCK_STEP_UP=false` switches it off, like STEP_UP_REQUIRED=false in platform-core. */
export const stepUpEnabled = () => process.env.HQ_MOCK_STEP_UP !== "false";
const minutes = () => Math.max(1, Number(process.env.HQ_MOCK_STEP_UP_MINUTES) || 5);
const maxUses = () => Math.max(1, Number(process.env.HQ_MOCK_STEP_UP_MAX_USES) || 1);

const seg = "[^/]+";
type Body = Record<string, unknown>;
const has = (b: Body, ...keys: string[]) => keys.some((k) => b[k] !== undefined);
/** platform-core's protected routes (STEP_UP.md). `when`: only when the body carries one of these fields. */
const PROTECTED: { method: string; re: RegExp; when?: (b: Body) => boolean }[] = [
  { method: "POST", re: new RegExp(`^/admin/tenants/${seg}/wallet/(adjust|suspend|resume)$`) },
  { method: "PUT", re: new RegExp(`^/admin/(tenants|plans)/${seg}/billing-settings$`) },
  { method: "POST", re: new RegExp(`^/invoices/${seg}/void$`) },
  { method: "POST", re: new RegExp(`^/payments(/${seg}/status)?$`) },
  { method: "PUT", re: new RegExp(`^/plans/${seg}$`) },
  { method: "PATCH", re: new RegExp(`^/plans/${seg}$`), when: (b) => has(b, "price_paise", "is_active") },
  { method: "POST", re: new RegExp(`^/plans/${seg}/(retire|reactivate)$`) },
  { method: "POST", re: new RegExp(`^/tenants/${seg}/(suspend|reactivate|close)$`) },
  { method: "PUT", re: new RegExp(`^/entitlements/${seg}/overrides/${seg}$`) },
  { method: "DELETE", re: new RegExp(`^/entitlements/${seg}/overrides/${seg}$`) },
  { method: "POST", re: /^\/staff$/ },
  { method: "PATCH", re: new RegExp(`^/staff/${seg}$`), when: (b) => has(b, "role", "is_active") },
  { method: "POST", re: new RegExp(`^/staff/${seg}/(reset-password|mfa/reset)$`) },
  { method: "DELETE", re: new RegExp(`^/staff/${seg}/sessions$`) },
  { method: "POST", re: new RegExp(`^/service-clients(/${seg}/revoke)?$`) },
  { method: "POST", re: /^\/support-access\/grants$/ },
  { method: "PUT", re: new RegExp(`^/config/${seg}$`) },
  { method: "DELETE", re: new RegExp(`^/config/${seg}$`) },
];
export const isProtected = (method: string, path: string, body: Body) => PROTECTED.some((r) => r.method === method && r.re.test(path) && (!r.when || r.when(body)));

const hasFactor = (s: Store, id: string) => !!s.mfa[id]?.confirmed;
/** Who must step up: everyone with a confirmed factor, and every member of a mandatory role (who is then refused without one). */
export const needsStepUp = (s: Store, u: StaffRecord, mandatory: Set<string>) => stepUpEnabled() && (mandatory.has(u.role) || hasFactor(s, u.id));

export type Gate = { ok: true; grant: MockGrant | null } | { ok: false; reason: string; message: string };
const EXPIRED = "Your two-step confirmation has expired; enter a fresh code";
const ASK = "Confirm this action with a fresh two-step code";

/** Checks the grant on a protected request; does NOT consume it (the caller does that once the action succeeded). */
export function checkGrant(s: Store, u: StaffRecord & { sid?: string }, token: string | undefined, mandatory: Set<string>, now = Date.now()): Gate {
  if (!needsStepUp(s, u, mandatory)) return { ok: true, grant: null };
  const t = (token ?? "").trim();
  if (!t) return { ok: false, reason: "missing", message: ASK };
  if (mandatory.has(u.role) && !hasFactor(s, u.id)) return { ok: false, reason: "not_enrolled", message: ASK };
  const g = s.stepUp.find((x) => x.token === t);
  if (!g) return { ok: false, reason: "invalid", message: ASK };
  if (g.staff_id !== u.id) return { ok: false, reason: "wrong_user", message: ASK };
  if (!u.sid || g.session_id !== u.sid) return { ok: false, reason: "wrong_session", message: ASK };
  if (g.expires_at <= now) return { ok: false, reason: "expired", message: EXPIRED };
  if (g.uses_left <= 0) return { ok: false, reason: "spent", message: EXPIRED };
  return { ok: true, grant: g };
}

export function issueGrant(s: Store, u: StaffRecord, sid: string, method: MockGrant["method"], now = Date.now()): MockGrant {
  s.stepUp = s.stepUp.filter((g) => g.expires_at > now - 60_000); // expired grants are purged like platform-core's retention job
  const g: MockGrant = { id: crypto.randomUUID(), token: `sut_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`, staff_id: u.id, session_id: sid, method, uses_left: maxUses(), expires_at: now + minutes() * 60_000 };
  s.stepUp.push(g);
  return g;
}

export const grantOut = (g: MockGrant, now = Date.now()) => ({ step_up_token: g.token, header: "X-Step-Up-Token", expires_in: Math.max(0, Math.round((g.expires_at - now) / 1000)), expires_at: new Date(g.expires_at).toISOString(), uses: g.uses_left, method: g.method });

/** The code check of POST /auth/step-up. Returns the method on success. TOTP is single use (a step already used is refused). */
export function checkCode(s: Store, u: StaffRecord, code: string, norm: (c: string) => string, now = Date.now()): MockGrant["method"] | null {
  const st = s.mfa[u.id];
  if (!st?.confirmed) return null;
  if (/^\d+$/.test(code)) {
    if (st.demo && code === DEMO_STEP_UP_CODE) return "totp";
    const step = verifyTotp(st.secret, code, st.last_step, now);
    if (step === null) return null;
    st.last_step = step;
    return "totp";
  }
  const h = norm(code);
  if (!st.recovery.includes(h) || st.recoveryUsed.includes(h)) return null;
  st.recoveryUsed.push(h);
  return "recovery_code";
}
