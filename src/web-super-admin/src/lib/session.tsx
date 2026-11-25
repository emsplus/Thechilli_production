"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, sessionHttp, onUnauthorized } from "./api";
import type { Me, LoginResult } from "./api/types";
import { canAll, permSet, type PermSet } from "./permissions";
import { pathAllowed } from "./nav";
import { stepUpCoordinator } from "./step-up-coordinator";

type State = { status: "loading" } | { status: "anon" } | { status: "error"; error: ApiError } | { status: "authed"; me: Me };

interface Ctx {
  state: State;
  perms: PermSet;
  signIn: (email: string, password: string) => Promise<LoginResult>;
  signOut: () => Promise<void>;
  /** Adopt a user returned by a completed second factor (the BFF already set the cookies). */
  adopt: (me: Me) => void;
  reload: () => void;
}
const SessionCtx = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const router = useRouter();

  const fetchMe = useCallback(async (): Promise<State> => {
    try {
      return { status: "authed", me: await sessionHttp.get<Me>("/me") };
    } catch (e) {
      return e instanceof ApiError && (e.isAuth || e.isForbidden) ? { status: "anon" } : { status: "error", error: e instanceof ApiError ? e : new ApiError(0, "network", "Cannot reach the server.") };
    }
  }, []);

  useEffect(() => {
    let live = true;
    void fetchMe().then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [fetchMe]);
  useEffect(() => {
    onUnauthorized(() => { setState({ status: "anon" }); });
    return () => onUnauthorized(null);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await sessionHttp.post<LoginResult>("/login", { email, password });
    if (r.status === "signed_in") setState({ status: "authed", me: r.user });
    return r;
  }, []);
  const signOut = useCallback(async () => {
    try { await sessionHttp.post("/logout"); } finally { stepUpCoordinator.clear(); setState({ status: "anon" }); router.replace("/login"); }
  }, [router]);

  const perms = useMemo(() => permSet(state.status === "authed" ? state.me.permissions : []), [state]);
  const adopt = useCallback((me: Me) => setState({ status: "authed", me }), []);
  const value = useMemo(() => ({ state, perms, signIn, signOut, adopt, reload: () => { setState({ status: "loading" }); void fetchMe().then(setState); } }), [state, perms, signIn, signOut, adopt, fetchMe]);
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error("useSession must be used inside <SessionProvider>");
  return c;
}
/** `useCan("tenants.suspend")`: hides write actions the role does not hold (the server still enforces). */
export function useCan() {
  const { perms } = useSession();
  return useCallback((...need: Parameters<typeof canAll>[1] & string[]) => canAll(perms, need), [perms]);
}

export function useRouteGuard() {
  const { state, perms } = useSession();
  const pathname = usePathname();
  return state.status === "authed" ? pathAllowed(pathname, perms) : true;
}
