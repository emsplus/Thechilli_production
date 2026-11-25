"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import { msg, type Locale } from "./i18n";
import { PRINT_MSG } from "@/app/manage/_components/devices-messages";
import type { PrintJob } from "./types";

/**
 * True when thermal printing is set up (at least one active printer), so the POS shows its "Print" action. Every role that takes
 * orders may ask (names only). Any error (offline, server down) = false: the POS then behaves exactly as without printers.
 */
export function useHasPrinters(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let off = false;
    api.availablePrinters().then((p) => { if (!off) setHas(p.length > 0); }).catch(() => { if (!off) setHas(false); });
    return () => { off = true; };
  }, []);
  return has;
}

let kitchenAuto: { at: number; on: boolean } | null = null;
/**
 * True when a kitchen printer is set to print slips automatically: the POS then sends the kitchen slip (KOT) by itself the moment an
 * order is placed. The answer is remembered for a minute and, offline, the last known one is used (never throws; unknown = false,
 * which leaves the manual "Send to kitchen" button as the only way, exactly as without printers).
 */
export async function thermalAutoKot(): Promise<boolean> {
  if (kitchenAuto && Date.now() - kitchenAuto.at < 60_000) return kitchenAuto.on;
  try {
    kitchenAuto = { at: Date.now(), on: (await api.availablePrinters()).some((p) => p.auto_kot) };
  } catch { /* offline or server down: keep the last answer */ }
  return kitchenAuto?.on ?? false;
}

/** Language-aware label of a job's kind / state (English by default). */
export const jobKindText = (kind: PrintJob["kind"], locale: Locale = "en") => msg(locale, PRINT_MSG[`kind_${kind}`]);
export const jobStateText = (status: PrintJob["status"], locale: Locale = "en") => msg(locale, PRINT_MSG[`state_${status}`]);

export const JOB_KIND: Record<PrintJob["kind"], string> = { bill: jobKindText("bill"), kot: jobKindText("kot"), test: jobKindText("test") };

/** What a job's state means for the person standing at the till, in plain words. */
export const JOB_STATE: Record<PrintJob["status"], string> = {
  queued: jobStateText("queued"), sent: jobStateText("sent"), printed: jobStateText("printed"), failed: jobStateText("failed"),
};

/** Hub / printer error text turned into something a non-technical owner can act on; unknown text is shown as is. */
export function plainError(raw: string | null | undefined, locale: Locale = "en"): string {
  const m = (k: keyof typeof PRINT_MSG, p?: Record<string, string>) => msg(locale, PRINT_MSG[k], p);
  const e = (raw ?? "").trim();
  if (!e) return m("err_empty");
  const l = e.toLowerCase();
  if (l.includes("econnrefused") || l.includes("refused")) return m("err_refused", { raw: e });
  if (l.includes("ehostunreach") || l.includes("enetunreach") || l.includes("unreachable") || l.includes("enotfound") || l.includes("getaddrinfo")) return m("err_unreachable", { raw: e });
  if (l.includes("timed out") || l.includes("timeout") || l.includes("etimedout")) return m("err_timeout", { raw: e });
  if (l.includes("not found") || l.includes("no such printer") || l.includes("unknown printer") || l.includes("queue")) return m("err_queue", { raw: e });
  if (l.includes("paper") || l.includes("cover")) return m("err_paper", { raw: e });
  return e;
}

/** The newest job per printer (jobs arrive newest first), so a reprint replaces the old failed line instead of sitting beside it. */
export function latestPerPrinter(jobs: PrintJob[]): PrintJob[] {
  const seen = new Set<string>();
  return jobs.filter((j) => { if (seen.has(j.printer_id)) return false; seen.add(j.printer_id); return true; });
}

export const jobBusy = (j: PrintJob) => j.status === "queued" || j.status === "sent";
