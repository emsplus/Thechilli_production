"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, auth } from "@/lib/api";
import { loadSnapshot, saveSnapshot } from "@/lib/offlineDb";
import type { Category, Customer, DiningTable, MenuItem, VoiceAlias } from "@/lib/types";
import { getTaxConfig, setTaxConfig, useTaxConfig } from "@/lib/taxConfig";
import { extras, type ModifierGroup, type Offer } from "@/lib/extras";

const OFFERS_REFRESH_MS = 5 * 60_000;

/** Loads menu, tables, tax, customers and the learnt voice phrases; falls back to the offline snapshot when the server is unreachable. */
export function usePosMenu(online: boolean) {
  const router = useRouter();
  const [cats, setCats] = useState<Category[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [tables, setTables] = useState<DiningTable[]>([]);
  const tax = useTaxConfig(); // shared with every screen; cached for offline starts
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [aliases, setAliases] = useState<VoiceAlias[]>([]);
  const aliasesRef = useRef<VoiceAlias[]>([]);
  const keepAliases = useCallback((a: VoiceAlias[]) => { aliasesRef.current = a; setAliases(a); }, []);
  const [groups, setGroups] = useState<ModifierGroup[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const groupsRef = useRef<ModifierGroup[]>([]);
  const offersRef = useRef<Offer[]>([]);
  const [staleSince, setStaleSince] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // learnt phrases are a nicety: a failure keeps the ones already loaded / cached instead of failing the menu
      const [c, i, t, va] = await Promise.all([api.categories(), api.items(), api.tables(), api.voiceAliases().catch(() => null)]);
      if (va) keepAliases(va);
      else if (!aliasesRef.current.length) {
        const old = await loadSnapshot();
        if (old?.restaurant_id === auth.restaurantId) keepAliases((old?.voiceAliases ?? []) as VoiceAlias[]);
      }
      // Modifier groups only when a dish uses them; running offers always (both optional: an older server simply has none).
      const [mg, of] = await Promise.all([
        i.some((x) => (x.modifier_group_ids?.length ?? 0) > 0) ? extras.modifierGroups().catch(() => groupsRef.current) : Promise.resolve([] as ModifierGroup[]),
        extras.activeOffers().catch(() => offersRef.current),
      ]);
      groupsRef.current = mg; offersRef.current = of; setGroups(mg); setOffers(of);
      const tx = await api.taxConfig().catch(() => null);
      if (tx) setTaxConfig(tx);
      const std = tx?.rates.find((r) => r.code === "standard");
      void api.customers().then(setCustomers).catch(() => setCustomers([]));
      setCats(c); setItems(i); setTables(t); setStaleSince(null); setError(null);
      void saveSnapshot({ savedAt: new Date().toISOString(), restaurant_id: auth.restaurantId ?? undefined, categories: c, items: i, tables: t, voiceAliases: aliasesRef.current, modifierGroups: mg, offers: of,
        tax: tx && std ? { name: std.name, rate_percent: std.rate_percent, currency: tx.currency } : null, taxConfig: tx ?? getTaxConfig() });
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        const saved = await loadSnapshot();
        // Another account's cached menu must never be sold from on this session.
        const snap = saved && (!saved.restaurant_id || saved.restaurant_id === auth.restaurantId) ? saved : null;
        if (snap) {
          setCats(snap.categories as Category[]); setItems(snap.items as MenuItem[]); setTables(snap.tables as DiningTable[]);
          keepAliases((snap.voiceAliases ?? []) as VoiceAlias[]);
          setGroups((snap.modifierGroups ?? []) as ModifierGroup[]); setOffers((snap.offers ?? []) as Offer[]);
          if (snap.taxConfig && !getTaxConfig()) setTaxConfig(snap.taxConfig);
          setStaleSince(snap.savedAt);
        } else setError("Cannot reach the server and no offline menu is saved on this device. Open Chilli Agent once while online.");
      } else setError(e instanceof ApiError ? e.message : "Failed to load");
    } finally { setLoading(false); }
  }, [keepAliases]);

  useEffect(() => {
    if (!auth.token) { router.replace("/login"); return; }
    void Promise.resolve().then(load);
  }, [load, router]);

  // Offers depend on the time of day: refresh the running list every few minutes (one small request, no menu reload).
  useEffect(() => {
    if (!online) return;
    const id = setInterval(() => { if (!document.hidden) extras.activeOffers().then((o) => { offersRef.current = o; setOffers(o); }).catch(() => { /* keep the last list */ }); }, OFFERS_REFRESH_MS);
    return () => clearInterval(id);
  }, [online]);

  // Refresh the menu automatically when connectivity returns.
  useEffect(() => { if (online && staleSince) void Promise.resolve().then(load); }, [online, staleSince, load]);

  /** A customer created (or found) from the till joins the loaded list straight away. */
  const upsertCustomer = useCallback((c: Customer) => {
    setCustomers((list) => [c, ...list.filter((x) => x.id !== c.id)]);
  }, []);

  /** A phrase learnt on this till: used straight away here (and offline, through the snapshot); other tills get it on their next load. */
  const upsertAlias = useCallback((a: VoiceAlias) => {
    const next = [...aliasesRef.current.filter((x) => x.phrase !== a.phrase), a];
    keepAliases(next);
    void loadSnapshot().then((snap) => { if (snap && (!snap.restaurant_id || snap.restaurant_id === auth.restaurantId)) void saveSnapshot({ ...snap, voiceAliases: next }); });
  }, [keepAliases]);

  return { cats, items, tables, tax, groups, offers, customers, upsertCustomer, aliases, upsertAlias, staleSince, loading, error, reload: load };
}
