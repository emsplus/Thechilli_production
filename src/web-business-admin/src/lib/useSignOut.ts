"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { api, auth } from "@/lib/api";
import { safeLogoutCleanup } from "@/lib/sync";

/**
 * Safe sign-out: flushes the offline queue first and, if unsynced operations remain,
 * asks before discarding them (native confirm, as the e2e suite expects). Then the BFF revokes the
 * session on the API and clears the httpOnly session cookies (best-effort when offline), and the in-memory token is dropped.
 * Returns an async function; resolves true when the user was signed out.
 */
export function useSignOut() {
  const router = useRouter();
  return useCallback(async () => {
    const ok = await safeLogoutCleanup((n, d) => {
      const what = [n > 0 && `${n} offline operation(s)`, d > 0 && `${d} open order ticket(s) with items`].filter(Boolean).join(" and ");
      return window.confirm(`${what} have not synced yet. Signing out will DISCARD them. Continue?`);
    });
    if (ok) {
      await api.logout().catch(() => { /* best-effort: offline (the API session then simply expires), or already revoked */ });
      auth.clear(); router.replace("/login");
    }
    return ok;
  }, [router]);
}
