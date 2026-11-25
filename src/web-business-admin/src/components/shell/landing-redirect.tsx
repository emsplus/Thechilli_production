"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/api";
import { useRole } from "@/lib/useRole";
import { landingFor } from "./nav-model";

/** "/" -> the signed-in role's home. Signed out: /pos, whose API calls send the browser to /login (same as before). */
export function LandingRedirect() {
  const router = useRouter();
  const role = useRole();
  useEffect(() => {
    if (!auth.token) router.replace("/pos");
    else if (role !== null) router.replace(landingFor(role));
  }, [role, router]);
  return <p className="p-6 text-sm text-fg-muted" role="status">Loading…</p>;
}
