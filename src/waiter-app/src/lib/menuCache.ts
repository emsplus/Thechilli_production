import { cacheGet, cachePut } from "./queue/idbStore";
import type { Category, DiningTable, MenuItem, ModifierGroup } from "./types";
import { api, currentOutletId } from "./api";

export interface Snapshot { savedAt: string; categories: Category[]; items: MenuItem[]; tables: DiningTable[]; currencySymbol?: string; modifierGroups?: ModifierGroup[] }
/** Tables (and so the snapshot) are per outlet: a waiter who switches outlet must never see the other outlet's tables. */
const keyFor = () => `snapshot:${currentOutletId() ?? "default"}`;
const HOURS = Number(process.env.NEXT_PUBLIC_MENU_STALE_HOURS ?? 12);

/** Pure: how old a snapshot is and whether to warn. A missing/invalid timestamp counts as stale. */
export function staleness(savedAt: string | null | undefined, now = Date.now(), maxHours = HOURS): { stale: boolean; ageHours: number | null } {
  const t = savedAt ? Date.parse(savedAt) : NaN;
  if (Number.isNaN(t)) return { stale: true, ageHours: null };
  const ageHours = Math.max(0, (now - t) / 3_600_000);
  return { stale: ageHours > maxHours, ageHours };
}

export interface LoadedMenu { snap: Snapshot; fromCache: boolean; refreshError?: string }

/** Network first; on failure fall back to the last snapshot (the stale-menu banner then tells the waiter). */
export async function loadMenu(): Promise<LoadedMenu | null> {
  try {
    // Modifier groups travel with the menu (offline one-tap adds need their defaults); a failure there never drops the menu.
    const [categories, items, tables, modifierGroups] = await Promise.all([api.categories(), api.items(), api.tables(), api.modifierGroups().catch(() => undefined)]);
    // The currency is cosmetic: a failure here must not discard a good menu.
    const r = await api.restaurant().catch(() => null);
    const snap: Snapshot = { savedAt: new Date().toISOString(), categories, items, tables, currencySymbol: r ? r.currency_symbol || r.currency : undefined, modifierGroups };
    await cachePut(keyFor(), snap);
    return { snap, fromCache: false };
  } catch (e) {
    const cached = await cacheGet<Snapshot>(keyFor());
    if (cached) return { snap: cached, fromCache: true, refreshError: e instanceof Error ? e.message : "offline" };
    return null;
  }
}
