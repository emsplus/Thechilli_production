"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, ChefHat, History, Plus, Save, Search, Sparkles, Trash2, UtensilsCrossed } from "lucide-react";
import { Badge, Button, IconButton, Input, Notice, Sheet } from "@chilli/ui";
import { InlineInput, InlineSelect } from "@/components/inline-fields";
import { Card, CardHeader, EmptyState, Money, Skeleton, toast } from "@/components/ui";
import { FoodImage } from "@/components/pos/food-image";
import { api, ApiError, mediaUrl } from "@/lib/api";
import { plainAiError } from "@/lib/aiErrors";
import { formatDateTime } from "@/lib/datetime";
import { DECIMAL_RE, factorToBase, prettyQty, unitsFor } from "@/lib/units";
import { useLoader } from "@/lib/useLoader";
import { uuid } from "@/lib/uuid";
import type { InventoryItem, RecipeVersion } from "@/lib/types";
import { nextKey, fromServer, useRecipeDrafts, type StoredDraft } from "./recipe-drafts";
import { RecipeAiPanel } from "./RecipeAiPanel";

const fetchAll = async () => {
  const [menu, inv, recipes] = await Promise.all([api.items(), api.inventoryItems(), api.recipes()]);
  return { menu, inv, recipes };
};
const blank = (): Row => ({ key: nextKey(), item_id: "", quantity: "", unit: "g" });
interface Row { key: number; item_id: string; quantity: string; unit: string }

export function RecipesTab({ goto, onChanged }: { goto: (tab: string) => void; onChanged?: () => void }) {
  const { data, error, loading, reload } = useLoader(fetchAll);
  const { drafts, put: putDraft, patch: patchDraft, remove: removeDrafts } = useRecipeDrafts();
  const [aiBusy, setAiBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const [menuId, setMenuId] = useState("");
  const [rows, setRows] = useState<Row[]>(() => [blank()]);
  const [portions, setPortions] = useState("10");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [focusKey, setFocusKey] = useState<number | null>(null);

  const inv = useMemo(() => new Map((data?.inv ?? []).map((i) => [i.id, i])), [data]);
  const current = data?.recipes.find((r) => r.menu_item_id === menuId);
  const menuItem = data?.menu.find((m) => m.id === menuId);
  const hasRecipe = (id: string) => !!data?.recipes.some((r) => r.menu_item_id === id);
  const withoutRecipe = data ? data.menu.filter((m) => !data.recipes.some((r) => r.menu_item_id === m.id)).length : 0;

  const draft: StoredDraft | undefined = menuId ? drafts[menuId] : undefined;
  const hasDraft = !!draft;
  // Edits to an AI draft are kept with the draft (so a half-reviewed draft survives leaving the dish or the page).
  useEffect(() => { if (menuId && hasDraft) patchDraft(menuId, { rows }); }, [rows, menuId, hasDraft, patchDraft]);

  function chooseMenu(id: string, useDraft = true) {
    setMenuId(id); setErr(null);
    const rec = data?.recipes.find((r) => r.menu_item_id === id);
    if (useDraft && drafts[id]) { setRows(drafts[id].rows.length ? drafts[id].rows : [blank()]); return; }
    setRows(rec ? rec.ingredients.map((g) => ({ key: nextKey(), item_id: g.item_id, quantity: String(+Number(g.quantity).toFixed(3)), unit: inv.get(g.item_id)?.base_unit ?? "g" })) : [blank()]);
  }
  /** Fills the rows from another dish's recipe (a new dish that is "the same but different"); nothing is saved until Save. */
  function copyFrom(id: string) {
    const rec = data?.recipes.find((r) => r.menu_item_id === id);
    if (!rec) return;
    setRows(rec.ingredients.map((g) => ({ key: nextKey(), item_id: g.item_id, quantity: String(+Number(g.quantity).toFixed(3)), unit: inv.get(g.item_id)?.base_unit ?? "g" })));
    toast.message(`Copied from ${data?.menu.find((m) => m.id === id)?.name ?? "that dish"}. Adjust the quantities, then save.`);
  }
  /** Next dish that still has no recipe (after the current one), wrapping round; null when none are left. */
  const nextMissing = (after?: string) => {
    const list = data?.menu.filter((m) => !hasRecipe(m.id) && m.id !== after) ?? [];
    return list[0] ?? null;
  };
  const patch = (key: number, p: Partial<Row>) => setRows((x) => x.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const rowOk = (r: Row) => !!r.item_id && DECIMAL_RE.test(r.quantity.trim()) && Number(r.quantity) > 0;
  const dupes = new Set(rows.map((r) => r.item_id).filter((id, i, a) => id && a.indexOf(id) !== i));
  const valid = !!menuId && rows.length > 0 && rows.every(rowOk) && dupes.size === 0;
  const nPortions = Math.max(0, Math.min(100000, Math.floor(Number(portions) || 0)));

  const usage = rows.filter(rowOk).map((r) => {
    const it = inv.get(r.item_id) as InventoryItem;
    const perPortion = Number(r.quantity) * factorToBase(r.unit);
    return { key: r.key, it, perPortion, total: perPortion * nPortions, canMake: perPortion > 0 ? Math.floor(Math.max(0, Number(it.balance)) / perPortion) : Infinity };
  });
  // Estimate from the last purchase price of each ingredient (per base unit); display only.
  const costOf = usage.map((u) => { const c = u.it.last_received?.unit_cost; return c == null ? null : u.perPortion * Number(c); });
  const costGaps = costOf.filter((c) => c === null).length;
  const cost = usage.length && costOf.some((c) => c !== null) ? costOf.reduce<number>((a, c) => a + (c ?? 0), 0) : null;
  const maxPortions = usage.length ? Math.min(...usage.map((u) => u.canMake)) : null;
  const limiting = usage.find((u) => u.canMake === maxPortions);

  function chooseMenuAfterSave(id: string) { chooseMenu(id); }
  async function save() {
    setSaving(true); setErr(null);
    try {
      await api.saveRecipe({ menu_item_id: menuId, ingredients: rows.map((r) => ({ item_id: r.item_id, quantity: r.quantity.trim(), unit: r.unit })) });
      toast.success(`Recipe saved as version ${(current?.version ?? 0) + 1}`);
      removeDrafts([menuId]);
      const nxt = !current ? nextMissing(menuId) : null;
      await reload(); onChanged?.();
      if (nxt) { chooseMenuAfterSave(nxt.id); }
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not save the recipe"); } finally { setSaving(false); }
  }

  /** "Suggest recipe with AI" for the open dish: fills the rows as a DRAFT (nothing is saved). */
  async function suggestOne() {
    setAiBusy(true); setErr(null);
    try {
      const res = await api.aiRecipeDrafts([menuId]);
      const d = res.drafts[0];
      if (!d || (!d.ingredients.length && !d.missing.length)) { toast.message("The AI had no suggestion for this dish. Add the ingredients yourself."); return; }
      const sd = fromServer(d);
      putDraft(sd);
      setRows(sd.rows.length ? sd.rows : [blank()]);
    } catch (e) { setErr(e instanceof ApiError ? plainAiError(e.message) : "Could not get a suggestion"); } finally { setAiBusy(false); }
  }
  /** Creates the stock items the AI named (opening stock 0) and turns them into ingredient rows of this draft. */
  async function createMissing() {
    if (!draft?.missing.length) return;
    setAiBusy(true); setErr(null);
    try {
      const r = await api.bulkCreateItems({ idempotency_key: uuid(), items: draft.missing.map((m) => ({ name: m.name, base_unit: m.base_unit, reorder_level: "0" })) });
      const byName = new Map([...r.created, ...r.existing].map((i) => [i.name.toLowerCase(), i]));
      const add = draft.missing.flatMap((m) => { const it = byName.get(m.name.toLowerCase()); return it && !rows.some((x) => x.item_id === it.id) ? [{ key: nextKey(), item_id: it.id, quantity: m.quantity, unit: it.base_unit }] : []; });
      const kept = rows.filter((x) => x.item_id || x.quantity.trim());
      setRows([...kept, ...add]);
      patchDraft(menuId, { missing: [] });
      await reload(); onChanged?.();
      toast.success(`${r.created.length} stock item${r.created.length === 1 ? "" : "s"} created with 0 in stock`);
    } catch (e) { setErr(e instanceof ApiError ? plainAiError(e.message) : "Could not create the stock items"); } finally { setAiBusy(false); }
  }

  const missing = !loading && data && (!data.menu.length || !data.inv.length);

  return (
    <>
      <p className="mb-4 text-sm text-fg-muted">Say what goes into one portion. Every sale then deducts those ingredients from stock automatically.{data && !data.inv.length && " Recipes are optional: add them when you want sales to deduct stock automatically."}</p>
      {error && <div className="mb-4"><Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void reload()}>Retry</Button>}>{error}</Notice></div>}

      {loading && <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]" role="status" aria-label="Loading"><Skeleton className="h-96 rounded-xl" /><Skeleton className="h-72 rounded-xl" /></div>}

      {missing && (
        <Card>
          <EmptyState icon={<ChefHat />} title={!data.menu.length ? "Add menu items first" : "Add inventory items first"}
            hint={!data.menu.length && !data.inv.length ? "A recipe links a menu item to the ingredients you stock. You need both before you can build one." : !data.menu.length ? "Recipes are attached to dishes on your menu." : "Recipes use the ingredients you track in inventory. There are no stock items yet: add them in Inventory or scan a supplier bill, and AI can then draft your recipes from that list."}
            action={<div className="flex flex-wrap justify-center gap-2">
              {!data.menu.length && <Button variant="primary" iconStart={<UtensilsCrossed />} onClick={() => goto("menu")}>Go to menu</Button>}
            </div>} />
        </Card>
      )}

      {data && !missing && (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-4">
            {menuId && (
              <Card>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => { setMenuId(""); setErr(null); }}>All dishes</Button>
                  {nextMissing(menuId) && <Button size="sm" variant="secondary" onClick={() => chooseMenu(nextMissing(menuId)!.id)}>Next dish without a recipe ({data.menu.filter((m) => !hasRecipe(m.id) && m.id !== menuId).length} left) <ArrowRight aria-hidden /></Button>}
                  {!current && data.recipes.length > 0 && (
                    <InlineSelect aria-label="Copy recipe from another dish" value="" wrapperClassName="min-w-48 flex-1 sm:max-w-xs" onChange={(e) => e.target.value && copyFrom(e.target.value)}>
                      <option value="">Copy recipe from…</option>
                      {data.menu.filter((m) => hasRecipe(m.id) && m.id !== menuId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </InlineSelect>
                  )}
                </div>
              </Card>
            )}

            {!menuId && <RecipeAiPanel menu={data.menu} hasRecipe={hasRecipe} inv={data.inv} drafts={drafts} putDraft={putDraft} patchDraft={patchDraft} removeDrafts={removeDrafts} onOpen={chooseMenu}
              onSaved={async () => { await reload(); onChanged?.(); }} />}

            {!menuId && (
              <Card padded={false}>
                <div className="border-b border-border px-4 py-3 sm:px-5">
                  <h3 className="font-display text-base font-semibold">Your dishes</h3>
                  <p className="text-sm text-fg-muted">{withoutRecipe > 0 ? `${withoutRecipe} of ${data.menu.length} have no recipe, so selling them does not use up stock.` : "Every dish has a recipe."}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
                  <InlineInput aria-label="Search dishes" placeholder="Search dishes" leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} wrapperClassName="min-w-0 flex-1 basis-48" />
                  {withoutRecipe > 0 && <Button size="sm" variant={onlyMissing ? "primary" : "secondary"} aria-pressed={onlyMissing} onClick={() => setOnlyMissing((v) => !v)}>No recipe ({withoutRecipe})</Button>}
                  {withoutRecipe > 0 && <Button size="sm" variant="secondary" onClick={() => chooseMenu(nextMissing()!.id)}>Start with the first <ArrowRight aria-hidden /></Button>}
                </div>
                <ul className="divide-y divide-border">
                  {[...data.menu].filter((m) => (!onlyMissing || !hasRecipe(m.id)) && m.name.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => Number(data.recipes.some((r) => r.menu_item_id === a.id)) - Number(data.recipes.some((r) => r.menu_item_id === b.id))).map((m) => {
                    const rec = data.recipes.find((r) => r.menu_item_id === m.id);
                    return (
                      <li key={m.id} className={rec ? undefined : "bg-warning-soft/40"}>
                        <button onClick={() => chooseMenu(m.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2/60 sm:px-5">
                          <span className="flex min-w-0 items-center gap-3"><FoodImage src={mediaUrl(m.thumb_url)} name={m.name} variant="thumb" className="size-10 shrink-0 rounded-lg" /><span className="truncate font-medium text-fg">{m.name}</span></span>
                          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                            {drafts[m.id] && <Badge tone="info">{<Sparkles />}AI draft</Badge>}
                            {rec ? <Badge tone="primary">{<History />}v{rec.version} · {rec.ingredients.length} ingredient{rec.ingredients.length === 1 ? "" : "s"}</Badge> : !drafts[m.id] && <span className="inline-flex h-8 items-center gap-1 rounded-full bg-primary px-3 text-sm font-semibold text-primary-fg shadow-xs"><Plus aria-hidden className="size-4" />Add recipe</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}

            {menuId && (
              <Card>
                <CardHeader title={menuItem?.name ?? "Ingredients"} description="Quantities for ONE portion."
                  action={current ? <Button size="sm" variant="secondary" iconStart={<History />} onClick={() => setHistory(true)}>Version {current.version} · History</Button> : <Badge tone="warning">{<AlertTriangle />}No recipe yet</Badge>} />
                {!current && !draft && <div className="mb-4"><Notice tone="info">Until you save a recipe, selling this dish will not deduct any stock.</Notice></div>}
                {draft && (
                  <div className="mb-4"><Notice tone="warning" title="AI draft - check quantities"
                    action={<Button size="sm" variant="secondary" onClick={() => { removeDrafts([menuId]); chooseMenu(menuId, false); }}>Discard draft</Button>}>
                    Suggested from your stock list for one portion. Nothing is saved until you press Save.
                    {draft.warnings.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs">{draft.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
                  </Notice></div>
                )}
                {draft && draft.missing.length > 0 && (
                  <div className="mb-4"><Notice tone="info" title="Needs a new stock item">
                    <ul className="list-disc pl-5">{draft.missing.map((m) => <li key={m.name}>{m.name} ({m.quantity} {m.base_unit} per portion)</li>)}</ul>
                    <p className="mt-1 text-xs">They are created with 0 in stock and added to this recipe.</p>
                    <Button size="sm" variant="secondary" className="mt-2" loading={aiBusy} iconStart={<Plus />} onClick={() => void createMissing()}>Create the missing stock items</Button>
                  </Notice></div>
                )}
                {err && <div className="mb-4"><Notice tone="danger">{err}</Notice></div>}
                <ul className="space-y-3">
                  {rows.map((r, i) => {
                    const it = inv.get(r.item_id);
                    return (
                      <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-xl bg-surface-2/60 p-3 sm:grid-cols-[minmax(0,1fr)_6rem_6rem_auto]">
                        <InlineSelect aria-label={`Ingredient ${i + 1}`} value={r.item_id} ref={r.key === focusKey ? (el: HTMLSelectElement | null) => { if (el) { el.focus(); setFocusKey(null); } } : undefined} wrapperClassName="col-span-2 sm:col-span-1"
                          error={dupes.has(r.item_id) ? "Already used in this recipe" : undefined}
                          onChange={(e) => patch(r.key, { item_id: e.target.value, unit: inv.get(e.target.value)?.base_unit ?? "g" })}>
                          <option value="">Ingredient…</option>{data.inv.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </InlineSelect>
                        <InlineInput aria-label={`Quantity ${i + 1}`} inputMode="decimal" placeholder="Qty" value={r.quantity} onChange={(e) => patch(r.key, { quantity: e.target.value })}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (rowOk(r) && i === rows.length - 1) { const b = blank(); setRows((x) => [...x, b]); setFocusKey(b.key); } else if (rowOk(r) && valid) void save(); } }}
                          error={r.quantity && !DECIMAL_RE.test(r.quantity.trim()) ? "Number" : undefined} />
                        <InlineSelect aria-label={`Unit ${i + 1}`} value={r.unit} onChange={(e) => patch(r.key, { unit: e.target.value })} disabled={!it}>
                          {unitsFor(it?.base_unit).map((u) => <option key={u}>{u}</option>)}
                        </InlineSelect>
                        <IconButton label={`Remove ingredient ${i + 1}`} icon={<Trash2 />} disabled={rows.length === 1} onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))} />
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" iconStart={<Plus />} onClick={() => setRows((x) => [...x, blank()])}>Add ingredient</Button>
                    <Button variant="secondary" iconStart={<Sparkles />} loading={aiBusy} disabled={!data.inv.length} onClick={() => void suggestOne()}>Suggest recipe with AI</Button>
                  </div>
                  <Button variant="primary" iconStart={<Save />} disabled={!valid} loading={saving} onClick={() => void save()}>{current ? `Save as version ${current.version + 1}` : "Save recipe"}</Button>
                </div>
                <p className="mt-3 text-xs text-fg-subtle">Saving creates a new version. Past sales keep the version that was active when they were made, and older versions are kept for history.</p>
              </Card>
            )}
          </div>

          {menuId && (
            <div className="space-y-4 lg:sticky lg:top-[calc(var(--topbar-h)+1rem)]">
              <Card>
                <CardHeader title="1 sold uses" description={menuItem ? `Every ${menuItem.name} sold takes this from stock.` : undefined} />
                {usage.length === 0 ? <p className="text-sm text-fg-muted">Add ingredients with quantities to see the summary.</p> : (
                  <ul className="space-y-2 text-sm">
                    {usage.map((u) => <li key={u.key} className="flex justify-between gap-3"><span className="min-w-0 truncate text-fg-muted">{u.it.name}</span><span className="tnum font-medium text-fg">{prettyQty(u.perPortion, u.it.base_unit)}</span></li>)}
                  </ul>
                )}
                {usage.length > 0 && cost !== null && (
                  <p className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-3 text-sm"><span className="text-fg-muted">Ingredient cost{costGaps ? ` (${costGaps} without a price)` : ""}</span><span className="tnum font-semibold"><Money value={cost.toFixed(2)} />{menuItem && Number(menuItem.price) > 0 ? <span className="ml-2 text-xs font-normal text-fg-subtle">{Math.round((cost / Number(menuItem.price)) * 100)}% of price</span> : null}</span></p>
                )}
              </Card>
              <Card>
                <CardHeader title="Consumption preview" />
                <Input label="Portions" inputMode="numeric" value={portions} onChange={(e) => setPortions(e.target.value.replace(/\D/g, ""))} />
                {usage.length > 0 && (
                  <>
                    <p className="mt-3 text-sm font-medium text-fg">{nPortions} portion{nPortions === 1 ? "" : "s"} would use</p>
                    <ul className="mt-2 space-y-2 text-sm" aria-live="polite">
                      {usage.map((u) => <li key={u.key} className="flex justify-between gap-3"><span className="min-w-0 truncate text-fg-muted">{u.it.name}</span><span className="tnum font-semibold text-fg">{prettyQty(u.total, u.it.base_unit)}</span></li>)}
                    </ul>
                    {maxPortions !== null && Number.isFinite(maxPortions) && (
                      <p className={`mt-4 rounded-lg px-3 py-2 text-xs ${maxPortions < nPortions ? "bg-warning-soft text-warning-fg" : "bg-success-soft text-success-fg"}`}>
                        Current stock covers about <b className="tnum">{maxPortions}</b> portion{maxPortions === 1 ? "" : "s"}{limiting && maxPortions < nPortions ? `, limited by ${limiting.it.name}` : ""}.
                      </p>
                    )}
                  </>
                )}
              </Card>
            </div>
          )}
        </div>
      )}
      <HistorySheet open={history && !!menuId} onClose={() => setHistory(false)} menuItemId={menuId} name={menuItem?.name ?? "Recipe"} invNames={inv} />
    </>
  );
}

/** Every saved version of a recipe, newest first. Past sales keep the version that was current when they happened. */
function HistorySheet({ open, onClose, menuItemId, name, invNames }: { open: boolean; onClose: () => void; menuItemId: string; name: string; invNames: Map<string, InventoryItem> }) {
  const [rows, setRows] = useState<RecipeVersion[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !menuItemId) return;
    let off = false;
    void Promise.resolve().then(() => { setRows(null); setErr(null); });
    api.recipeHistory(menuItemId).then((r) => { if (!off) setRows(r); }).catch((e) => { if (!off) setErr(e instanceof ApiError ? e.message : "Could not load the history"); });
    return () => { off = true; };
  }, [open, menuItemId]);
  return (
    <Sheet side="right" open={open} onOpenChange={(o) => { if (!o) onClose(); }} title={`${name}: recipe history`} description="Newest first. Old versions are never deleted.">
      <div className="space-y-3 py-2">
        {err && <Notice tone="danger">{err}</Notice>}
        {!rows && !err && <div role="status" aria-label="Loading history" className="space-y-3"><Skeleton className="h-28 rounded-xl" /><Skeleton className="h-28 rounded-xl" /></div>}
        {rows?.map((v) => (
          <section key={v.id} className="rounded-xl border border-border bg-surface-2/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-display font-bold text-fg">Version {v.version}</p>
              {v.is_current ? <Badge tone="success">Current</Badge> : <Badge tone="neutral">Replaced</Badge>}
            </div>
            <p className="mt-0.5 text-xs text-fg-subtle">{formatDateTime(v.effective_from)}{v.effective_to ? ` to ${formatDateTime(v.effective_to)}` : " until now"}</p>
            <ul className="mt-2 space-y-1 text-sm">
              {v.ingredients.map((g) => (
                <li key={g.item_id} className="flex justify-between gap-3"><span className="min-w-0 truncate text-fg-muted">{g.name || invNames.get(g.item_id)?.name || "Item"}</span><span className="tnum font-medium text-fg">{prettyQty(g.quantity, g.unit)}</span></li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
