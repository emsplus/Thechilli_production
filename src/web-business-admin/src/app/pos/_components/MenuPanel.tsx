"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { LayoutGrid, Lock, Search, X } from "lucide-react";
import { Button as UiButton, IconButton, Notice } from "@chilli/ui";
import { EmptyState, Kbd, PillTabs, Skeleton } from "@/components/ui";
import { EmptyMenuIllustration } from "@/components/illustrations";
import { FoodGlyph, foodKindFor, MenuItemCard } from "@/components/pos";
import { mediaUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { sumMoney } from "@/lib/money";
import type { Category, MenuItem } from "@/lib/types";
import type { ModifierGroup } from "@/lib/extras";
import { defaultSelection, groupsFor, selectionValid } from "@/lib/modifiers";
import { searchDishes } from "@/lib/dishSearch";
import { isVegOnlyMatch, vegOf } from "@/lib/menuAdmin";
import { useVegOnly } from "@/lib/vegOnly";
import { VegMark } from "@/components/menu/veg-mark";
import { defaultMods, ModifierPicker, type PickerState } from "./ModifierPicker";
import { defaultVariantId } from "./tickets";
import type { LineMods } from "./types";

/** A required modifier group has no default: a tap must open the picker. Sizes never do (the default size is added). */
function mustChoose(item: MenuItem, groups: ModifierGroup[]) {
  const gs = groupsFor(item, groups);
  return gs.length > 0 && !selectionValid(gs, defaultSelection(gs));
}

/** After an Add, the card's Add button turns into a stepper: keep keyboard focus there (its "+") instead of losing it to the page (C-17). */
function keepFocus(from: Element | null) {
  if (!(from instanceof HTMLElement) || document.activeElement !== from) return;
  const card = from.closest("article");
  requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return;
    const inc = card?.querySelector<HTMLElement>('button[aria-label^="Add one more"], button[aria-label*="add one more" i]');
    (inc ?? (from.isConnected ? from : card?.querySelector<HTMLElement>("button")))?.focus();
  });
}

const LONG_PRESS_MS = 550;

const noop = () => () => {};
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * One dish card. Grid: auto-fill columns of at least 9.5rem (11rem once the menu column is 1000px+), so a counter shows
 * 3-4 dishes per row at 1176 px and 6 at 1920 px; the photo keeps 4:3 but never grows past 130px (UI_REVIEW BA-1).
 * Memoised: only re-renders when its own quantity / lock state changes, never for another dish's line. */
const MenuTile = memo(function MenuTile({ item, category, qty, disabled, soldOut, currency, hasGroups, onPick, onInc, onDec, onMore }: {
  item: MenuItem; category: string | undefined; qty: number; disabled: boolean; soldOut: boolean; currency: string; hasGroups: boolean;
  onPick: (item: MenuItem, from: Element) => void;
  onInc: (item: MenuItem, from: Element) => void;
  onDec: (item: MenuItem) => void;
  /** Long-press / right-click: the dish's options (size, sold out). */
  onMore: (item: MenuItem) => void;
}) {
  const hasVariants = item.variants.length > 0;
  const choices = hasVariants || hasGroups; // lines differ by choice: the card adds, the cart line steps
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  // The default size goes in with one tap; the card says which ("Half · Full +₹180" style meta).
  const def = hasVariants ? item.variants.find((v) => v.id === defaultVariantId(item)) : undefined;
  return (
    <div className="contents" data-dish={item.name}
      onPointerDown={(e) => { if (e.pointerType === "mouse" && e.button !== 0) return; fired.current = false; cancel(); timer.current = setTimeout(() => { fired.current = true; onMore(item); }, LONG_PRESS_MS); }}
      onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel}
      onClickCapture={(e) => { if (fired.current) { e.stopPropagation(); e.preventDefault(); fired.current = false; } }}
      onContextMenu={(e) => { e.preventDefault(); cancel(); onMore(item); }}>
      <MenuItemCard
        name={item.name} price={def ? sumMoney([item.price, def.price_delta]) : item.price} currency={currency} category={category} imageUrl={mediaUrl(item.thumb_url ?? item.image_url)}
        meta={hasVariants ? item.variants.map((v) => v.name).join(" · ") : undefined} foodType={vegOf(item)} description={item.description} qty={qty} disabled={disabled} soldOut={soldOut}
        onAdd={(e: MouseEvent<HTMLButtonElement>) => onPick(item, e.currentTarget)}
        onIncrement={choices ? undefined : (e) => onInc(item, e.currentTarget)}
        onDecrement={choices ? undefined : () => onDec(item)}
      />
    </div>
  );
});

export function MenuSkeleton() {
  return (
    <div role="status" aria-label="Loading menu" className="space-y-4">
      <div className="flex gap-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-11 w-28 shrink-0 rounded-full" />)}</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-52 rounded-2xl" />)}</div>
    </div>
  );
}

export function MenuPanel({ cats, items, groups = [], loading, error, locked, lockedLabel, currency, qtyByItem, onAdd, onDecrement, onRetry, onOpenNew, banner, searchAction, className, isSoldOut, onDishMenu }: {
  cats: Category[]; items: MenuItem[]; loading: boolean; error: string | null;
  /** Modifier groups of the menu (empty = none configured: every tap behaves exactly as before). */
  groups?: ModifierGroup[];
  /** The active ticket is already placed: its cart is read-only. */
  locked: boolean; lockedLabel?: string;
  currency: string;
  qtyByItem: Map<string, number>;
  onAdd: (item: MenuItem, variantId: string | null, from: Element | null, mods?: LineMods) => void;
  /** Remove one of a (variant-less) dish. */
  onDecrement: (item: MenuItem) => void;
  onRetry: () => void;
  onOpenNew: () => void;
  banner?: ReactNode;
  /** Shown beside the search box (the voice-order mic). */
  searchAction?: ReactNode;
  className?: string;
  /** Dishes marked sold out today: dimmed, "Sold out", not addable. */
  isSoldOut?: (item: MenuItem) => boolean;
  /** Long-press / right-click on a dish: its options sheet (choose a size, mark sold out). */
  onDishMenu?: (item: MenuItem, choose: () => void) => void;
}) {
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [chooser, setChooser] = useState<PickerState | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const mac = useSyncExternalStore(noop, isMac, () => false);
  const [vegOnly, setVegOnly] = useVegOnly();
  // The chip only appears when the menu has both veg and other dishes; unmarked and egg dishes are not veg.
  const canVeg = useMemo(() => items.some(isVegOnlyMatch) && !items.every(isVegOnlyMatch), [items]);
  const pool = useMemo(() => (vegOnly && canVeg ? items.filter(isVegOnlyMatch) : items), [items, vegOnly, canVeg]);

  // Cmd/Ctrl+K focuses the search box from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); search.current?.focus(); search.current?.select(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const catName = useMemo(() => new Map(cats.map((c) => [c.id, c.name])), [cats]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of pool) m.set(i.category_id, (m.get(i.category_id) ?? 0) + 1);
    return m;
  }, [pool]);
  const options = useMemo(() => [
    { value: "all", label: "All", icon: <LayoutGrid aria-hidden />, count: pool.length },
    ...cats.map((c) => ({ value: c.id, label: c.name, icon: <FoodGlyph kind={foodKindFor(c.name)} className="size-4" />, count: counts.get(c.id) ?? 0 })),
  ], [cats, pool.length, counts]);
  // Search covers the whole (veg-filtered) menu with Hinglish / Hindi / fuzzy matching and short codes (C-15).
  const soldOutItems = useMemo(() => (isSoldOut ? pool.filter(isSoldOut) : []), [pool, isSoldOut]);
  const shown = useMemo(() => (q.trim() ? searchDishes(pool, q) : pool.filter((i) => cat === "all" || i.category_id === cat)), [pool, cat, q]);

  // Stable handlers: the memoised tiles never re-render because a parent re-rendered.
  // One tap adds the dish (with its default choices when it has modifier groups); the picker opens only for a real choice.
  const soldOutRef = useRef(isSoldOut);
  useEffect(() => { soldOutRef.current = isSoldOut; }, [isSoldOut]);
  const onPick = useCallback((item: MenuItem, from: Element) => {
    if (soldOutRef.current?.(item)) return;
    try { navigator.vibrate?.(10); } catch { /* not supported */ }
    if (mustChoose(item, groups)) setChooser({ item, from, mode: "add" });
    else { onAdd(item, defaultVariantId(item), from, defaultMods(item, groups)); keepFocus(from); }
  }, [onAdd, groups]);
  const onInc = useCallback((item: MenuItem, from: Element) => { onAdd(item, null, from); }, [onAdd]);
  const menuRef = useRef(onDishMenu);
  useEffect(() => { menuRef.current = onDishMenu; });
  const onMore = useCallback((item: MenuItem) => {
    const choose = () => setChooser({ item, from: null, mode: "add" });
    if (menuRef.current) menuRef.current(item, choose); else if (item.variants.length || groupsFor(item, groups).length) choose();
  }, [groups]);

  return (
    <section aria-label="Menu" className={cn("flex min-h-0 min-w-0 flex-col gap-3", className)}>
      {banner}
      {error && <Notice tone="danger" title="Menu unavailable" action={<UiButton size="sm" onClick={onRetry}>Retry</UiButton>}>{error}</Notice>}
      {loading ? <MenuSkeleton />
        : cats.length === 0 && !error ? (
          <EmptyState illustration={<EmptyMenuIllustration />} title="No menu yet"
            hint="Add categories and items first, then they will appear here as photo cards."
            action={<Link href="/menu" className="ch-btn ch-btn--primary ch-btn--lg">Set up the menu</Link>} />
        ) : (
          <>
            <div className="shrink-0 space-y-2.5">
              <div className="flex flex-wrap gap-2">
              <div className="relative min-w-[11rem] flex-1">
                <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-[1.15rem] -translate-y-1/2 text-fg-subtle" />
                <input ref={search} aria-label="Search menu" type="search" placeholder="Search dishes" value={q} onChange={(e) => setQ(e.target.value)}
                  className="h-12 w-full rounded-2xl border border-border bg-surface pl-11 pr-20 text-[0.95rem] text-fg shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-fg-subtle focus:border-primary focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_25%,transparent)] [&::-webkit-search-cancel-button]:hidden" />
                {q ? (
                  <IconButton label="Clear search" icon={<X aria-hidden />} onClick={() => { setQ(""); search.current?.focus(); }} className="absolute right-1 top-1/2 -translate-y-1/2" />
                ) : (
                  <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-1 md:flex"><Kbd>{mac ? "⌘" : "Ctrl"}</Kbd><Kbd>K</Kbd></span>
                )}
              </div>
              {searchAction}
              </div>
              <div className="flex items-center gap-2">
                {canVeg && (
                  <button type="button" aria-pressed={vegOnly} onClick={() => setVegOnly(!vegOnly)} data-testid="veg-only"
                    className={cn("inline-flex h-11 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-semibold transition-colors",
                      vegOnly ? "border-[var(--c-veg)] bg-surface text-fg ring-1 ring-[var(--c-veg)]" : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg")}>
                    <VegMark kind="veg" decorative />Veg only
                  </button>
                )}
                <div className="min-w-0 flex-1"><PillTabs label="Categories" value={cat} onChange={(v) => { setCat(v); setQ(""); }} options={options} /></div>
              </div>
            </div>
            {soldOutItems.length > 0 && onDishMenu && (
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-fg-muted" data-testid="sold-out-row">
                <span className="font-semibold">Sold out today:</span>
                {soldOutItems.slice(0, 8).map((i) => (
                  <button key={i.id} type="button" onClick={() => onDishMenu(i, () => {})} className="inline-flex min-h-11 items-center rounded-full border border-border bg-surface-2 px-3 font-semibold text-fg-muted hover:bg-surface">{i.name}</button>
                ))}
              </div>
            )}
            {locked && (
              <div role="status" className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-surface-2/70 px-4 py-2.5 text-sm text-fg-muted">
                <span className="flex items-center gap-2"><Lock aria-hidden className="size-4" />{lockedLabel ?? "This order"} is billed. To add more, start another order.</span>
                <UiButton onClick={onOpenNew}>Start another order</UiButton>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto pb-2 pr-1 scrollbar-thin @container">
              {shown.length === 0 ? (
                <EmptyState compact icon={<Search />} title={q ? "No matching dishes" : vegOnly && canVeg ? "No veg dishes here" : "Nothing in this category"}
                  hint={vegOnly && canVeg ? "Turn off Veg only to see every dish." : q ? "Try a shorter word, e.g. \u201cpaneer\u201d or \u201cchai\u201d." : "Add dishes on the Menu page."} />
              ) : (
                <ul data-testid="menu-grid" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9.5rem),1fr))] gap-3 pt-1 @min-[1000px]:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
                  {shown.map((i) => (
                    <li key={i.id} className="contents">
                      <MenuTile item={i} category={catName.get(i.category_id)} qty={qtyByItem.get(i.id) ?? 0} disabled={locked} soldOut={!!isSoldOut?.(i)} currency={currency} hasGroups={groupsFor(i, groups).length > 0}
                        onPick={onPick} onInc={onInc} onDec={onDecrement} onMore={onMore} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      <ModifierPicker state={chooser} groups={groups} currency={currency} onClose={() => setChooser(null)}
        onPick={(v, mods) => { if (chooser) onAdd(chooser.item, v, chooser.from, mods); setChooser(null); }} />
    </section>
  );
}
