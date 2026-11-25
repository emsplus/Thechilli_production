"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api, onSessionExpired, tokenStore } from "@/lib/api";
import { loginUrl } from "@/lib/return-to";
import type { UserOut } from "@/lib/api/types";

type Status = "loading" | "anon" | "authed";
interface AuthCtx { user: UserOut | null; status: Status; login: (email: string, password: string) => Promise<UserOut>; logout: () => Promise<void> }
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<UserOut | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    onSessionExpired(() => { setUser(null); setStatus("anon"); router.replace(loginUrl(`${window.location.pathname}${window.location.search}`)); });
    // Memory-only tokens: after a reload there is no session. Cookie mode restores it from the httpOnly cookie.
    if (tokenStore.mode !== "cookie") { queueMicrotask(() => setStatus("anon")); return; }
    api.auth.me().then((u) => { setUser(u); setStatus("authed"); }, () => setStatus("anon"));
  }, [router]);

  const login = useCallback(async (email: string, password: string) => {
    const u = await api.auth.login(email, password);
    setUser(u); setStatus("authed");
    return u;
  }, []);
  const logout = useCallback(async () => {
    await api.auth.logout().catch(() => undefined);
    setUser(null); setStatus("anon");
  }, []);

  const value = useMemo(() => ({ user, status, login, logout }), [user, status, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
