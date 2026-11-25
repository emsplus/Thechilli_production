"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { api, ApiError, auth } from "./api";
import type { Me, Role } from "./types";
import { bizCapsOf, LEGACY_CAPS, type BizCapKey, type BizCaps } from "./business";

/** "unknown" = could not ask (offline): show everything and let the server decide. null = signed out / not loaded yet. */
export type RoleState = Role | "unknown" | null;

let cache: { token: string; promise: Promise<RoleState> } | null = null;
/** The last role / capabilities the server really told us, per access token: a slow or failed /auth/me never wipes them (the sidebar must not drop items). */
let lastRole: { token: string; role: RoleState } | null = null;
let lastCaps: { token: string; caps: Capabilities } | null = null;

/** A failed lookup (null) never replaces a role we already know; a real answer always does. */
export const keepKnownRole = (prev: RoleState, next: RoleState): RoleState => (next === null && prev !== null ? prev : next);
const knownRole = (token: string | null | undefined): RoleState => (token && lastRole?.token === token ? lastRole.role : null);
const knownCaps = (token: string | null | undefined): Capabilities | null => (token && lastCaps?.token === token ? lastCaps.caps : null);

function fetchRole(token: string): Promise<RoleState> {
  if (cache?.token === token) return cache.promise;
  const promise = api.me().then((m): RoleState => { lastRole = { token, role: m.role }; return m.role; }).catch((e): RoleState => {
    if (cache?.token === token) cache = null; // retry next time
    return e instanceof ApiError && e.status === 0 ? "unknown" : null;
  });
  cache = { token, promise };
  return promise;
}

/** Signed-in user's role from GET /auth/me (cached per access token, re-checked on navigation). Used to hide nav items. */
export function useRole(): RoleState {
  const pathname = usePathname();
  const [role, setRole] = useState<RoleState>(() => knownRole(auth.token));
  useEffect(() => {
    const t = auth.token;
    if (!t) { void Promise.resolve().then(() => setRole(null)); return; }
    let off = false;
    void fetchRole(t).then((r) => { if (!off) setRole((prev) => (knownRole(t) !== null && r === null ? keepKnownRole(prev, r) : r)); });
    return () => { off = true; };
  }, [pathname]);
  return role;
}

export const isAdminRole = (r: RoleState) => r === "owner" || r === "manager" || r === "unknown";

/** What GET /auth/me says about permissions and the tenant's entitlements. "all" = not told (older server or offline): everything is allowed and the API decides. */
/** `biz`: what the business type switches on (docs/BUSINESS_TYPES.md); restaurant defaults on an older server. */
export interface Capabilities { perms: string[] | "all"; features: Record<string, { enabled: boolean; limit: number | null }> | null; /** code -> available (granted AND switched on), from /auth/me `features`; null = not told. */ access: Record<string, boolean> | null; readOnly: boolean; warning: string | null; ready: boolean; biz: BizCaps }
const NONE: Capabilities = { perms: [], features: null, access: null, readOnly: false, warning: null, ready: false, biz: LEGACY_CAPS };

const BIZ_KEY = "pos.bizCaps";
/** The last known business capabilities (so an offline start of a cloud kitchen still hides Dine-in and Tables). */
function cachedBiz(): BizCaps { try { const v = localStorage.getItem(BIZ_KEY); return v ? bizCapsOf({ capabilities: JSON.parse(v) }) : LEGACY_CAPS; } catch { return LEGACY_CAPS; } }
function rememberBiz(b: BizCaps) { try { localStorage.setItem(BIZ_KEY, JSON.stringify(b)); } catch { /* storage unavailable */ } }

export function capabilitiesOf(m: Me | null, offline = false): Capabilities {
  if (!m) return { ...NONE, perms: offline ? "all" : [], ready: true, biz: offline ? cachedBiz() : LEGACY_CAPS };
  const ent = m.entitlements;
  return { perms: m.permissions ?? "all", features: ent && typeof ent === "object" ? ent.features ?? null : null, access: m.features && typeof m.features === "object" ? m.features : null, readOnly: !!m.read_only, warning: m.entitlement_warning ?? ent?.warning ?? null, ready: true, biz: bizCapsOf(m) };
}
export const canOf = (c: Capabilities, perm: string) => c.perms === "all" || c.perms.includes(perm);
/** A feature the tenant's plan may use. No entitlements (null) or a code missing from the map = allowed (legacy tenants; the server uses the same default). Only an explicit `enabled: false` hides. */
export const featureOf = (c: Capabilities, code: string) => (c.access === null || c.access[code] !== false) && (c.features === null || c.features[code] === undefined || c.features[code].enabled !== false);

const sameCaps = (a: Capabilities, b: Capabilities) => a === b || JSON.stringify(a) === JSON.stringify(b);

let meCache: { token: string; promise: Promise<Capabilities> } | null = null;

/** Fired (window) after the owner changes a feature switch: screens that hold their own copy of /auth/me re-read it. */
export const ME_CHANGED = "chilli:me-changed";
const refreshers = new Set<() => void>();
/** Forget the cached /auth/me answers (role, permissions, features) and tell every mounted screen to ask again. */
export function refreshCapabilities(): void {
  meCache = null; cache = null; lastCaps = null;
  refreshers.forEach((f) => f());
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ME_CHANGED));
}
function fetchCaps(token: string): Promise<Capabilities> {
  if (meCache?.token === token) return meCache.promise;
  const promise = api.me().then((m) => { const c = capabilitiesOf(m); rememberBiz(c.biz); lastCaps = { token, caps: c }; return c; }).catch((e): Capabilities => {
    if (meCache?.token === token) meCache = null;
    const offline = e instanceof ApiError && e.status === 0;
    const known = knownCaps(token);
    if (known) return known; // a transient failure keeps the permissions we already know (nothing disappears)
    return capabilitiesOf(null, offline);
  });
  meCache = { token, promise };
  return promise;
}

/**
 * Permissions and entitlements of the signed-in user. `can("bills.void")`: holds the server permission (hides UI only; the API enforces).
 * `feature("inventory")`: the plan includes it. Loading: can() is false and ready is false. Offline / old server: allowed.
 */
export function useCan(): { can: (perm: string) => boolean; feature: (code: string) => boolean; has: (cap: BizCapKey) => boolean; biz: BizCaps; ready: boolean; readOnly: boolean; warning: string | null } {
  const pathname = usePathname();
  const [caps, setCaps] = useState<Capabilities>(() => knownCaps(auth.token) ?? NONE);
  const [tick, setTick] = useState(0); // bumped by refreshCapabilities(): ask /auth/me again
  useEffect(() => { const f = () => setTick((n) => n + 1); refreshers.add(f); return () => { refreshers.delete(f); }; }, []);
  useEffect(() => {
    const t = auth.token;
    if (!t) return;
    let off = false;
    void fetchCaps(t).then((c) => { if (!off) setCaps((prev) => (sameCaps(prev, c) ? prev : c)); });
    return () => { off = true; };
  }, [pathname, tick]);
  // Stable identities: callers put `can` in effect / callback deps (a new function every render re-ran Today's loader on
  // every render: the /cash-sessions/current request storm).
  const can = useCallback((p: string) => caps.ready && canOf(caps, p), [caps]);
  const feature = useCallback((c: string) => featureOf(caps, c), [caps]);
  // Business-type capability (docs/BUSINESS_TYPES.md). Before /auth/me answers: the restaurant defaults (nothing hidden early).
  const has = useCallback((k: BizCapKey) => caps.biz[k], [caps]);
  return useMemo(() => ({ can, feature, has, biz: caps.biz, ready: caps.ready, readOnly: caps.readOnly, warning: caps.warning }), [can, feature, has, caps]);
}
