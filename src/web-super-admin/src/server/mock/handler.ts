import type * as T from "@/lib/api/types";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { seed, type Store, type StaffRecord } from "./seed";
import * as credit from "./credit";
import { newSecret, verifyTotp } from "./totp";
import { checkCode, checkGrant, grantOut, isProtected, issueGrant } from "./stepup";

/** In-memory stand-in for platform-core (same paths, same envelopes, same permission matrix). Used by HQ_API_MODE=mock. */
export interface UpResponse { status: number; body: unknown; headers?: Record<string, string>; contentType?: string }

const g = globalThis as unknown as { __hqMock?: Store };
const store = (): Store => (g.__hqMock ??= seed());
const failures = new Map<string, number>();
export const resetMock = () => { g.__hqMock = seed(); failures.clear(); };

const err = (status: number, code: string, message: string, headers?: Record<string, string>): UpResponse => ({ status, body: { error: { code, message } }, headers });
const ok = (body: unknown, status = 200): UpResponse => ({ status, body });
const now = () => new Date().toISOString();
const nid = () => crypto.randomUUID();

const ACCESS_TTL = 15 * 60;
const accessToken = (u: StaffRecord, sid: string, mfa: boolean) => `mock-at.${u.id}.${Date.now() + ACCESS_TTL * 1000}.${sid}.${mfa ? 1 : 0}`;
const refreshToken = (u: StaffRecord, sid: string, mfa: boolean) => `mock-rt.${u.id}.${sid}.${mfa ? 1 : 0}`;
const MFA_TTL_MS = 5 * 60_000;
const mfaToken = (u: StaffRecord, purpose: "verify" | "enrol") => `mock-mfa.${purpose}.${u.id}.${Date.now() + MFA_TTL_MS}`;
const mfaRoles = () => new Set((process.env.HQ_MOCK_MFA_REQUIRED_ROLES ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const MFA_MAX_FAILURES = 5;

function issue(u: StaffRecord, sid?: string, mfa = false, ua = "browser") {
  const s = store();
  let sess = sid ? s.sessions.find((x) => x.id === sid) : undefined;
  if (!sess) { sess = { id: nid(), staff_id: u.id, started_at: now(), last_active_at: now(), ip: "127.0.0.1", user_agent: ua, mfa, revoked: false }; s.sessions.push(sess); }
  sess.last_active_at = now();
  return { access_token: accessToken(u, sess.id, mfa), refresh_token: refreshToken(u, sess.id, mfa), token_type: "bearer", expires_in: ACCESS_TTL, must_change_password: u.must_change_password, mfa };
}

export function mockLogin(email: string, password: string): UpResponse {
  const e = (email ?? "").toLowerCase();
  if ((failures.get(e) ?? 0) >= 5) return err(429, "rate_limited", "Too many failed sign-in attempts. Try again later.", { "Retry-After": "900" });
  const u = store().staff.find((s) => s.email === e);
  if (!u || !u.is_active || u.password !== password) { failures.set(e, (failures.get(e) ?? 0) + 1); return err(401, "unauthorized", "Invalid email or password"); }
  failures.delete(e);
  const factor = store().mfa[u.id];
  if (factor?.confirmed && !(factor.demo && !mfaRoles().has(u.role))) return ok({ mfa_required: true, mfa_token: mfaToken(u, "verify"), expires_in: MFA_TTL_MS / 1000 });
  if (mfaRoles().has(u.role)) return ok({ mfa_enrolment_required: true, mfa_token: mfaToken(u, "enrol"), expires_in: MFA_TTL_MS / 1000 });
  u.last_login_at = now();
  return ok(issue(u));
}
export function mockRefresh(rt: string): UpResponse {
  const m = /^mock-rt\.([^.]+)(?:\.([^.]+)\.([01]))?$/.exec(rt);
  const u = m && store().staff.find((s) => s.id === m[1]);
  if (!u || !u.is_active) return err(401, "unauthorized", "Invalid refresh token");
  if (m![2] && store().sessions.find((x) => x.id === m![2])?.revoked !== false) return err(401, "unauthorized", "Invalid refresh token");
  if (mfaRoles().has(u.role) && m![3] !== "1") return err(401, "unauthorized", "Multi-factor authentication required");
  return ok(issue(u, m![2], m![3] === "1"));
}

function principal(bearer: string | null): (StaffRecord & { sid?: string; mfa?: boolean }) | null {
  const m = bearer && /^mock-at\.([^.]+)\.(\d+)(?:\.([^.]+)\.([01]))?$/.exec(bearer);
  if (!m || Number(m[2]) < Date.now()) return null;
  const u = store().staff.find((s) => s.id === m[1]);
  if (!u || !u.is_active) return null;
  if (m[3] && store().sessions.find((x) => x.id === m[3])?.revoked !== false) return null; // revoked sessions die immediately
  if (mfaRoles().has(u.role) && m[4] !== "1") return null;
  return Object.assign({}, u, { sid: m[3], mfa: m[4] === "1" });
}

function mfaUser(bearer: string | null, purpose: "verify" | "enrol"): StaffRecord | null {
  const m = bearer && /^mock-mfa\.(verify|enrol)\.([^.]+)\.(\d+)$/.exec(bearer);
  if (!m || m[1] !== purpose || Number(m[3]) < Date.now()) return null;
  const u = store().staff.find((s) => s.id === m[2]);
  return u && u.is_active ? u : null;
}
const newRecovery = () => Array.from({ length: 10 }, () => Array.from({ length: 3 }, () => Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("")).join("-"));
const normRec = (c: string) => c.toUpperCase().replace(/[-\s]/g, "");

/** Second sign-in step. The BFF calls it with the step-up token from /auth/login in the body. */
export function mockMfaVerify(body: Record<string, unknown>): UpResponse {
  const u = mfaUser(str(body.mfa_token), "verify"); const st = u && store().mfa[u.id];
  if (!u || !st || !st.confirmed) return err(401, "unauthorized", "Invalid or expired MFA step-up token");
  if ((store().mfaFailures[u.id] ?? 0) > MFA_MAX_FAILURES) return err(429, "rate_limited", "Too many failed codes. Try again later.", { "Retry-After": "300" });
  const code = str(body.code), rec = str(body.recovery_code);
  if (!!code === !!rec) return err(400, "bad_request", "Provide either code or recovery_code");
  let good = false, usedRecovery = false;
  if (code) { const step = verifyTotp(st.secret, code, st.last_step); if (step !== null) { st.last_step = step; good = true; } }
  else { const h = normRec(rec); if (st.recovery.includes(h) && !st.recoveryUsed.includes(h)) { st.recoveryUsed.push(h); good = true; usedRecovery = true; } }
  if (!good) { store().mfaFailures[u.id] = (store().mfaFailures[u.id] ?? 0) + 1; return err(401, "unauthorized", "Invalid code"); }
  delete store().mfaFailures[u.id];
  u.last_login_at = now();
  return ok({ ...issue(u, undefined, true), ...(usedRecovery ? { recovery_codes_remaining: st.recovery.length - st.recoveryUsed.length } : {}) });
}

type Ctx = { s: Store; u: StaffRecord & { sid?: string; mfa?: boolean }; q: URLSearchParams; body: Record<string, unknown>; p: string[]; h: Record<string, string> };
type Handler = (c: Ctx) => UpResponse;
const routes: { method: string; re: RegExp; perm: T.Permission | null; h: Handler }[] = [];
const route = (method: string, pattern: string, perm: T.Permission | null, h: Handler) =>
  routes.push({ method, re: new RegExp("^" + pattern.replace(/:[a-z]+/g, "([^/]+)") + "$"), perm, h });

const page = <X,>(items: X[], q: URLSearchParams): T.Page<X> => {
  const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200), offset = Math.max(Number(q.get("offset")) || 0, 0);
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
};
const clean = <X extends object>(o: X, ...drop: string[]) => { const c = { ...o } as Record<string, unknown>; for (const k of drop) delete c[k]; return c; };
const findTenant = (s: Store, ref: string) => s.tenants.find((t) => t.id === ref || t.slug === ref);
const tenantOr404 = (s: Store, ref: string) => findTenant(s, ref);
const NF = (what: string) => err(404, "not_found", `${what} not found`);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const reasonOk = (v: unknown, min = 3) => str(v).trim().length >= min;

function log(c: Ctx, action: string, targetType: string, targetId: string | null, tenant: string | null, before: Record<string, unknown> | null = null, after: Record<string, unknown> | null = null, meta: Record<string, unknown> | null = null) {
  c.s.audit.unshift({ id: ++c.s.seq, at: now(), actor_type: "staff", actor_id: c.u.id, actor_label: c.u.email, action, target_type: targetType, target_id: targetId, tenant_id: tenant, ip: "127.0.0.1", before, after, meta });
}

function liveSub(s: Store, tenantId: string) { return s.subs.find((x) => x.tenant_id === tenantId && ["trialing", "active", "past_due"].includes(x.status)); }
function compute(s: Store, t: Store["tenants"][number]): Omit<T.Entitlements, "version" | "generated_at"> {
  const sub = liveSub(s, t.id); const plan = sub && s.plans.find((p) => p.id === sub.plan_id);
  const entitled = !!sub; const why = sub ? sub.status : "no_subscription";
  const ovr = new Map(s.overrides.filter((o) => o.tenant_id === t.id && (!o.expires_at || o.expires_at > now())).map((o) => [o.feature_code, o]));
  const features: Record<string, T.EntitlementValue> = {};
  for (const f of s.features.filter((x) => x.is_active)) {
    const row = plan?.features.find((x) => x.feature_code === f.code); const o = ovr.get(f.code);
    if (t.status !== "active") features[f.code] = { enabled: false, limit: null, source: `tenant_${t.status}` };
    else if (o) features[f.code] = { enabled: o.enabled, limit: o.enabled ? o.limit_value : null, source: "override" };
    else if (entitled && row?.enabled) features[f.code] = { enabled: true, limit: row.limit_value, source: "plan" };
    else features[f.code] = { enabled: false, limit: null, source: entitled ? "plan" : why };
  }
  return { tenant_id: t.id, tenant_status: t.status, business_types: t.business_types ?? ["restaurant"], plan_code: plan?.code ?? null, subscription_status: sub?.status ?? null, subscription_reason: why, features };
}
function recordDiff(c: Ctx, t: Store["tenants"][number], before: ReturnType<typeof compute>, trigger: string, reason: string | null) {
  const after = compute(c.s, t);
  for (const code of Object.keys(after.features)) {
    const b = before.features[code], a = after.features[code];
    if (JSON.stringify(b) !== JSON.stringify(a)) c.s.entHistory.unshift({ id: ++c.s.seq, tenant_id: t.id, feature_code: code, before: b ?? null, after: a, trigger, actor: c.u.email, reason, created_at: now() });
  }
}

// ---- auth / staff
route("GET", "/auth/me", null, (c) => ok({ ...clean(c.u, "password", "sid", "mfa"), permissions: [...ROLE_PERMISSIONS[c.u.role]].sort() }));
route("POST", "/auth/change-password", null, (c) => {
  if (c.u.password !== c.body.current_password) return err(400, "bad_password", "Current password is incorrect");
  const np = str(c.body.new_password);
  if (np.length < 10 || np.toLowerCase() === np || !/\d/.test(np)) return err(400, "weak_password", "Password must be at least 10 characters with upper-case, lower-case and a digit");
  c.u.password = np; c.u.must_change_password = false; return ok({ ok: true });
});
route("GET", "/roles", "staff.read", () => ok(Object.fromEntries(Object.entries(ROLE_PERMISSIONS).map(([r, p]) => [r, [...p].sort()]))));
route("GET", "/staff", "staff.read", (c) => ok(page(c.s.staff.map((x) => clean(x, "password")), c.q)));
route("POST", "/staff", "staff.manage", (c) => {
  const email = str(c.body.email).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return err(422, "validation_error", "Invalid request");
  if (!(c.body.role as string in ROLE_PERMISSIONS)) return err(400, "bad_role", "Unknown role");
  if (c.s.staff.some((x) => x.email === email)) return err(409, "conflict", "Email already registered");
  const pw = str(c.body.password);
  if (pw.length < 10 || pw.toLowerCase() === pw || !/\d/.test(pw)) return err(400, "weak_password", "Password must be at least 10 characters with upper-case, lower-case and a digit");
  const u: StaffRecord = { id: nid(), email, name: str(c.body.name), role: c.body.role as T.Role, is_active: true, must_change_password: true, last_login_at: null, created_at: now(), password: pw };
  c.s.staff.push(u); log(c, "staff.created", "staff_user", u.id, null, null, { email, role: u.role });
  return ok(clean(u, "password"), 201);
});
route("PATCH", "/staff/:id", "staff.manage", (c) => {
  const u = c.s.staff.find((x) => x.id === c.p[0]); if (!u) return NF("Staff user");
  const demoting = (c.body.role && c.body.role !== "super_admin") || c.body.is_active === false;
  if (demoting && u.role === "super_admin" && u.is_active && c.s.staff.filter((x) => x.role === "super_admin" && x.is_active).length <= 1) return err(409, "last_super_admin", "Cannot remove or demote the last active super_admin");
  const before = { role: u.role, is_active: u.is_active };
  if (typeof c.body.name === "string") u.name = c.body.name;
  if (typeof c.body.role === "string") { if (!(c.body.role in ROLE_PERMISSIONS)) return err(400, "bad_role", "Unknown role"); u.role = c.body.role as T.Role; }
  if (typeof c.body.is_active === "boolean") u.is_active = c.body.is_active;
  log(c, "staff.updated", "staff_user", u.id, null, before, { role: u.role, is_active: u.is_active });
  return ok(clean(u, "password"));
});
route("POST", "/staff/:id/reset-password", "staff.manage", (c) => {
  const u = c.s.staff.find((x) => x.id === c.p[0]); if (!u) return NF("Staff user");
  const pw = str(c.body.new_password);
  if (pw.length < 10 || pw.toLowerCase() === pw || !/\d/.test(pw)) return err(400, "weak_password", "Password must be at least 10 characters with upper-case, lower-case and a digit");
  u.password = pw; u.must_change_password = true; log(c, "staff.password_reset", "staff_user", u.id, null); return ok({ ok: true });
});

// ---- MFA (TOTP) and sessions
const mfaStatus = (c: Ctx) => { const st = c.s.mfa[c.u.id]; return { enrolled: !!st?.confirmed, enrolled_at: st?.confirmed ? now() : null, required: mfaRoles().has(c.u.role), recovery_codes_remaining: st?.confirmed ? st.recovery.length - st.recoveryUsed.length : 0 }; };
route("GET", "/auth/mfa/status", null, (c) => ok(mfaStatus(c)));
const enrolStart = (u: StaffRecord, s: Store): UpResponse => {
  if (s.mfa[u.id]?.confirmed) return err(409, "mfa_already_enrolled", "MFA is already enrolled; disable it first");
  const secret = newSecret(); s.mfa[u.id] = { secret, confirmed: false, last_step: null, recovery: [], recoveryUsed: [] };
  // No QR in mock mode: the UI falls back to the secret / otpauth link (platform-core returns an inline SVG).
  return ok({ secret, otpauth_uri: `otpauth://totp/Chilli%20HQ:${encodeURIComponent(u.email)}?secret=${secret}&issuer=Chilli%20HQ&algorithm=SHA1&digits=6&period=30`, qr_svg: null, issuer: "Chilli HQ", account: u.email });
};
const enrolConfirm = (u: StaffRecord, s: Store, code: string): UpResponse => {
  const st = s.mfa[u.id]; if (!st || st.confirmed) return err(409, "mfa_no_pending_enrolment", "No pending enrolment; start one first");
  const step = verifyTotp(st.secret, code, st.last_step); if (step === null) return err(400, "invalid_code", "Invalid code");
  st.confirmed = true; st.last_step = step; const codes = newRecovery(); st.recovery = codes.map(normRec); st.recoveryUsed = [];
  return ok({ ok: true, recovery_codes: codes });
};
/** Fresh code for one protected action (platform-core POST /auth/step-up, STEP_UP.md). Same per-staff throttle as sign-in codes. */
route("POST", "/auth/step-up", null, (c) => {
  const st = c.s.mfa[c.u.id];
  const code = str(c.body.code).trim();
  if (code.length < 6 || code.length > 40) return err(422, "validation_error", "Invalid request");
  if (!st?.confirmed) return err(409, "mfa_not_enrolled", "Two-step is not set up for your account");
  if (!c.u.sid) return err(401, "unauthorized", "Session required");
  if ((c.s.mfaFailures[c.u.id] ?? 0) > MFA_MAX_FAILURES) return err(429, "rate_limited", "Too many failed codes. Try again later.", { "Retry-After": "300" });
  const method = checkCode(c.s, c.u, code.replace(/\s/g, ""), normRec);
  if (!method) {
    c.s.mfaFailures[c.u.id] = (c.s.mfaFailures[c.u.id] ?? 0) + 1;
    log(c, "step_up.denied", "staff_user", c.u.id, null, null, null, { reason: "bad_code" });
    return err(400, "invalid_code", "Invalid code");
  }
  delete c.s.mfaFailures[c.u.id];
  const g = issueGrant(c.s, c.u, c.u.sid, method);
  log(c, "step_up.granted", "staff_user", c.u.id, null, null, null, { grant_id: g.id, method, uses: g.uses_left });
  return ok({ ...grantOut(g), ...(method === "recovery_code" ? { recovery_codes_remaining: st.recovery.length - st.recoveryUsed.length } : {}) });
});
route("POST", "/auth/mfa/enrol/start", null, (c) => enrolStart(c.u, c.s));
route("POST", "/auth/mfa/enrol/confirm", null, (c) => enrolConfirm(c.u, c.s, str(c.body.code)));
const reauth = (c: Ctx): UpResponse | null => {
  const st = c.s.mfa[c.u.id]; if (!st?.confirmed) return err(409, "mfa_not_enrolled", "MFA is not enrolled");
  if (c.u.password !== c.body.password) return err(400, "bad_credentials", "Password or code is incorrect");
  const step = verifyTotp(st.secret, str(c.body.code), st.last_step); if (step === null) return err(400, "bad_credentials", "Password or code is incorrect");
  st.last_step = step; return null;
};
route("POST", "/auth/mfa/recovery-codes", null, (c) => { const bad = reauth(c); if (bad) return bad; const codes = newRecovery(); const st = c.s.mfa[c.u.id]; st.recovery = codes.map(normRec); st.recoveryUsed = []; log(c, "mfa.recovery_codes_regenerated", "staff_user", c.u.id, null); return ok({ recovery_codes: codes }); });
route("POST", "/auth/mfa/disable", null, (c) => {
  if (mfaRoles().has(c.u.role)) return err(403, "forbidden", "MFA is mandatory for your role");
  const bad = reauth(c); if (bad) return bad; delete c.s.mfa[c.u.id]; log(c, "mfa.disabled", "staff_user", c.u.id, null); return ok({ ok: true });
});
route("POST", "/staff/:id/mfa/reset", "staff.manage", (c) => {
  const u = c.s.staff.find((x) => x.id === c.p[0]); if (!u) return NF("Staff user");
  if (u.id === c.u.id) return err(400, "use_disable", "Use /auth/mfa/disable for your own account");
  delete c.s.mfa[u.id]; for (const x of c.s.sessions) if (x.staff_id === u.id) x.revoked = true; log(c, "mfa.reset", "staff_user", u.id, null); return ok({ ok: true });
});
route("GET", "/auth/sessions", null, (c) => ok({ items: c.s.sessions.filter((x) => x.staff_id === c.u.id && !x.revoked).sort((a, b) => b.last_active_at.localeCompare(a.last_active_at)).map((x) => ({ id: x.id, started_at: x.started_at, last_active_at: x.last_active_at, ip: x.ip, user_agent: x.user_agent, mfa: x.mfa, current: x.id === c.u.sid })) }));
route("DELETE", "/auth/sessions/:id", null, (c) => {
  const x = c.s.sessions.find((y) => y.id === c.p[0] && y.staff_id === c.u.id && !y.revoked); if (!x) return NF("Session");
  x.revoked = true; log(c, "session.revoked", "session", x.id, null, null, null, { current: x.id === c.u.sid }); return ok({ ok: true });
});
route("POST", "/auth/sessions/revoke-others", null, (c) => { let n = 0; for (const x of c.s.sessions) if (x.staff_id === c.u.id && !x.revoked && x.id !== c.u.sid) { x.revoked = true; n++; } log(c, "session.revoked_others", "staff_user", c.u.id, null, null, null, { count: n }); return ok({ ok: true, revoked: n }); });
route("DELETE", "/staff/:id/sessions", "staff.manage", (c) => {
  const u = c.s.staff.find((x) => x.id === c.p[0]); if (!u) return NF("Staff user");
  let n = 0; for (const x of c.s.sessions) if (x.staff_id === u.id && !x.revoked) { x.revoked = true; n++; } log(c, "session.revoked_all", "staff_user", u.id, null, null, null, { count: n }); return ok({ ok: true, revoked: n });
});

// ---- tenants
route("GET", "/tenants", "tenants.read", (c) => {
  const st = c.q.get("status"), q = c.q.get("q")?.toLowerCase();
  const rows = c.s.tenants.filter((t) => (!st || t.status === st) && (!q || t.display_name.toLowerCase().includes(q) || t.slug.includes(q))).map((t) => clean(t, "profile", "outlets"));
  return ok(page(rows, c.q));
});
route("GET", "/tenants/:ref", "tenants.read", (c) => { const t = tenantOr404(c.s, c.p[0]); return t ? ok(t) : NF("Tenant"); });
const statusRoute = (verb: string, to: T.TenantStatus, from: T.TenantStatus[]) =>
  route("POST", `/tenants/:ref/${verb}`, "tenants.suspend", (c) => {
    const t = tenantOr404(c.s, c.p[0]); if (!t) return NF("Tenant");
    if (!reasonOk(c.body.reason)) return err(422, "validation_error", "Invalid request");
    if (!from.includes(t.status)) return err(409, "bad_transition", `Cannot move tenant from ${t.status} to ${to}`);
    const before = compute(c.s, t), was = t.status;
    t.status = to; t.status_reason = str(c.body.reason); t.status_changed_at = now();
    if (to === "closed") { const sub = liveSub(c.s, t.id); if (sub) { sub.status = "cancelled"; sub.ended_at = now(); } }
    recordDiff(c, t, before, `tenant_${to}`, t.status_reason);
    log(c, `tenant.${to === "active" ? "reactivated" : to}`, "tenant", t.id, t.id, { status: was }, { status: to }, { reason: t.status_reason });
    return ok(t);
  });
statusRoute("suspend", "suspended", ["active"]); statusRoute("reactivate", "active", ["suspended"]); statusRoute("close", "closed", ["active", "suspended", "pending"]);

route("GET", "/tenants/:ref/subscription", "subscriptions.read", (c) => {
  const t = tenantOr404(c.s, c.p[0]); if (!t) return NF("Tenant");
  return ok({ current: liveSub(c.s, t.id) ?? null, history: c.s.subs.filter((x) => x.tenant_id === t.id) });
});
route("POST", "/tenants/:ref/subscription", "subscriptions.manage", (c) => {
  const t = tenantOr404(c.s, c.p[0]); if (!t) return NF("Tenant");
  const plan = c.s.plans.find((p) => p.code === c.body.plan_code); if (!plan) return NF("Plan");
  if (!plan.is_active) return err(409, "plan_inactive", `Plan ${plan.code} is not active`);
  const before = compute(c.s, t); const prev = liveSub(c.s, t.id);
  if (prev) { prev.status = "cancelled"; prev.ended_at = now(); }
  const trial = Number(c.body.trial_days) || 0;
  const sub: T.Subscription = { id: nid(), tenant_id: t.id, plan_id: plan.id, status: trial ? "trialing" : "active", trial_end: trial ? new Date(Date.now() + trial * 864e5).toISOString() : null, current_period_start: now(), current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false, ended_at: null, created_at: now() };
  c.s.subs.unshift(sub); recordDiff(c, t, before, "plan_changed", str(c.body.reason) || null); log(c, "subscription.assigned", "subscription", sub.id, t.id);
  return ok(sub, 201);
});
route("POST", "/tenants/:ref/subscription/cancel", "subscriptions.manage", (c) => {
  const t = tenantOr404(c.s, c.p[0]); if (!t) return NF("Tenant");
  const sub = liveSub(c.s, t.id); if (!sub) return err(409, "no_subscription", "No live subscription");
  if (c.body.at_period_end === false) { sub.status = "cancelled"; sub.ended_at = now(); } else sub.cancel_at_period_end = true;
  log(c, "subscription.cancelled", "subscription", sub.id, t.id); return ok(sub);
});

// ---- onboarding
route("GET", "/onboarding/applications", "onboarding.read", (c) => {
  const st = c.q.get("status"), src = c.q.get("source");
  return ok(page(c.s.onboarding.filter((a) => (!st || a.status === st) && (!src || a.source === src)).map((a) => clean(a, "events", "payload")), c.q));
});
route("GET", "/onboarding/applications/:id", "onboarding.read", (c) => { const a = c.s.onboarding.find((x) => x.id === c.p[0]); return a ? ok(a) : NF("Application"); });
const FLOW: Record<string, [T.OnboardingStatus[], T.OnboardingStatus]> = { review: [["received"], "under_review"], approve: [["received", "under_review"], "approved"], reject: [["received", "under_review", "approved", "failed"], "rejected"], provision: [["approved", "failed"], "provisioned"] };
for (const verb of Object.keys(FLOW)) route("POST", `/onboarding/applications/:id/${verb}`, "onboarding.manage", (c) => {
  const a = c.s.onboarding.find((x) => x.id === c.p[0]); if (!a) return NF("Application");
  const [from, to] = FLOW[verb];
  if (!from.includes(a.status)) return err(409, "bad_transition", `Cannot move application from ${a.status} to ${to}`);
  if (verb === "reject") { if (!reasonOk(c.body.reason)) return err(422, "validation_error", "Invalid request"); a.reject_reason = str(c.body.reason); }
  const prev = a.status; a.status = to; a.updated_at = now(); a.last_error = null;
  if (verb === "provision") a.attempts += 1;
  a.events.push({ id: ++c.s.seq, application_id: a.id, from_status: prev, to_status: to, actor: c.u.email, note: str(c.body.note) || str(c.body.reason) || null, created_at: now() });
  log(c, `onboarding.${to}`, "onboarding_application", a.id, null); return ok(clean(a, "events"));
});

// ---- catalog / entitlements
route("GET", "/features", "catalog.read", (c) => ok({ items: c.s.features }));
const planOut = (s: Store, p: T.Plan) => ({ ...p, live_subscriptions: s.subs.filter((x) => x.plan_id === p.id && ["trialing", "active", "past_due"].includes(x.status)).length });
route("GET", "/plans", "catalog.read", (c) => ok({ items: [...c.s.plans].sort((a, b) => a.price_paise - b.price_paise).map((p) => planOut(c.s, p)) }));
route("GET", "/plans/:code/versions", "catalog.read", (c) => { const v = c.s.planVersions[c.p[0]]; return v ? ok({ items: [...v].reverse() }) : NF("Plan"); });
const snap = (p: T.Plan) => ({ name: p.name, description: p.description, price_paise: p.price_paise, billing_period: p.billing_period, features: p.features.map((f) => ({ ...f })) });
const bump = (c: Ctx, p: T.Plan, change: T.PlanVersion["change"], note: string | null) => { p.version += 1; (c.s.planVersions[p.code] ??= []).push({ version: p.version, change, note, actor: c.u.email, at: now(), snapshot: snap(p) }); };
const featuresOk = (s: Store, fs: unknown) => Array.isArray(fs) && fs.every((f) => f && typeof f.feature_code === "string" && s.features.some((x) => x.code === f.feature_code));
route("POST", "/plans", "catalog.manage", (c) => {
  const code = str(c.body.code);
  if (!/^[a-z][a-z0-9_.]{1,63}$/.test(code) || !str(c.body.name) || !(Number(c.body.price_paise) >= 0) || !["month", "year"].includes(str(c.body.billing_period) || "month")) return err(422, "validation_error", "Invalid request");
  if (c.s.plans.some((p) => p.code === code)) return err(409, "conflict", "Plan code exists");
  const fs = (c.body.features ?? []) as T.PlanFeature[]; if (!featuresOk(c.s, fs)) return err(400, "unknown_feature", "Unknown feature");
  const p: T.Plan = { id: nid(), code, name: str(c.body.name), description: typeof c.body.description === "string" ? c.body.description : null, price_paise: Number(c.body.price_paise), billing_period: (str(c.body.billing_period) || "month") as "month" | "year", is_active: true, features: fs.map((f) => ({ feature_code: f.feature_code, enabled: f.enabled !== false, limit_value: f.limit_value ?? null })), version: 1, retired_at: null };
  c.s.plans.push(p); c.s.planVersions[code] = [{ version: 1, change: "created", note: null, actor: c.u.email, at: now(), snapshot: snap(p) }]; log(c, "plan.created", "plan", p.id, null, null, { code }); return ok(planOut(c.s, p), 201);
});
route("PUT", "/plans/:code", "catalog.manage", (c) => {
  const p = c.s.plans.find((x) => x.code === c.p[0]); if (!p) return NF("Plan");
  if (!str(c.body.name) || !(Number(c.body.price_paise) >= 0) || !Array.isArray(c.body.features)) return err(422, "validation_error", "Invalid request");
  if (p.version !== c.body.expected_version) return err(409, "version_conflict", `Plan is at version ${p.version}; reload and retry`);
  if (!featuresOk(c.s, c.body.features)) return err(400, "unknown_feature", "Unknown feature");
  const before = snap(p), tenants = c.s.tenants.filter((t) => c.s.subs.some((x) => x.tenant_id === t.id && x.plan_id === p.id && ["trialing", "active", "past_due"].includes(x.status)));
  const befores = tenants.map((t) => compute(c.s, t));
  p.name = str(c.body.name); p.description = typeof c.body.description === "string" ? c.body.description : null; p.price_paise = Number(c.body.price_paise);
  p.features = (c.body.features as T.PlanFeature[]).map((f) => ({ feature_code: f.feature_code, enabled: f.enabled !== false, limit_value: f.limit_value ?? null }));
  tenants.forEach((t, i) => recordDiff(c, t, befores[i], "plan_edited", `plan ${p.code}`));
  bump(c, p, "edited", str(c.body.note) || null); log(c, "plan.edited", "plan", p.id, null, before, snap(p), { version: p.version, tenants_affected: tenants.length }); return ok(planOut(c.s, p));
});
route("POST", "/plans/:code/retire", "catalog.manage", (c) => {
  const p = c.s.plans.find((x) => x.code === c.p[0]); if (!p) return NF("Plan");
  if (!reasonOk(c.body.reason)) return err(422, "validation_error", "Invalid request");
  if (!p.is_active) return err(409, "plan_retired", "Plan is already retired");
  if (p.code === "starter") return err(409, "plan_is_default", "This is the default trial plan for new signups; change DEFAULT_TRIAL_PLAN_CODE first");
  p.is_active = false; p.retired_at = now(); bump(c, p, "retired", str(c.body.reason)); log(c, "plan.retired", "plan", p.id, null, null, null, { reason: str(c.body.reason) }); return ok(planOut(c.s, p));
});
route("POST", "/plans/:code/reactivate", "catalog.manage", (c) => {
  const p = c.s.plans.find((x) => x.code === c.p[0]); if (!p) return NF("Plan");
  if (!reasonOk(c.body.reason)) return err(422, "validation_error", "Invalid request");
  if (p.is_active) return err(409, "plan_active", "Plan is already active");
  p.is_active = true; p.retired_at = null; bump(c, p, "reactivated", str(c.body.reason)); log(c, "plan.reactivated", "plan", p.id, null, null, null, { reason: str(c.body.reason) }); return ok(planOut(c.s, p));
});
route("GET", "/subscriptions", "subscriptions.read", (c) => { const st = c.q.get("status"); return ok({ items: c.s.subs.filter((x) => !st || x.status === st) }); });
route("GET", "/entitlements/:ref", "entitlements.read", (c) => {
  const t = tenantOr404(c.s, c.p[0]); if (!t) return NF("Tenant");
  const snap = compute(c.s, t); return ok({ ...snap, version: Math.abs([...JSON.stringify(snap.features)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)).toString(16), generated_at: now() });
});
route("GET", "/entitlements/:ref/history", "entitlements.read", (c) => { const t = tenantOr404(c.s, c.p[0]); return t ? ok({ items: c.s.entHistory.filter((h) => h.tenant_id === t.id) }) : NF("Tenant"); });
route("PUT", "/entitlements/:ref/overrides/:feature", "entitlements.override", (c) => {
  const t = tenantOr404(c.s, c.p[0]); if (!t) return NF("Tenant");
  if (!c.s.features.some((f) => f.code === c.p[1])) return NF("Feature");
  if (!reasonOk(c.body.reason)) return err(422, "validation_error", "Invalid request");
  const exp = c.body.expires_at ? String(c.body.expires_at) : null;
  if (exp && (Number.isNaN(Date.parse(exp)) || Date.parse(exp) <= Date.now())) return err(400, "bad_request", "expires_at must be in the future");
  const before = compute(c.s, t);
  c.s.overrides = c.s.overrides.filter((o) => !(o.tenant_id === t.id && o.feature_code === c.p[1]));
  const o: T.EntitlementOverride = { tenant_id: t.id, feature_code: c.p[1], enabled: !!c.body.enabled, limit_value: typeof c.body.limit_value === "number" ? c.body.limit_value : null, reason: str(c.body.reason), expires_at: exp, created_by: c.u.email };
  c.s.overrides.push(o); recordDiff(c, t, before, "override_set", o.reason); log(c, "entitlement.override_set", "tenant", t.id, t.id, null, null, { feature: c.p[1] }); return ok(o);
});
route("DELETE", "/entitlements/:ref/overrides/:feature", "entitlements.override", (c) => {
  const t = tenantOr404(c.s, c.p[0]); if (!t) return NF("Tenant");
  if (!c.s.overrides.some((o) => o.tenant_id === t.id && o.feature_code === c.p[1])) return NF("Override");
  const before = compute(c.s, t); c.s.overrides = c.s.overrides.filter((o) => !(o.tenant_id === t.id && o.feature_code === c.p[1]));
  recordDiff(c, t, before, "override_removed", null); log(c, "entitlement.override_removed", "tenant", t.id, t.id, null, null, { feature: c.p[1] }); return ok({ ok: true });
});

// ---- billing
const invView = (i: Store["invoices"][number]) => ({ ...i, tax_notice: i.tax_needs_ca_verification ? "GST rate/SAC/numbering come from configuration and must be verified by a Chartered Accountant." : null });
route("GET", "/invoices", "invoices.read", (c) => {
  const st = c.q.get("status"), tn = c.q.get("tenant"); const t = tn ? findTenant(c.s, tn) : null;
  return ok(page(c.s.invoices.filter((i) => (!st || i.status === st) && (!tn || i.tenant_id === t?.id)).map((i) => clean(i, "lines")), c.q));
});
route("GET", "/invoices/:id", "invoices.read", (c) => { const i = c.s.invoices.find((x) => x.id === c.p[0]); return i ? ok(invView(i)) : NF("Invoice"); });
route("POST", "/invoices/:id/issue", "invoices.manage", (c) => {
  const i = c.s.invoices.find((x) => x.id === c.p[0]); if (!i) return NF("Invoice");
  if (i.status !== "draft") return err(409, "bad_transition", `Invoice is ${i.status}`);
  i.number = `CH-2026-${String(c.s.invoices.filter((x) => x.number).length + 1).padStart(6, "0")}`; i.status = "issued"; i.issued_at = now(); i.due_at = new Date(Date.now() + 15 * 864e5).toISOString();
  log(c, "invoice.issued", "invoice", i.id, i.tenant_id); return ok(invView(i));
});
route("POST", "/invoices/:id/void", "invoices.manage", (c) => {
  const i = c.s.invoices.find((x) => x.id === c.p[0]); if (!i) return NF("Invoice");
  if (!reasonOk(c.body.reason)) return err(422, "validation_error", "Invalid request");
  if (i.status !== "draft" && i.status !== "issued") return err(409, "bad_transition", `Cannot void a ${i.status} invoice`);
  i.status = "void"; i.void_reason = str(c.body.reason); log(c, "invoice.voided", "invoice", i.id, i.tenant_id); return ok(invView(i));
});
route("GET", "/payments", "payments.read", (c) => { const tn = c.q.get("tenant"), t = tn ? findTenant(c.s, tn) : null; return ok(page(c.s.payments.filter((p) => !tn || p.tenant_id === t?.id), c.q)); });

// ---- analytics and marketing views
const monthly = (p: T.Plan) => (p.billing_period === "year" ? Math.floor(p.price_paise / 12) : p.price_paise);
const csvCell = (v: unknown) => { if (v === null || v === undefined) return ""; if (typeof v === "number" || typeof v === "boolean") return String(v); const t = String(v), f = t.trimStart()[0]; const s = /^[\t\r\n]/.test(t) || (f && "=+-@".includes(f)) ? `'${t}` : t; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const overview = (c: Ctx): T.Overview => {
  const s = c.s, sinceQ = c.q.get("since"), untilQ = c.q.get("until");
  const until = untilQ ? Date.parse(untilQ) + 864e5 : Date.now() + 1000, since = sinceQ ? Date.parse(sinceQ) : until - 90 * 864e5;
  const paying = s.subs.filter((x) => ["active", "past_due"].includes(x.status));
  const byPlan = s.plans.map((p) => { const n = paying.filter((x) => x.plan_id === p.id).length; return { plan_code: p.code, plan_name: p.name, subscriptions: n, mrr_paise: n * monthly(p) }; }).filter((x) => x.subscriptions > 0);
  const mrr = byPlan.reduce((a, x) => a + x.mrr_paise, 0);
  const apps = s.onboarding.filter((a) => Date.parse(a.created_at) >= since && Date.parse(a.created_at) < until);
  const by_source = { self_signup: 0, marketing: 0, staff: 0 } as Record<T.OnboardingSource, number>; const months = new Map<string, Record<T.OnboardingSource, number>>();
  for (const a of apps.sort((x, y) => x.created_at.localeCompare(y.created_at))) { by_source[a.source]++; const m = a.created_at.slice(0, 7); const r = months.get(m) ?? { self_signup: 0, marketing: 0, staff: 0 }; r[a.source]++; months.set(m, r); }
  const live = (id: string) => s.subs.some((x) => x.tenant_id === id && ["trialing", "active", "past_due"].includes(x.status));
  const opening = new Set(s.subs.filter((x) => Date.parse(x.created_at) < since && (!x.ended_at || Date.parse(x.ended_at) >= since)).map((x) => x.tenant_id));
  const churned = [...opening].filter((id) => !live(id) && s.subs.some((x) => x.tenant_id === id && ["cancelled", "expired"].includes(x.status) && x.ended_at && Date.parse(x.ended_at) >= since && Date.parse(x.ended_at) < until)).length;
  const status: Record<string, number> = {}; for (const t of s.tenants) status[t.status] = (status[t.status] ?? 0) + 1;
  return { as_of: now(), window: { since: new Date(since).toISOString().slice(0, 10), until: untilQ ?? null }, mrr_paise: mrr, arr_paise: mrr * 12, mrr_by_plan: byPlan, paying_subscriptions: paying.length,
    active_tenants: s.tenants.filter((t) => t.status === "active" && live(t.id)).length, trialing_tenants: new Set(s.subs.filter((x) => x.status === "trialing").map((x) => x.tenant_id)).size, tenants_by_status: status,
    churn: { opening_tenants: opening.size, churned_tenants: churned, rate_bps: opening.size ? Math.floor((churned * 10000) / opening.size) : 0 },
    signups: { total: apps.length, by_source, by_month: [...months].map(([month, r]) => ({ month, ...r })) },
    notes: { mrr: "active + past_due subscriptions, excl. GST; yearly plans / 12 (truncated); trials excluded", churn: "opening-cohort tenants with an ended subscription in the window and none live now" } };
};
route("GET", "/analytics/overview", "analytics.read", (c) => ok(overview(c)));
route("GET", "/analytics/export", "analytics.export", (c) => {
  const rep = c.q.get("report") ?? ""; const o = overview(c); let head: string[], rows: unknown[][];
  if (rep === "mrr_by_plan") { head = ["plan_code", "plan_name", "subscriptions", "mrr_paise"]; rows = o.mrr_by_plan.map((x) => [x.plan_code, x.plan_name, x.subscriptions, x.mrr_paise]); }
  else if (rep === "signups") { head = ["month", "self_signup", "marketing", "staff", "total"]; rows = o.signups.by_month.map((m) => [m.month, m.self_signup, m.marketing, m.staff, m.self_signup + m.marketing + m.staff]); }
  else if (rep === "subscriptions") { head = ["tenant_slug", "tenant_name", "plan_code", "status", "price_paise"]; rows = c.s.subs.filter((x) => ["trialing", "active", "past_due"].includes(x.status)).map((x) => { const t = c.s.tenants.find((y) => y.id === x.tenant_id)!, p = c.s.plans.find((y) => y.id === x.plan_id)!; return [t.slug, t.display_name, p.code, x.status, p.price_paise]; }); }
  else if (rep === "tenants") { head = ["slug", "name", "status", "created_at"]; rows = c.s.tenants.map((t) => [t.slug, t.display_name, t.status, t.created_at]); }
  else return err(400, "bad_report", "report must be one of mrr_by_plan, signups, subscriptions, tenants");
  log(c, "analytics.exported", "report", rep, null, null, null, { report: rep, rows: rows.length });
  return { status: 200, body: [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n", contentType: "text/csv; charset=utf-8" };
});
route("GET", "/marketing/team", "marketing.read", (c) => ok({ items: c.s.marketing.members, total: c.s.marketing.members.length, limit: 50, offset: 0 }));
route("GET", "/marketing/referrals", "marketing.read", (c) => ok({ items: c.s.marketing.referrals, total: c.s.marketing.referrals.length, limit: 50, offset: 0 }));
route("GET", "/marketing/commissions", "marketing.read", (c) => {
  const st = c.q.get("status"); const items = c.s.marketing.entries.filter((e) => !st || e.status === st);
  const add = (b: T.Balances, e: T.CommissionEntry) => { if (["pending", "approved", "paid"].includes(e.status)) { const r = (b[e.currency] ??= { pending_minor: 0, approved_minor: 0, paid_minor: 0 }); r[`${e.status}_minor` as "paid_minor"] += e.amount_minor; } };
  const balances: T.Balances = {}; const per = new Map<string, T.Balances>(); for (const e of items) { add(balances, e); add(per.get(e.user_id) ?? per.set(e.user_id, {}).get(e.user_id)!, e); }
  return ok({ items, total: items.length, balances, by_user: [...per].map(([user_id, b]) => ({ user_id, user_name: c.s.marketing.members.find((m) => m.id === user_id)?.name ?? null, balances: b })), rules: c.s.marketing.rules });
});

// ---- PAYG credit wallet (platform-core /admin/tenants/{t}/wallet..., billing-settings, usage)
const creditCtx = (c: Ctx): credit.CreditCtx | null => {
  const t = tenantOr404(c.s, c.p[0]); if (!t) return null;
  return { c: c.s.credit, t, planId: liveSub(c.s, t.id)?.plan_id ?? null, actor: c.u.email, audit: (action, before, after, meta) => log(c, action, "wallet", t.id, t.id, before, after, meta) };
};
const withCredit = (h: (x: credit.CreditCtx, c: Ctx) => UpResponse | object): Handler => (c) => {
  const x = creditCtx(c); if (!x) return NF("Tenant");
  const r = h(x, c); return "status" in r && "body" in r ? (r as UpResponse) : ok(r);
};
route("GET", "/admin/tenants/:ref/wallet", "wallet.read", withCredit((x) => credit.adminWallet(x)));
route("GET", "/admin/tenants/:ref/wallet/ledger", "wallet.read", withCredit((x, c) => credit.ledgerPage(x, c.q)));
route("POST", "/admin/tenants/:ref/wallet/adjust", "wallet.adjust", withCredit((x, c) => credit.adjust(x, c.body, c.h["idempotency-key"])));
route("POST", "/admin/tenants/:ref/wallet/suspend", "tenants.suspend", withCredit((x, c) => credit.setSuspended(x, true, c.body.reason)));
route("POST", "/admin/tenants/:ref/wallet/resume", "tenants.suspend", withCredit((x, c) => credit.setSuspended(x, false, c.body.reason)));
route("GET", "/admin/tenants/:ref/billing-settings", "wallet.read", withCredit((x) => credit.getSettings(x)));
route("PUT", "/admin/tenants/:ref/billing-settings", "billing_settings.manage", withCredit((x, c) => credit.putSettings(x, c.body)));
route("GET", "/admin/tenants/:ref/usage", "wallet.read", withCredit((x, c) => credit.statement(x, c.q, csvCell)));
route("GET", "/admin/tenants/:ref/receipts", "wallet.read", withCredit((x, c) => credit.receiptsPage(x, c.q)));
route("GET", "/admin/billing/usage", "wallet.read", (c) => {
  const r = credit.allUsage(c.s.credit, c.s.tenants, c.q, csvCell, (t) => ({ c: c.s.credit, t, planId: liveSub(c.s, t.id)?.plan_id ?? null, actor: c.u.email, audit: () => {} }));
  return r;
});

// ---- support
route("GET", "/tickets", "tickets.read", (c) => { const st = c.q.get("status"), tn = c.q.get("tenant"); const t = tn ? findTenant(c.s, tn) : null; return ok(page(c.s.tickets.filter((k) => (!st || k.status === st) && (!tn || k.tenant_id === t?.id)).map((k) => clean(k, "comments")), c.q)); });
route("GET", "/tickets/:id", "tickets.read", (c) => { const k = c.s.tickets.find((x) => x.id === c.p[0]); return k ? ok(k) : NF("Ticket"); });
route("PATCH", "/tickets/:id", "tickets.manage", (c) => {
  const k = c.s.tickets.find((x) => x.id === c.p[0]); if (!k) return NF("Ticket");
  if (typeof c.body.status === "string") k.status = c.body.status as T.TicketStatus; if (typeof c.body.priority === "string") k.priority = c.body.priority as T.TicketPriority;
  if (typeof c.body.assignee_id === "string") k.assignee_id = c.body.assignee_id; k.updated_at = now(); log(c, "ticket.updated", "ticket", k.id, k.tenant_id); return ok(clean(k, "comments"));
});
route("POST", "/tickets/:id/comments", "tickets.manage", (c) => {
  const k = c.s.tickets.find((x) => x.id === c.p[0]); if (!k) return NF("Ticket");
  if (!str(c.body.body).trim()) return err(422, "validation_error", "Invalid request");
  const cm: T.TicketComment = { id: nid(), ticket_id: k.id, author: c.u.email, body: str(c.body.body), internal: c.body.internal !== false, created_at: now() };
  k.comments.push(cm); return ok(cm, 201);
});
route("GET", "/support-access/grants", "support_access.read", (c) => {
  const tn = c.q.get("tenant"), t = tn ? findTenant(c.s, tn) : null, act = c.q.get("active") === "true";
  return ok(page(c.s.grants.filter((x) => (!tn || x.tenant_id === t?.id) && (!act || (!x.revoked_at && x.expires_at > now()))), c.q));
});
route("POST", "/support-access/grants", "support_access.grant", (c) => {
  const t = tenantOr404(c.s, str(c.body.tenant)); if (!t) return NF("Tenant");
  const minutes = Number(c.body.minutes);
  if (!(minutes > 0) || !reasonOk(c.body.reason, 10)) return err(422, "validation_error", "Invalid request");
  if (minutes > 240) return err(400, "grant_too_long", "Maximum grant is 240 minutes");
  const grantee = c.s.staff.find((x) => x.id === c.body.staff_id); if (!grantee) return NF("Staff user");
  if (!grantee.is_active || !ROLE_PERMISSIONS[grantee.role].includes("support_access.use")) return err(400, "bad_grantee", "Grantee must be an active staff member whose role may use support access");
  if (grantee.id === c.u.id) return err(403, "forbidden", "You cannot grant support access to yourself");
  const gr: T.SupportGrant = { id: nid(), tenant_id: t.id, staff_id: grantee.id, ticket_id: typeof c.body.ticket_id === "string" ? c.body.ticket_id : null, scope: c.body.scope === "diagnostics" ? "diagnostics" : "read_only", reason: str(c.body.reason), granted_by: c.u.id, starts_at: now(), expires_at: new Date(Date.now() + minutes * 60_000).toISOString(), revoked_at: null, revoked_by: null, created_at: now() };
  c.s.grants.unshift(gr); log(c, "support_access.granted", "support_access_grant", gr.id, t.id, null, { grantee: grantee.email, minutes }, { reason: gr.reason });
  c.s.security.unshift({ id: ++c.s.seq, at: now(), type: "support_access_granted", severity: "warn", staff_id: grantee.id, email: grantee.email, ip: "127.0.0.1", details: { grant_id: gr.id } });
  return ok(gr, 201);
});
route("POST", "/support-access/grants/:id/revoke", "support_access.grant", (c) => {
  const gr = c.s.grants.find((x) => x.id === c.p[0]); if (!gr) return NF("Grant");
  if (!gr.revoked_at) { gr.revoked_at = now(); gr.revoked_by = c.u.id; log(c, "support_access.revoked", "support_access_grant", gr.id, gr.tenant_id); } return ok(gr);
});

// ---- logs / ops
route("GET", "/audit-log", "audit.read", (c) => {
  const a = c.q.get("action"), tn = c.q.get("tenant"), t = tn ? findTenant(c.s, tn) : null; const re = a ? new RegExp("^" + a.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$") : null;
  return ok(page(c.s.audit.filter((e) => (!re || re.test(e.action)) && (!tn || e.tenant_id === t?.id)), c.q));
});
route("GET", "/security-events", "security.read", (c) => { const ty = c.q.get("type"), sv = c.q.get("severity"); return ok(page(c.s.security.filter((e) => (!ty || e.type === ty) && (!sv || e.severity === sv)), c.q)); });
route("GET", "/ai-usage/summary", "ai_usage.read", (c) => ok({ items: c.s.ai }));
route("GET", "/system/health", "system.read", (c) => {
  // The demo's healthy jobs keep "beating": a long-running mock server must not turn them stale (that read as "System degraded").
  for (const j of c.s.jobs) if (j.status === "ok") { const ms = Date.now() - Date.parse(j.last_seen_at), every = j.expected_interval_seconds * 1000; if (ms > every) j.last_seen_at = new Date(Date.now() - (ms % every)).toISOString(); }
  const jobs = c.s.jobs.map((j) => { const age = Math.floor((Date.now() - Date.parse(j.last_seen_at)) / 1000); const stale = age > j.expected_interval_seconds * 3; return { ...j, age_seconds: age, stale, healthy: j.status === "ok" && !stale }; });
  const failed = c.s.onboarding.filter((a) => a.status === "failed").length;
  return ok({ status: jobs.every((j) => j.healthy) && !failed ? "ok" : "degraded", database: "ok", environment: "mock", signing_key_id: "mock-key-1", jobs, failed_onboardings: failed, checked_at: now() });
});
route("GET", "/config", "config.read", (c) => ok({ items: c.s.config }));
route("PUT", "/config/:key", "config.write", (c) => {
  const key = c.p[0];
  if (!/^[a-z][a-z0-9_.]{1,99}$/.test(key) || /secret|password|token|api_key|private/.test(key)) return err(400, "bad_key", "Invalid key (lowercase dotted name; secret-looking names are refused)");
  let row = c.s.config.find((x) => x.key === key); const before = row ? { value: row.value } : null;
  if (!row) { row = { key, value: null, description: null, updated_by: null, updated_at: now() }; c.s.config.push(row); c.s.config.sort((a, b) => a.key.localeCompare(b.key)); }
  row.value = c.body.value; row.updated_by = c.u.email; row.updated_at = now(); if (typeof c.body.description === "string") row.description = c.body.description;
  log(c, "config.set", "config", key, null, before, { value: row.value }); return ok(row);
});
route("DELETE", "/config/:key", "config.write", (c) => {
  const row = c.s.config.find((x) => x.key === c.p[0]); if (!row) return NF("Config key");
  c.s.config = c.s.config.filter((x) => x !== row); log(c, "config.deleted", "config", row.key, null, { value: row.value }); return ok({ ok: true });
});

export function mockHandle(method: string, path: string, query: URLSearchParams, body: unknown, bearer: string | null, headers?: Record<string, string>): UpResponse {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (method === "POST" && path === "/auth/mfa/verify") return mockMfaVerify(b);
  // enrolment is also reachable with the step-up token a mandatory-MFA role gets at sign-in (no session yet)
  if (method === "POST" && (path === "/auth/mfa/enrol/start" || path === "/auth/mfa/enrol/confirm") && bearer?.startsWith("mock-mfa.")) {
    const u = mfaUser(bearer, "enrol"); if (!u) return err(401, "unauthorized", "Invalid or expired MFA step-up token");
    if (path.endsWith("start")) return enrolStart(u, store());
    const r = enrolConfirm(u, store(), str(b.code)); if (r.status !== 200) return r;
    u.last_login_at = now(); return ok({ ...(r.body as object), ...issue(u, undefined, true) });
  }
  const u = principal(bearer);
  if (!u) return err(401, "unauthorized", "Invalid or missing credentials", { "WWW-Authenticate": "Bearer" });
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(path); if (!m) continue;
    if (r.perm && !ROLE_PERMISSIONS[u.role].includes(r.perm)) return err(403, "forbidden", "Not permitted");
    const h = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const ctx: Ctx = { s: store(), u, q: query, body: b, p: m.slice(1).map(decodeURIComponent), h };
    if (!isProtected(method, path, b)) return r.h(ctx);
    // After the permission check, before the action: a missing permission is 403 forbidden (no header), a missing code 403 step_up_required.
    const gate = checkGrant(ctx.s, u, h["x-step-up-token"], mfaRoles());
    if (!gate.ok) {
      const d = { reason: gate.reason, path, method };
      log(ctx, "step_up.denied", "staff_user", u.id, null, null, null, d);
      ctx.s.security.unshift({ id: ++ctx.s.seq, at: now(), type: "step_up_denied", severity: "warn", staff_id: u.id, email: u.email, ip: "127.0.0.1", details: d });
      return err(403, "step_up_required", gate.message, { "X-Step-Up-Required": "true" });
    }
    const res = r.h(ctx);
    if (gate.grant && res.status < 400) { // a use is taken only when the action went through
      gate.grant.uses_left -= 1;
      log(ctx, "step_up.used", "staff_user", u.id, null, null, null, { grant_id: gate.grant.id, path, method, uses_left: gate.grant.uses_left });
    }
    return res;
  }
  return err(404, "not_found", "Not found");
}
