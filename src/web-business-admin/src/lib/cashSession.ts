"use client";

import { api, auth } from "./api";
import { setShared, useSharedQuery } from "./query";
import type { CashSession } from "./types";

export type CashSessionValue = CashSession | null | "unsupported";

/** Cache key of the signed-in user's open cash session (per restaurant session: never shared across accounts). */
export const cashSessionKey = () => `cash-session:current:${auth.restaurantId ?? "-"}:${(auth.token ?? "").slice(-12)}`;

/**
 * The caller's open cash drawer, shared by Today and the Cash page: one request however many readers, cached 30 s,
 * refreshed every 60 s while visible. No retry. "No drawer open" is a normal answer (null) read from the open-drawer list (200), so no 404 and no console error.
 */
export function useCashSession(enabled: boolean) {
  return useSharedQuery<CashSessionValue>(enabled ? cashSessionKey() : null, () => api.cashSessionCurrent(), { staleMs: 30_000, refetchMs: 60_000 });
}

/** After opening / closing a shift: every reader sees the new state without a request. */
export const setCashSession = (v: CashSessionValue) => setShared(cashSessionKey(), v);
