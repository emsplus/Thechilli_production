"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@chilli/ui";
import { InlineInput, InlineSelect } from "@/components/inline-fields";
import { DECIMAL_RE, unitsFor } from "@/lib/units";
import type { InventoryItem } from "@/lib/types";

export interface RecipeRow { key: number; item_id: string; quantity: string; unit: string }
let seq = 1000;
export const blankRow = (): RecipeRow => ({ key: seq++, item_id: "", quantity: "", unit: "g" });
const touched = (r: RecipeRow) => !!r.item_id || r.quantity.trim() !== "";
const complete = (r: RecipeRow) => !!r.item_id && DECIMAL_RE.test(r.quantity.trim()) && Number(r.quantity) > 0;

/** Rows the owner actually filled in (untouched blank rows are ignored). */
export const filledRows = (rows: RecipeRow[]) => rows.filter(touched);
/** What would be saved, as a comparable string: lets the dialog skip saving an unchanged recipe (no new version). */
export const recipeKey = (rows: RecipeRow[]) => JSON.stringify(filledRows(rows).map((r) => [r.item_id, r.quantity.trim(), r.unit]));
/** A message when the filled rows cannot be saved yet, else null. */
export function recipeProblem(rows: RecipeRow[]): string | null {
  const f = filledRows(rows);
  if (f.some((r) => !complete(r))) return "Recipe: choose an ingredient and a quantity above 0 on every row, or remove the empty row.";
  const ids = f.map((r) => r.item_id);
  if (ids.some((id, i) => ids.indexOf(id) !== i)) return "Recipe: each ingredient can only be listed once.";
  return null;
}

/**
 * The recipe of one portion, inside the menu item dialog: pick stock items and the quantity each portion uses.
 * Every sale then deducts these from stock. Saved together with the dish (Manage > Recipes shows and edits the same data).
 */
export function RecipeFields({ rows, onChange, inv, onlyOneRecipe }: { rows: RecipeRow[]; onChange: (r: RecipeRow[]) => void; inv: InventoryItem[] | null; onlyOneRecipe?: boolean }) {
  const byId = new Map((inv ?? []).map((i) => [i.id, i]));
  const patch = (key: number, p: Partial<RecipeRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const dupes = new Set(rows.map((r) => r.item_id).filter((id, i, a) => id && a.indexOf(id) !== i));
  return (
    <fieldset className="space-y-3" data-testid="recipe-fields">
      <legend className="text-sm font-medium text-fg">Recipe (stock used per portion)</legend>
      {inv === null ? <p className="text-sm text-fg-muted">Loading stock items…</p>
        : inv.length === 0 ? <p className="text-sm text-fg-muted">No stock items yet. Add them in Manage &gt; Inventory (or scan a supplier bill), then come back to set what this dish uses. Recipes are optional.</p>
          : (
            <>
              {rows.map((r, i) => {
                const it = byId.get(r.item_id);
                return (
                  <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-xl bg-surface-2/60 p-2.5 sm:grid-cols-[minmax(0,1fr)_6rem_5.5rem_auto]">
                    <InlineSelect aria-label={`Recipe ingredient ${i + 1}`} value={r.item_id} wrapperClassName="col-span-2 sm:col-span-1" error={dupes.has(r.item_id) ? "Already in this recipe" : undefined}
                      onChange={(e) => patch(r.key, { item_id: e.target.value, unit: byId.get(e.target.value)?.base_unit ?? "g" })}>
                      <option value="">Ingredient…</option>{inv.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </InlineSelect>
                    <InlineInput aria-label={`Recipe quantity ${i + 1}`} inputMode="decimal" placeholder="Qty" value={r.quantity} onChange={(e) => patch(r.key, { quantity: e.target.value })}
                      error={r.quantity && !DECIMAL_RE.test(r.quantity.trim()) ? "Number" : undefined} />
                    <InlineSelect aria-label={`Recipe unit ${i + 1}`} value={r.unit} onChange={(e) => patch(r.key, { unit: e.target.value })} disabled={!it}>
                      {unitsFor(it?.base_unit).map((u) => <option key={u}>{u}</option>)}
                    </InlineSelect>
                    <IconButton label={`Remove recipe ingredient ${i + 1}`} icon={<Trash2 />} disabled={rows.length === 1 && !touched(r)} onClick={() => onChange(rows.length === 1 ? [blankRow()] : rows.filter((x) => x.key !== r.key))} />
                  </div>
                );
              })}
              <Button variant="secondary" iconStart={<Plus />} onClick={() => onChange([...rows, blankRow()])}>Add ingredient</Button>
              <p className="text-xs text-fg-subtle">Quantities are for ONE portion. Each sale takes them out of stock. {onlyOneRecipe ? "A recipe belongs to the dish, so every option or size uses the same amounts. " : ""}Leave empty if you do not track this dish in stock.</p>
            </>
          )}
    </fieldset>
  );
}
