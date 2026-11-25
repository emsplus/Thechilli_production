"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { FoodImage } from "@/components/pos/food-image";
import { VegMark } from "@/components/menu/veg-mark";
import { mediaUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { vegOf } from "@/lib/menuAdmin";
import { formatCurrency } from "@/lib/money";
import type { Category, MenuItem } from "@/lib/types";

/** Rows rendered per open category before "Show more": keeps a 200+ dish menu light on a phone. */
export const PAGE = 25;

/**
 * Menu items on a phone (UI_REVIEW BA-5: 42 full cards made a 19,000 px page). A sticky search, then one collapsed
 * section per category with its count; a section opens into compact rows (40 px thumbnail, name, price, actions) and
 * renders PAGE rows at a time. While searching, the categories with matches open by themselves.
 */
export function PhoneMenuList({ cats, items, q, onQ, currency, searchLabel, searchPh, uncategorised, row }: {
  cats: Category[]; items: MenuItem[]; q: string; onQ: (v: string) => void; currency: string;
  searchLabel: string; searchPh: string; uncategorised: string;
  /** Actions for one row (edit / archive / select), already labelled with the dish name. */
  row: (i: MenuItem) => ReactNode;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState<Record<string, number>>({});
  const searching = q.trim().length > 0;
  const groups = useMemo(() => {
    const by = new Map<string, MenuItem[]>();
    for (const i of items) { const k = i.category_id ?? ""; by.set(k, [...(by.get(k) ?? []), i]); }
    const known = cats.filter((c) => by.has(c.id)).map((c) => ({ id: c.id, name: c.name, items: by.get(c.id)! }));
    const rest = [...by.keys()].filter((k) => !cats.some((c) => c.id === k)).flatMap((k) => by.get(k)!);
    return rest.length ? [...known, { id: "__none", name: uncategorised, items: rest }] : known;
  }, [cats, items, uncategorised]);
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div data-testid="phone-menu-list">
      <div className="sticky top-[var(--topbar-h)] z-20 -mx-3 mb-3 bg-bg px-3 py-2">
        <label className="relative block">
          <span className="sr-only">{searchLabel}</span>
          <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-[1.1rem] -translate-y-1/2 text-fg-subtle" />
          <input type="search" autoComplete="off" value={q} onChange={(e) => onQ(e.target.value)} placeholder={searchPh}
            className="h-12 w-full rounded-2xl border border-border bg-surface pl-10 pr-12 text-[0.95rem] text-fg shadow-xs outline-none placeholder:text-fg-subtle focus:border-primary [&::-webkit-search-cancel-button]:hidden" />
          {q && <button type="button" aria-label="Clear search" onClick={() => onQ("")} className="absolute right-0.5 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-xl text-fg-subtle"><X aria-hidden className="size-4" /></button>}
        </label>
      </div>
      {groups.length === 0 && <p role="status" className="py-8 text-center text-sm text-fg-muted">No items match &ldquo;{q.trim()}&rdquo;.</p>}
      <ul className="space-y-2">
        {groups.map((g) => {
          const isOpen = searching || open.has(g.id);
          const n = limit[g.id] ?? PAGE;
          const panel = `phone-menu-${g.id}`;
          return (
            <li key={g.id} className="overflow-hidden rounded-xl border border-border bg-surface">
              <button type="button" aria-expanded={isOpen} aria-controls={panel} onClick={() => toggle(g.id)} disabled={searching}
                className="flex min-h-12 w-full items-center justify-between gap-3 px-3.5 text-left font-semibold text-fg disabled:cursor-default">
                <span className="min-w-0 truncate">{g.name}</span>
                <span className="flex shrink-0 items-center gap-2 text-sm text-fg-muted"><span className="tnum rounded-full bg-surface-2 px-2">{g.items.length}</span>
                  <ChevronDown aria-hidden className={cn("size-4 transition-transform", isOpen && "rotate-180")} /></span>
              </button>
              {isOpen && (
                <div id={panel}>
                  <ul className="divide-y divide-border border-t border-border">
                    {g.items.slice(0, n).map((i) => (
                      <li key={i.id} data-testid="phone-menu-row" className={cn("flex min-h-14 items-center gap-3 px-3 py-1.5", !i.is_active && "opacity-70")}>
                        <FoodImage src={mediaUrl(i.thumb_url ?? i.image_url)} name={i.name} category={g.name} variant="thumb" className="size-10 shrink-0 rounded-lg" />
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 text-sm font-semibold text-fg [overflow-wrap:anywhere]">{vegOf(i) && <VegMark kind={vegOf(i)!} />}{i.name}</p>
                          <p className="ch-money text-sm text-fg-muted" translate="no">{formatCurrency(i.price, currency)}{i.variants.length > 0 && ` · ${i.variants.length + 1} options`}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">{row(i)}</div>
                      </li>
                    ))}
                  </ul>
                  {g.items.length > n && (
                    <button type="button" onClick={() => setLimit((l) => ({ ...l, [g.id]: n + PAGE }))}
                      className="flex min-h-11 w-full items-center justify-center border-t border-border text-sm font-semibold text-primary-soft-fg">
                      Show {Math.min(PAGE, g.items.length - n)} more of {g.items.length - n}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
