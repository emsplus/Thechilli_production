"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api, auth } from "./api";
import { formatCurrency } from "./money";
import { loadSnapshot } from "./offlineDb";
import type { TaxConfig } from "./types";

/**
 * The restaurant's GST / currency configuration (GET /billing/tax-config), fetched once per session and shared by
 * every screen. Cached in localStorage (instant first paint of the right currency, offline starts) and, with the menu,
 * in the IndexedDB snapshot. Always scoped by restaurant id: another account's config is never used.
 */
const LS_KEY = "pos.taxConfig";
interface Cached { rid: string; config: TaxConfig }

let mem: Cached | null = null;
let memLoaded = false;
let fetchedFor: string | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * INR only (owner rule): whatever an older / legacy account says, every screen shows rupees, GST and GSTIN.
 * Rates keep their percentages (the server computes the bill); only the words and the currency are Indian.
 */
export function indianise(c: TaxConfig): TaxConfig {
  return { ...c, country: "IN", currency: "INR", currency_symbol: "₹", tax_number_label: "GSTIN", rates: c.rates };
}

function readLs(): Cached | null {
  try { const raw = localStorage.getItem(LS_KEY); const c = raw ? (JSON.parse(raw) as Cached) : null; return c ? { ...c, config: indianise(c.config) } : null; } catch { return null; }
}
function writeLs(c: Cached) { try { localStorage.setItem(LS_KEY, JSON.stringify(c)); } catch { /* storage unavailable */ } }

let lastToken: string | null | undefined;
let lastRid: string | null = null;
function currentRid(): string | null {
  const t = auth.token;
  if (t !== lastToken) { lastToken = t; lastRid = auth.restaurantId; }
  return lastRid;
}

function getSnapshot(): TaxConfig | null {
  const rid = currentRid();
  if (!rid) return null;
  if (!memLoaded) { memLoaded = true; mem = readLs(); }
  return mem && mem.rid === rid ? mem.config : null;
}

/** Non-hook read (event handlers, pure helpers). */
export const getTaxConfig = getSnapshot;

export function setTaxConfig(config: TaxConfig, rid: string | null = currentRid()) {
  if (!rid) return;
  mem = { rid, config: indianise(config) }; memLoaded = true;
  writeLs(mem);
  emit();
}

/** Fetches the config unless already fetched this session for this restaurant. Offline: keeps / restores the cached copy. */
export function ensureTaxConfig(force = false): Promise<void> {
  const rid = currentRid();
  if (!rid || !auth.token) return Promise.resolve();
  if (!force && fetchedFor === rid && getSnapshot()) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const cfg = await api.taxConfig();
      fetchedFor = rid;
      setTaxConfig(cfg, rid);
    } catch {
      if (!getSnapshot()) {
        const snap = await loadSnapshot();
        if (snap?.taxConfig && (!snap.restaurant_id || snap.restaurant_id === rid)) setTaxConfig(snap.taxConfig, rid);
      }
    } finally { inflight = null; }
  })();
  return inflight;
}

/** After the owner changes GST settings: re-read the config everywhere. */
export const refreshTaxConfig = () => ensureTaxConfig(true);

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === LS_KEY) { memLoaded = false; cb(); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

/** The tax config of the signed-in restaurant, or null until it is known (first paint, signed out, never loaded). */
export function useTaxConfig(): TaxConfig | null {
  const cfg = useSyncExternalStore(subscribe, getSnapshot, () => null);
  useEffect(() => { void ensureTaxConfig(); }, []);
  return cfg;
}

/** Currency code of the restaurant (always "INR" once known), "" while unknown. */
export function useCurrency(): string { return useTaxConfig()?.currency ?? ""; }

/** `(value) => "₹1,234.50"` in the restaurant's currency. */
export function useMoneyFormat(): (v: string | number | null | undefined) => string {
  const c = useCurrency();
  return (v) => formatCurrency(v, c);
}
