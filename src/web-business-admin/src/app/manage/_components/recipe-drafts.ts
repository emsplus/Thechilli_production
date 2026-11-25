"use client";

import { useCallback, useEffect, useState } from "react";
import { auth } from "@/lib/api";
import type { RecipeDraft } from "@/lib/types";

/** One ingredient row of a recipe editor (same shape as the Recipes tab rows). */
export interface DraftRow { key: number; item_id: string; quantity: string; unit: string }
export interface StoredDraft {
  menu_item_id: string; name: string; rows: DraftRow[];
  /** Ingredients the AI wanted that are not in stock yet; turned into rows once the stock items are created. */
  missing: { name: string; base_unit: "g" | "ml" | "pcs"; quantity: string }[];
  warnings: string[];
}

let keySeq = 1;
export const nextKey = () => keySeq++;

const storeKey = () => `pos.recipeDrafts.${auth.restaurantId ?? "x"}`;
/** Quantities come back as "300.000": show "300". */
const qty = (q: string) => String(+Number(q).toFixed(3));

export function fromServer(d: RecipeDraft): StoredDraft {
  return { menu_item_id: d.menu_item_id, name: d.menu_item_name, warnings: d.warnings,
    rows: d.ingredients.map((g) => ({ key: nextKey(), item_id: g.item_id, quantity: qty(g.quantity), unit: g.unit })),
    missing: d.missing.map((m) => ({ ...m, quantity: qty(m.quantity) })) };
}

function load(): Record<string, StoredDraft> {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey()) ?? "{}") as Record<string, StoredDraft>;
    for (const d of Object.values(raw)) d.rows = (d.rows ?? []).map((r) => ({ ...r, key: nextKey() }));
    return raw;
  } catch { return {}; }
}

/**
 * AI recipe drafts waiting for the owner's review. Kept in this browser only (per restaurant), so a long bulk run can be
 * paused, resumed or continued tomorrow. They are NOT recipes: nothing counts for stock until the owner saves them.
 */
export function useRecipeDrafts() {
  const [drafts, setDrafts] = useState<Record<string, StoredDraft>>({});
  const [ready, setReady] = useState(false);
  useEffect(() => { void Promise.resolve().then(() => { setDrafts(load()); setReady(true); }); }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(storeKey(), JSON.stringify(drafts)); } catch { /* storage unavailable: drafts live for this visit only */ }
  }, [drafts, ready]);
  const put = useCallback((d: StoredDraft) => setDrafts((x) => ({ ...x, [d.menu_item_id]: d })), []);
  const patch = useCallback((id: string, p: Partial<StoredDraft>) => setDrafts((x) => (x[id] ? { ...x, [id]: { ...x[id], ...p } } : x)), []);
  const remove = useCallback((ids: string[]) => setDrafts((x) => { const n = { ...x }; for (const id of ids) delete n[id]; return n; }), []);
  return { drafts, ready, put, patch, remove };
}
