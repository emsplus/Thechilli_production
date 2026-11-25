"use client";

import { useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCan, useRole } from "@/lib/useRole";
import { auth } from "@/lib/api";
import { activeAreaId, activeHref, bottomBar, visibleAreas } from "./nav-model";

const none = () => () => {};
/** Signed in on this device; the server render (and first hydration pass) says yes, so it draws skeletons, never a guessed list. */
export const useSignedInHere = () => useSyncExternalStore(none, () => !!auth.token, () => true);

/**
 * Role + route aware nav state for the sidebar and bottom bar. Reads ?tab=, so render inside <Suspense>.
 * `loading`: signed in but the role has not been answered yet and none is known: the shell draws skeleton items instead of
 * guessing a cashier's short list (which dropped Manage while a page was still loading).
 */
export function useNav() {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const role = useRole();
  const { can, feature, has, ready } = useCan();
  const signedIn = useSignedInHere();
  const loading = role === null && signedIn;
  // Until /auth/me answered, role-only gating applies (no flash of hidden entries); then permissions and entitlements refine it.
  const gate = ready ? { can, feature, has } : undefined;
  const areas = loading ? [] : visibleAreas(role, gate);
  const bar = loading ? { slots: [], more: [] } : bottomBar(role, gate);
  return { pathname, tab, role, loading, areas, bar, active: activeAreaId(pathname, tab), activeHref: activeHref(pathname, tab, areas.flatMap((a) => a.items.map((i) => i.href))) };
}
