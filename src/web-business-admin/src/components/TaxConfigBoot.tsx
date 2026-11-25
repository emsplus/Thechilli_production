"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { ensureTaxConfig } from "@/lib/taxConfig";

/**
 * Loads the restaurant's GST / currency configuration once per session (and again after a sign-in, because the first
 * page after /login is a navigation). Offline it falls back to the copy cached with the menu. See lib/taxConfig.ts.
 */
export function TaxConfigBoot() {
  const pathname = usePathname();
  useEffect(() => { if (!["/login", "/register", "/forgot-password", "/reset-password"].some((p) => pathname.startsWith(p))) void ensureTaxConfig(); }, [pathname]);
  return null;
}
