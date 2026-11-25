"use client";

import { createContext, useContext } from "react";
import type { ManageSummary, Me } from "@/lib/types";
import { ROLE_INFO_MSG } from "./staff-messages";

export interface ManageCtx {
  me: Me;
  /** Owner-only actions (change roles, deactivate staff, edit the restaurant profile). */
  isOwner: boolean;
  summary: ManageSummary | null;
  /** Re-reads the overview numbers after a change. */
  refresh: () => void;
  /** Jump to another section (optionally a sub-view and extra query params such as `invoice`, `from`, `highlight`). */
  goto: (tab: string, view?: string, extra?: Record<string, string>) => void;
}

const Ctx = createContext<ManageCtx | null>(null);
export const ManageProvider = Ctx.Provider;
export function useManage(): ManageCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useManage must be used inside the Manage panel");
  return c;
}

/** English role names and blurbs (derived from ROLE_INFO_MSG). Screens that follow the language use `useMsg(ROLE_INFO_MSG)` with `<role>.label` / `<role>.blurb`. */
export const ROLE_INFO: Record<string, { label: string; blurb: string }> = Object.fromEntries(
  ["owner", "manager", "cashier", "waiter", "kitchen"].map((r) => [r, { label: ROLE_INFO_MSG[`${r}.label` as keyof typeof ROLE_INFO_MSG].en, blurb: ROLE_INFO_MSG[`${r}.blurb` as keyof typeof ROLE_INFO_MSG].en }]),
);
