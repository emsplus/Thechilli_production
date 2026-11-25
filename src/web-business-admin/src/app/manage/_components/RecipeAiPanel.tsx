"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, Pause, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { Badge, Button, Notice } from "@chilli/ui";
import { Card, CardHeader, toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { plainAiError } from "@/lib/aiErrors";
import { DECIMAL_RE } from "@/lib/units";
import type { InventoryItem, MenuItem } from "@/lib/types";
import { uuid } from "@/lib/uuid";
import { fromServer, nextKey, type StoredDraft } from "./recipe-drafts";

const BATCH = 8; // dishes per request (the server accepts up to 10)
const PAUSE_MS = 1500; // between requests: gentle on the AI provider and on our rate limit
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Run = { state: "idle" | "running" | "paused" | "done" | "error"; done: number; total: number; empty: number; msg?: string };
const ready = (d: StoredDraft) => d.missing.length === 0 && d.rows.length > 0 && d.rows.every((r) => !!r.item_id && DECIMAL_RE.test(r.quantity.trim()) && Number(r.quantity) > 0)
  && new Set(d.rows.map((r) => r.item_id)).size === d.rows.length;

/**
 * Bulk "Draft recipes for dishes without one": batched, with progress, pausable and resumable (finished drafts are kept in this
 * browser). Every result is a DRAFT for the owner to review; only "Save all drafts" or saving one dish writes recipes.
 */
export function RecipeAiPanel({ menu, hasRecipe, inv, drafts, putDraft, patchDraft, removeDrafts, onOpen, onSaved }: {
  menu: MenuItem[]; hasRecipe: (id: string) => boolean; inv: InventoryItem[]; drafts: Record<string, StoredDraft>;
  putDraft: (d: StoredDraft) => void; patchDraft: (id: string, p: Partial<StoredDraft>) => void; removeDrafts: (ids: string[]) => void;
  onOpen: (id: string) => void; onSaved: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [run, setRun] = useState<Run>({ state: "idle", done: 0, total: 0, empty: 0 });
  const [busy, setBusy] = useState<"save" | "create" | null>(null);
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);

  const todo = useMemo(() => menu.filter((m) => !hasRecipe(m.id) && !drafts[m.id]), [menu, hasRecipe, drafts]);
  const list = Object.values(drafts).filter((d) => menu.some((m) => m.id === d.menu_item_id));
  const okCount = list.filter(ready).length;
  const needStock = list.filter((d) => d.missing.length > 0).length;
  const running = run.state === "running";

  async function start() {
    stop.current = false;
    const queue = [...todo];
    let empty = 0;
    setRun({ state: "running", done: 0, total: queue.length, empty: 0 });
    for (let i = 0; i < queue.length; i += BATCH) {
      if (stop.current) { setRun((r) => ({ ...r, state: "paused" })); return; }
      const batch = queue.slice(i, i + BATCH);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await api.aiRecipeDrafts(batch.map((m) => m.id));
          for (const d of res.drafts) { if (d.ingredients.length || d.missing.length) putDraft(fromServer(d)); else empty++; }
          break;
        } catch (e) {
          if (e instanceof ApiError && e.status === 429 && attempt < 3) { await sleep(20000); if (stop.current) { setRun((r) => ({ ...r, state: "paused" })); return; } continue; }
          setRun((r) => ({ ...r, state: "error", empty, msg: e instanceof ApiError ? plainAiError(e.message, "AI recipe drafts") : "The AI could not draft these dishes" }));
          return;
        }
      }
      setRun({ state: "running", done: Math.min(i + BATCH, queue.length), total: queue.length, empty });
      await sleep(PAUSE_MS);
    }
    setRun({ state: "done", done: queue.length, total: queue.length, empty });
  }

  /** One stock item per missing name across all drafts, then every draft gets its rows. */
  async function createAllMissing() {
    const want = new Map<string, { name: string; base_unit: "g" | "ml" | "pcs" }>();
    for (const d of list) for (const m of d.missing) if (!want.has(m.name.toLowerCase())) want.set(m.name.toLowerCase(), { name: m.name, base_unit: m.base_unit });
    if (!want.size) return;
    if (!(await confirm({ title: `Create ${want.size} stock item${want.size === 1 ? "" : "s"}?`, description: [...want.values()].slice(0, 12).map((w) => w.name).join(", ") + (want.size > 12 ? " …" : "") + ". They start with 0 in stock; you can count them later.", confirmLabel: "Create" }))) return;
    setBusy("create");
    try {
      const r = await api.bulkCreateItems({ idempotency_key: uuid(), items: [...want.values()].map((w) => ({ name: w.name, base_unit: w.base_unit, reorder_level: "0" })) });
      const byName = new Map([...r.created, ...r.existing].map((i) => [i.name.toLowerCase(), i]));
      for (const d of list) {
        if (!d.missing.length) continue;
        const add = d.missing.flatMap((m) => { const it = byName.get(m.name.toLowerCase()); return it && !d.rows.some((x) => x.item_id === it.id) ? [{ key: nextKey(), item_id: it.id, quantity: m.quantity, unit: it.base_unit }] : []; });
        patchDraft(d.menu_item_id, { rows: [...d.rows, ...add], missing: [] });
      }
      await onSaved();
      toast.success(`${r.created.length} stock item${r.created.length === 1 ? "" : "s"} created`);
    } catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not create the stock items"); } finally { setBusy(null); }
  }

  async function saveAll() {
    const ok = list.filter(ready);
    if (!ok.length) return;
    if (!(await confirm({ title: `Save ${ok.length} recipe${ok.length === 1 ? "" : "s"}?`, description: "Only do this after checking the quantities. From now on every sale of these dishes deducts these amounts from stock. Each recipe can still be edited later (it becomes a new version).", confirmLabel: `Save ${ok.length}` }))) return;
    setBusy("save");
    let saved = 0;
    const failed: string[] = [];
    for (const d of ok) {
      try { await api.saveRecipe({ menu_item_id: d.menu_item_id, ingredients: d.rows.map((r) => ({ item_id: r.item_id, quantity: r.quantity.trim(), unit: r.unit })) }); removeDrafts([d.menu_item_id]); saved++; }
      catch { failed.push(d.name); }
    }
    await onSaved();
    setBusy(null);
    if (saved) toast.success(`${saved} recipe${saved === 1 ? "" : "s"} saved`);
    if (failed.length) toast.error(`Could not save: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? " …" : ""}. They stay as drafts.`);
  }

  if (!inv.length) return null; // the tab's empty state already explains that stock comes first
  if (!todo.length && !list.length && run.state === "idle") return null;
  return (
    <Card data-testid="recipe-ai-panel">
      <CardHeader title="Draft recipes with AI" description="The AI proposes what one portion uses, from your own stock list. Nothing is saved until you review it." />
      {todo.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          {running
            ? <Button variant="secondary" iconStart={<Pause />} onClick={() => { stop.current = true; }}>Pause</Button>
            : <Button variant="primary" iconStart={<Sparkles />} onClick={() => void start()}>{run.state === "paused" || run.state === "error" ? "Resume" : "Draft recipes for dishes without one"} ({todo.length})</Button>}
          {running && <p className="text-sm text-fg-muted" aria-live="polite">Drafting {run.done} / {run.total} dishes…</p>}
        </div>
      )}
      {run.state !== "idle" && run.total > 0 && (
        <div className="mt-3" role="progressbar" aria-label="Drafting progress" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done}>
          <div className="h-2.5 w-full rounded-full bg-surface-3"><div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${Math.round((run.done / run.total) * 100)}%` }} /></div>
        </div>
      )}
      {run.state === "error" && <div className="mt-3"><Notice tone="danger">{run.msg} You can resume: finished drafts are kept.</Notice></div>}
      {run.state === "paused" && <div className="mt-3"><Notice tone="info">Paused at {run.done} of {run.total}. Resume any time: finished drafts are kept.</Notice></div>}
      {run.state === "done" && <div className="mt-3"><Notice tone="success">Drafted {run.done - run.empty} dishes{run.empty ? `; ${run.empty} had no suggestion` : ""}. Review them below.</Notice></div>}

      {list.length > 0 && (
        <div className="mt-4 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-fg"><Badge tone="info">{<Sparkles />}AI draft - check quantities</Badge><span className="tnum">{list.length} to review</span></p>
            <div className="flex flex-wrap gap-2">
              {needStock > 0 && <Button size="sm" variant="secondary" iconStart={<Plus />} loading={busy === "create"} onClick={() => void createAllMissing()}>Create the missing stock items</Button>}
              <Button variant="primary" size="sm" iconStart={<Save />} disabled={!okCount} loading={busy === "save"} onClick={() => void saveAll()}>Save all drafts ({okCount})</Button>
              <Button size="sm" variant="secondary" iconStart={<Trash2 />} disabled={busy !== null} onClick={async () => { if (await confirm({ title: "Discard all drafts?", description: "Nothing has been saved, so no recipe changes. You can draft them again.", confirmLabel: "Discard", tone: "danger" })) removeDrafts(list.map((d) => d.menu_item_id)); }}>Discard all</Button>
            </div>
          </div>
          {needStock > 0 && <p className="mt-2 text-xs text-fg-subtle">{needStock} draft{needStock === 1 ? "" : "s"} name{needStock === 1 ? "s" : ""} ingredients you do not stock yet. Create them (0 in stock), or open the dish. Those drafts are skipped by “Save all”.</p>}
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {list.slice(0, 50).map((d) => (
              <li key={d.menu_item_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{d.name}<span className="ml-2 text-xs font-normal text-fg-subtle">{d.rows.length} ingredient{d.rows.length === 1 ? "" : "s"}{d.missing.length ? ` + ${d.missing.length} new` : ""}</span></span>
                <Button size="sm" variant="secondary" iconStart={<Eye />} onClick={() => onOpen(d.menu_item_id)} aria-label={`Review the draft for ${d.name}`}>Review</Button>
              </li>
            ))}
          </ul>
          {list.length > 50 && <p className="mt-2 text-xs text-fg-subtle">Showing 50 of {list.length}. Review and save some, the rest follow.</p>}
        </div>
      )}
    </Card>
  );
}
