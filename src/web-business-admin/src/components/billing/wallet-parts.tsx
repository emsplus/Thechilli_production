"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Notice } from "@chilli/ui";
import { ApiError } from "@/lib/api";
import { bannerText, bannerTone, billingApi, billingMissing, stateLabel, stateTone, type BillingBlock, type WalletResponse } from "@/lib/billing";

export type WalletLoad =
  | { state: "loading" }
  | { state: "ok"; data: WalletResponse }
  | { state: "missing" } // the server has no wallet routes (older pos-service): hide the credit parts
  | { state: "error"; message: string };

/** GET /billing/wallet for users with billing.view. `enabled` false = nothing is requested. */
export function useWallet(enabled: boolean) {
  const [load, setLoad] = useState<WalletLoad>({ state: "loading" });
  const reload = useCallback(async () => {
    try { setLoad({ state: "ok", data: await billingApi.wallet() }); }
    catch (e) {
      if (billingMissing(e)) setLoad({ state: "missing" });
      else setLoad({ state: "error", message: e instanceof ApiError && e.status !== 0 ? e.message : "Cannot reach the server. Your Chilli balance will show when you are back online." });
    }
  }, []);
  useEffect(() => { if (enabled) void Promise.resolve().then(reload); }, [enabled, reload]);
  return { load, reload };
}

const CHIP_TONE = { info: "info", success: "success", warning: "warning", danger: "danger" } as const;
export function StateChip({ b }: { b: BillingBlock }) {
  return <Badge tone={CHIP_TONE[stateTone(b)]} data-testid="credit-state">{stateLabel(b.state)}</Badge>;
}

/** The server's banner for the current state (trial, trial ending, low, grace, blocked, suspended). Nothing when all is well. */
export function WalletBanner({ b }: { b: BillingBlock }) {
  const text = bannerText(b);
  if (!text) return null;
  return <div data-testid="credit-banner" data-code={b.banner?.code ?? b.state}><Notice tone={bannerTone(b)}>{text}</Notice></div>;
}

export const UNAVAILABLE_TEXT = "Your Chilli balance is temporarily unavailable. Billing itself keeps working.";
