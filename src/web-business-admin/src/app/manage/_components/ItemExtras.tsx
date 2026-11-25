"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button, Checkbox, IconButton, Input, Select, Switch } from "@chilli/ui";
import { api } from "@/lib/api";
import { extras, type ModifierGroup } from "@/lib/extras";
import { ruleText } from "@/lib/menuAdmin";
import type { MenuItem } from "@/lib/types";

export interface ComboRow { key: string; item_id: string; variant_id: string | null; quantity: string }
let seq = 0;
export const comboRow = (p: Partial<ComboRow> = {}): ComboRow => ({ key: `c${++seq}`, item_id: "", variant_id: null, quantity: "1", ...p });
export const comboKey = (rows: ComboRow[]) => JSON.stringify(rows.filter((r) => r.item_id).map((r) => [r.item_id, r.variant_id, Number(r.quantity) || 1]));
export const groupsKey = (ids: string[]) => JSON.stringify(ids);

export interface ItemExtrasState {
  /** null = this server has no modifier groups / combos (older pos-service): the section is hidden. */
  groups: ModifierGroup[] | null; items: MenuItem[];
  groupIds: string[]; groupBase: string;
  isCombo: boolean; combo: ComboRow[]; comboBase: string;
}
export const EMPTY_EXTRAS: ItemExtrasState = { groups: null, items: [], groupIds: [], groupBase: "[]", isCombo: false, combo: [], comboBase: "[]" };

/** Loads what the item editor needs for modifier groups and combo components (when the dialog opens). */
export function useItemExtras(open: boolean, item: MenuItem | null): [ItemExtrasState, (p: Partial<ItemExtrasState>) => void] {
  const [s, setS] = useState<ItemExtrasState>(EMPTY_EXTRAS);
  useEffect(() => {
    if (!open) return;
    let off = false;
    void Promise.resolve().then(() => { if (!off) setS(EMPTY_EXTRAS); });
    Promise.all([extras.modifierGroups(true), item?.is_combo ? extras.combos() : Promise.resolve([]), api.items()]).then(([groups, combos, items]) => {
      if (off) return;
      const ids = item?.modifier_group_ids ?? [];
      const mine = item ? combos.find((c) => c.item_id === item.id) : undefined;
      const rows = mine ? mine.components.map((c) => comboRow({ item_id: c.item_id, variant_id: c.variant_id, quantity: String(c.quantity) })) : [];
      setS({ groups, items, groupIds: ids, groupBase: groupsKey(ids), isCombo: rows.length > 0, combo: rows, comboBase: comboKey(rows) });
    }).catch(() => { /* older server: no section */ });
    return () => { off = true; };
  }, [open, item]);
  return [s, (p) => setS((x) => ({ ...x, ...p }))];
}

/** Saves what changed (after the item itself is saved). Returns an error message or null. */
export async function saveItemExtras(itemId: string, s: ItemExtrasState): Promise<string | null> {
  if (s.groups === null) return null;
  try {
    if (groupsKey(s.groupIds) !== s.groupBase) await extras.setItemModifierGroups(itemId, s.groupIds);
    const rows = s.isCombo ? s.combo : [];
    if (comboKey(rows) !== s.comboBase) await extras.setCombo(itemId, rows.filter((r) => r.item_id).map((r) => ({ item_id: r.item_id, variant_id: r.variant_id, quantity: Math.max(1, Number(r.quantity) || 1) })));
    return null;
  } catch (e) { return e instanceof Error ? e.message : "Could not save the modifier groups or combo"; }
}

/** Item editor sections: attach modifier groups (ordered) and mark the dish as a combo of other dishes. */
export function ItemExtrasFields({ s, set, itemId }: { s: ItemExtrasState; set: (p: Partial<ItemExtrasState>) => void; itemId: string | null }) {
  if (s.groups === null) return null;
  const active = s.groups.filter((g) => g.is_active || s.groupIds.includes(g.id));
  const chosen = s.groupIds.map((id) => s.groups!.find((g) => g.id === id)).filter((g): g is ModifierGroup => !!g);
  const move = (i: number, d: -1 | 1) => { const ids = [...s.groupIds]; const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; set({ groupIds: ids }); };
  const others = s.items.filter((i) => i.id !== itemId && !i.is_combo);
  return (
    <>
      <fieldset className="space-y-2" data-testid="item-modifier-groups">
        <legend className="text-sm font-semibold text-fg">Modifier groups</legend>
        {active.length === 0 ? (
          <p className="text-sm text-fg-muted">No groups yet. <Link href="/modifiers" className="font-semibold text-primary underline-offset-2 hover:underline">Create one</Link> (for example Spice level) and attach it here.</p>
        ) : (
          <>
            <div className="rounded-xl border border-border px-2">
              {active.map((g) => (
                <Checkbox key={g.id} label={`${g.name} (${ruleText(g)})`} checked={s.groupIds.includes(g.id)}
                  onChange={(e) => set({ groupIds: e.target.checked ? [...s.groupIds, g.id] : s.groupIds.filter((x) => x !== g.id) })} />
              ))}
            </div>
            {chosen.length > 1 && (
              <ol className="space-y-1" aria-label="Order at the counter">
                {chosen.map((g, i) => (
                  <li key={g.id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 pl-3 text-sm">
                    <span>{i + 1}. {g.name}</span>
                    <span className="flex">
                      <IconButton variant="ghost" label={`Move ${g.name} up`} icon={<ArrowUp />} disabled={i === 0} onClick={() => move(i, -1)} />
                      <IconButton variant="ghost" label={`Move ${g.name} down`} icon={<ArrowDown />} disabled={i === chosen.length - 1} onClick={() => move(i, 1)} />
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <p className="text-xs text-fg-muted">The counter uses each group&apos;s default options, so a dish with defaults is still added with one tap.</p>
          </>
        )}
      </fieldset>

      <fieldset className="space-y-2" data-testid="item-combo">
        <legend className="text-sm font-semibold text-fg">Combo</legend>
        <Switch label="This dish is a combo (meal deal)" checked={s.isCombo} onChange={(e) => set({ isCombo: e.target.checked, combo: e.target.checked && s.combo.length === 0 ? [comboRow()] : s.combo })} />
        {s.isCombo && (
          <>
            <p className="text-xs text-fg-muted">The dish price above is the combo price. The kitchen ticket lists the parts below.</p>
            {s.combo.map((r, i) => {
              const it = others.find((x) => x.id === r.item_id);
              return (
                <div key={r.key} className="grid grid-cols-[1fr_4.5rem_2.75rem] items-start gap-2" data-testid="combo-row">
                  <Select label={`Part ${i + 1}`} value={r.item_id} onChange={(e) => set({ combo: s.combo.map((x) => (x.key === r.key ? { ...x, item_id: e.target.value, variant_id: null } : x)) })}>
                    <option value="">Choose a dish</option>
                    {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </Select>
                  <Input label="Qty" inputMode="numeric" value={r.quantity} onChange={(e) => set({ combo: s.combo.map((x) => (x.key === r.key ? { ...x, quantity: e.target.value.replace(/\D/g, "").slice(0, 2) } : x)) })} />
                  <div className="pt-7"><IconButton variant="ghost" label={`Remove part ${i + 1}`} icon={<X />} onClick={() => set({ combo: s.combo.filter((x) => x.key !== r.key) })} /></div>
                  {it && it.variants.length > 0 && (
                    <div className="col-span-3">
                      <Select label={`Option for ${it.name}`} value={r.variant_id ?? ""} onChange={(e) => set({ combo: s.combo.map((x) => (x.key === r.key ? { ...x, variant_id: e.target.value || null } : x)) })}>
                        <option value="">Regular</option>
                        {it.variants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </Select>
                    </div>
                  )}
                </div>
              );
            })}
            <Button iconStart={<Plus />} onClick={() => set({ combo: [...s.combo, comboRow()] })}>Add part</Button>
          </>
        )}
      </fieldset>
    </>
  );
}
