"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button, Dialog } from "@chilli/ui";
import { FoodImage } from "@/components/pos";
import { Money } from "@/components/ui";
import { mediaUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { ModifierGroup } from "@/lib/extras";
import { ruleText } from "@/lib/menuAdmin";
import { chosenOf, defaultSelection, deltaLabel, groupProblem, groupsFor, selectionValid, toggleOption, unitWithModifiers, type Selection } from "@/lib/modifiers";
import { formatCurrency, sumMoney } from "@/lib/money";
import type { MenuItem } from "@/lib/types";
import type { LineMods } from "./types";
import { defaultVariantId, sizeChoices, variantDelta } from "./tickets";

/** Default modifier choice of a dish (no tap), or undefined for a dish without groups (the line stays exactly as before). */
export function defaultMods(item: MenuItem, groups: ModifierGroup[]): LineMods | undefined {
  const gs = groupsFor(item, groups);
  return gs.length ? chosenOf(gs, defaultSelection(gs)) : undefined;
}

export interface PickerState { item: MenuItem; from: Element | null; mode: "add" | "edit"; variantId?: string | null; selected?: string[] }

/**
 * The option picker: the size (Half / Full, pre-selected on the default, the cheapest) and the modifier groups (pre-selected with
 * their defaults), one "Add" button. There is no "Regular" row for a dish with sizes (C-03): a tap on the dish card adds the
 * default size without this dialog; the dialog opens only for a required group without a default, a long-press on the card, or
 * "Change options" on a cart line.
 */
export function ModifierPicker({ state, groups, currency, onClose, onPick }: {
  state: PickerState | null; groups: ModifierGroup[]; currency: string; onClose: () => void;
  onPick: (variantId: string | null, mods: LineMods | undefined) => void;
}) {
  // Keep the last state mounted while the exit animation runs; reset the choice when another dish opens.
  const [last, setLast] = useState<PickerState | null>(null);
  const [sel, setSel] = useState<Selection>({});
  const [tried, setTried] = useState(false);
  const [variant, setVariant] = useState<string | null>(null);
  if (state && state !== last) {
    setLast(state);
    setVariant(state.variantId ?? defaultVariantId(state.item));
    const gs = groupsFor(state.item, groups);
    const init = defaultSelection(gs);
    if (state.selected) { const ids = new Set(state.selected); for (const g of gs) init[g.id] = g.options.filter((o) => ids.has(o.id)).map((o) => o.id); }
    setSel(init); setTried(false);
  }
  const s = state ?? last;
  const it = s?.item;
  const gs = it ? groupsFor(it, groups) : [];
  const valid = selectionValid(gs, sel);
  const mods = gs.length ? chosenOf(gs, sel) : undefined;
  const editing = s?.mode === "edit";
  const showVariants = !!it && it.variants.length > 0;

  const pick = (variantId: string | null) => {
    if (!valid) { setTried(true); return; }
    onPick(variantId, mods);
  };
  const baseOf = (variantId: string | null) => (it ? sumMoney([it.price, it.variants.find((v) => v.id === variantId)?.price_delta ?? "0"]) : "0");
  const total = (variantId: string | null) => unitWithModifiers(baseOf(variantId), mods?.deltaPaise ?? 0);

  return (
    <Dialog open={state !== null} onOpenChange={(o) => { if (!o) onClose(); }} title={it?.name ?? "Choose an option"}
      description={editing ? "Change the choices for this line." : "Check the choices, then add it to the order."}
      footer={it ? (
        <Button variant="primary" className="w-full" size="lg" iconStart={<Check />} onClick={() => pick(showVariants ? variant : null)} data-testid="picker-confirm">
          {editing ? "Save choices" : `Add to order · ${formatCurrency(total(showVariants ? variant : null), currency)}`}
        </Button>
      ) : undefined}>
      {it && (
        <div className="space-y-4 pb-3">
          {!gs.length && !editing ? <FoodImage src={mediaUrl(it.image_url ?? it.thumb_url)} name={it.name} className="aspect-[16/9] w-full rounded-2xl" /> : null}
          {showVariants && (
            <fieldset className="space-y-2" data-testid="picker-size">
              <legend className="text-sm font-semibold text-fg">Size</legend>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Size">
                {sizeChoices(it).map((v) => {
                  const on = v.id === variant;
                  const d = variantDelta(it, v.id);
                  return (
                    <button key={v.id ?? "regular"} type="button" role="radio" aria-checked={on} onClick={() => setVariant(v.id)}
                      className={cn("flex min-h-14 flex-col items-start justify-center rounded-xl border px-3 text-left transition-colors active:scale-[0.98]",
                        on ? "border-2 border-primary bg-primary-soft text-primary-soft-fg" : "border-border-strong bg-surface text-fg hover:bg-surface-2")}>
                      <span className="flex items-center gap-1.5 font-semibold">{on && <Check aria-hidden className="size-4" />}{v.name}{d && <span className="tnum text-xs font-medium opacity-80">{d}</span>}</span>
                      <Money value={total(v.id)} currency={currency} />
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
          {gs.map((g) => {
            const chosen = sel[g.id] ?? [];
            const problem = tried ? groupProblem(g, chosen) : null;
            return (
              <fieldset key={g.id} className="space-y-2" data-testid="picker-group">
                <legend className="flex w-full items-baseline justify-between gap-2 text-sm font-semibold text-fg">{g.name}<span className="text-xs font-medium text-fg-muted">{ruleText(g)}</span></legend>
                <div className="flex flex-wrap gap-2">
                  {g.options.filter((o) => o.is_active).sort((a, b) => a.sort_order - b.sort_order).map((o) => {
                    const on = chosen.includes(o.id);
                    return (
                      <button key={o.id} type="button" aria-pressed={on} onClick={() => setSel((x) => ({ ...x, [g.id]: toggleOption(g, x[g.id] ?? [], o.id) }))}
                        className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-sm font-semibold transition-colors",
                          on ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border-strong bg-surface text-fg hover:bg-surface-2")}>
                        {on && <Check aria-hidden className="size-4" />}{o.name}{deltaLabel(o) && <span className="tnum text-xs font-medium opacity-80">{deltaLabel(o)}</span>}
                      </button>
                    );
                  })}
                </div>
                {problem && <p role="alert" className="text-sm font-medium text-danger-fg">{problem}</p>}
              </fieldset>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
