"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Archive, ArrowDown, ArrowUp, Check, Pencil, Plus, RotateCcw, X } from "lucide-react";
import { Badge, Button, EmptyState, IconButton, Input, Sheet } from "@chilli/ui";
import { useAsk } from "@/lib/useAsk";
import { useNotify } from "@/lib/useNotify";
import { useMsg } from "@/lib/i18n";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Category, MenuItem } from "@/lib/types";
import { CATEGORY_MSG } from "./menu-messages";

const makeNameSchema = (t: (k: string) => string) => z.object({ name: z.string().trim().min(1, t("enterName")).max(100, t("nameMax")) });
type NameForm = { name: string };
const em = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

/** Add, rename, archive and reorder categories. The order here is the order of the pills on the POS. */
export function CategoriesSheet({ open, onOpenChange, cats, items, onChanged }: {
  open: boolean; onOpenChange: (o: boolean) => void; cats: Category[]; items: MenuItem[]; onChanged: () => void;
}) {
  const [ask, askNode] = useAsk();
  const toast = useNotify();
  const t = useMsg(CATEGORY_MSG);
  const nameSchema = useMemo(() => makeNameSchema(t), [t]);
  const [local, setLocal] = useState<Category[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const list = local ?? cats;
  useEffect(() => { void Promise.resolve().then(() => setLocal(null)); }, [cats]);

  const add = useForm<NameForm>({ resolver: zodResolver(nameSchema), defaultValues: { name: "" } });
  const submitAdd = add.handleSubmit(async (v) => {
    try { await api.createCategory(v.name); toast.success(t("added", { name: v.name })); add.reset({ name: "" }); onChanged(); }
    catch (e) { add.setError("name", { message: em(e, t("addFail")) }); }
  });

  async function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= list.length || saving) return;
    const next = [...list]; [next[idx], next[j]] = [next[j], next[idx]];
    setLocal(next); setSaving(true);
    try { await api.reorderCategories(next.map((c) => c.id)); onChanged(); }
    catch (e) { setLocal(null); toast.error(em(e, t("orderFail"))); }
    finally { setSaving(false); }
  }
  async function setActive(c: Category, on: boolean) {
    if (!on) {
      const n = items.filter((i) => i.category_id === c.id && i.is_active).length;
      if (!(await ask({ title: t("archiveTitle", { name: c.name }), description: n ? t(n === 1 ? "descOne" : "descMany", { n }) : t("descNone"), confirmLabel: t("archive"), destructive: true }))) return;
    }
    try { await api.patchCategory(c.id, { is_active: on }); toast.success(t(on ? "restored" : "archived", { name: c.name })); onChanged(); }
    catch (e) { toast.error(em(e, t("updateFail"))); }
  }
  async function rename(c: Category, name: string): Promise<string | null> {
    const r = nameSchema.safeParse({ name });
    if (!r.success) return r.error.issues[0].message;
    if (r.data.name === c.name) { setEditing(null); return null; }
    try { await api.patchCategory(c.id, { name: r.data.name }); toast.success(t("renamed")); setEditing(null); onChanged(); return null; }
    catch (e) { return em(e, t("renameFail")); }
  }

  return (
    <>
    <Sheet side="right" open={open} onOpenChange={onOpenChange} title={t("title")} description={t("desc")}>
      <div className="space-y-4 py-2">
        <form onSubmit={(e) => void submitAdd(e)} noValidate className="flex items-start gap-2" aria-label={t("addForm")}>
          <div className="min-w-0 flex-1"><Input label={t("newName")} placeholder={t("newNamePh")} autoComplete="off" error={add.formState.errors.name?.message} {...add.register("name")} /></div>
          <div className="pt-6"><Button variant="primary" type="submit" iconStart={<Plus />} loading={add.formState.isSubmitting}>{t("add")}</Button></div>
        </form>

        {list.length === 0 ? <EmptyState title={t("noCats")} description={t("noCatsDesc")} /> : (
          <ul className="space-y-2">
            {list.map((c, idx) => {
              const n = items.filter((i) => i.category_id === c.id && i.is_active).length;
              return (
                <li key={c.id} className={cn("rounded-xl border border-border bg-surface-2 p-2", !c.is_active && "opacity-70")}>
                  {editing === c.id ? <RenameRow t={t} cat={c} onSave={(name) => rename(c, name)} onCancel={() => setEditing(null)} /> : (
                    <div className="flex items-center gap-1">
                      <div className="min-w-0 flex-1 px-2">
                        <p className="break-words font-semibold text-fg">{c.name}{!c.is_active && <Badge tone="neutral">{t("archivedBadge")}</Badge>}</p>
                        <p className="text-xs text-fg-subtle">{t(n === 1 ? "itemOne" : "itemMany", { n })}</p>
                      </div>
                      <IconButton variant="ghost" label={t("moveUp", { name: c.name })} icon={<ArrowUp />} disabled={idx === 0 || saving} onClick={() => void move(idx, -1)} />
                      <IconButton variant="ghost" label={t("moveDown", { name: c.name })} icon={<ArrowDown />} disabled={idx === list.length - 1 || saving} onClick={() => void move(idx, 1)} />
                      <IconButton variant="ghost" label={t("rename", { name: c.name })} icon={<Pencil />} onClick={() => setEditing(c.id)} />
                      {c.is_active
                        ? <IconButton variant="ghost" label={t("archiveName", { name: c.name })} icon={<Archive />} onClick={() => void setActive(c, false)} />
                        : <IconButton variant="ghost" label={t("restoreName", { name: c.name })} icon={<RotateCcw />} onClick={() => void setActive(c, true)} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {/* Inside the Sheet on purpose: a sibling overlay would count as an outside click and close it. */}
      {askNode}
    </Sheet>
    </>
  );
}

function RenameRow({ t, cat, onSave, onCancel }: { t: (k: string, p?: Record<string, string | number>) => string; cat: Category; onSave: (name: string) => Promise<string | null>; onCancel: () => void }) {
  const [name, setName] = useState(cat.name);
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const m = await onSave(name); setErr(m ?? undefined); setBusy(false);
  }
  return (
    <form onSubmit={(e) => void go(e)} className="flex items-start gap-1" noValidate>
      <div className="min-w-0 flex-1 [&_.ch-label]:sr-only"><Input label={t("newNameFor", { name: cat.name })} autoFocus value={name} onChange={(e) => setName(e.target.value)} error={err} /></div>
      <IconButton type="submit" variant="secondary" label={t("saveName")} icon={<Check />} disabled={busy} />
      <IconButton variant="ghost" label={t("cancelRename")} icon={<X />} onClick={onCancel} />
    </form>
  );
}
