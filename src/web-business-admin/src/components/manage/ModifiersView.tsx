"use client";

import { ViewHeader } from "@/components/ui/view-header";
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Pencil, Plus, SlidersHorizontal, X } from "lucide-react";
import { Badge, Button, Checkbox, IconButton, Input, Notice, Sheet, Skeleton, Switch } from "@chilli/ui";
import { Card, EmptyState } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { extras, type ModifierGroup } from "@/lib/extras";
import { deltaLabel } from "@/lib/modifiers";
import { groupBody, newRow, ruleText, type OptRow } from "@/lib/menuAdmin";
import { useLoader } from "@/lib/useLoader";
import { useNotify } from "@/lib/useNotify";
import { useCan } from "@/lib/useRole";

const fetchAll = async () => {
  const [groups, items] = await Promise.all([extras.modifierGroups(true), api.allItems()]);
  return { groups, items };
};

/**
 * Menu > Modifier groups: reusable choices such as "Spice level" (required, one) or "Extras" (optional, up to 3) with a
 * price change per option in ₹. Groups are attached to dishes in the item editor. Nothing changes at the counter until a
 * group is attached; required groups with a default never add a tap.
 */
export function ModifiersView({ embedded = false }: { embedded?: boolean }) {
  const { can, ready } = useCan();
  const { data, error, loading, reload } = useLoader(fetchAll);
  const toast = useNotify();
  const [edit, setEdit] = useState<{ group: ModifierGroup | null } | null>(null);
  const itemName = useMemo(() => new Map((data?.items ?? []).map((i) => [i.id, i.name])), [data]);
  const canEdit = can("menu.manage");

  async function setActive(g: ModifierGroup, on: boolean) {
    try { await extras.setModifierGroupActive(g.id, on); toast.success(on ? `${g.name} is on` : `${g.name} is off: the counter no longer offers it`); void reload(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not change the group"); }
  }

  const groups = [...(data?.groups ?? [])].sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  return (
    <>
      <ViewHeader embedded={embedded} title="Modifier groups" description="Choices a dish can take at the counter: spice level, extras, add-ons. Attach them to dishes in the menu item editor."
        actions={canEdit && <Button variant="primary" iconStart={<Plus />} onClick={() => setEdit({ group: null })}>Add group</Button>} />
      {error && <Notice tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => void reload()}>Retry</Button>}>{error}</Notice>}
      {ready && !canEdit && <Notice tone="info" className="mb-4">You can see the groups. Changing them needs the menu permission.</Notice>}
      {loading ? (
        <div role="status" aria-label="Loading modifier groups" className="grid gap-3 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}</div>
      ) : groups.length === 0 ? (
        <Card><EmptyState icon={<SlidersHorizontal />} title="No modifier groups yet" hint="Add a group such as Spice level (Mild, Medium, Hot) or Extras (Cheese +₹20), then attach it to dishes."
          action={canEdit && <Button variant="secondary" iconStart={<Plus />} onClick={() => setEdit({ group: null })}>Add your first group</Button>} /></Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" data-testid="modifier-groups">
          {groups.map((g) => {
            const used = g.item_ids.map((id) => itemName.get(id)).filter(Boolean) as string[];
            const opts = g.options.filter((o) => o.is_active).sort((a, b) => a.sort_order - b.sort_order);
            return (
              <li key={g.id}>
                <Card className={g.is_active ? "" : "opacity-75"}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-display text-lg font-bold text-fg">{g.name}</h2>
                      <p className="text-sm text-fg-muted">{ruleText(g)}{g.is_active ? "" : " · Off"}</p>
                    </div>
                    {canEdit && <IconButton label={`Edit ${g.name}`} icon={<Pencil />} onClick={() => setEdit({ group: g })} />}
                  </div>
                  <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={`Options of ${g.name}`}>
                    {opts.map((o) => (
                      <li key={o.id}><Badge tone={o.is_default ? "primary" : "neutral"}>{o.name}{deltaLabel(o) && <span className="tnum ml-1">{deltaLabel(o)}</span>}{o.is_default && <span className="ml-1">(default)</span>}</Badge></li>
                    ))}
                  </ul>
                  <p className="mt-3 text-sm text-fg-muted">{used.length ? `Used by ${used.length === 1 ? "1 dish" : `${used.length} dishes`}: ${used.slice(0, 4).join(", ")}${used.length > 4 ? ` +${used.length - 4}` : ""}` : <>Not used by any dish yet. <Link href="/manage?tab=menu" className="font-semibold text-primary underline-offset-2 hover:underline">Attach it in the menu</Link>.</>}</p>
                  {canEdit && <div className="mt-2"><Switch label={g.is_active ? "Offered at the counter" : "Off"} checked={g.is_active} onChange={(e) => void setActive(g, e.target.checked)} /></div>}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <GroupSheet state={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />
    </>
  );
}

function GroupSheet({ state, onClose, onSaved }: { state: { group: ModifierGroup | null } | null; onClose: () => void; onSaved: () => void }) {
  const toast = useNotify();
  const g = state?.group ?? null;
  const open = state !== null;
  const [name, setName] = useState("");
  const [min, setMin] = useState("0");
  const [max, setMax] = useState("1");
  const [rows, setRows] = useState<OptRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<typeof state>(null);
  if (state !== seen) {
    // Reset the form whenever the sheet opens for another group (render-time sync, no effect).
    setSeen(state);
    if (state) {
      setName(g?.name ?? ""); setMin(String(g?.min_select ?? 0)); setMax(g ? (g.max_select === null ? "" : String(g.max_select)) : "1"); setErr(null);
      setRows(g ? g.options.filter((o) => o.is_active).sort((a, b) => a.sort_order - b.sort_order).map((o) => newRow({ id: o.id, name: o.name, rupees: String(o.price_delta_paise / 100), isDefault: o.is_default })) : [newRow(), newRow()]);
    }
  }
  const set = useCallback((key: string, p: Partial<OptRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r))), []);
  const single = max.trim() === "1";

  async function save() {
    const r = groupBody(name, min, max, rows);
    if ("error" in r) { setErr(r.error); return; }
    setBusy(true); setErr(null);
    try {
      if (g) await extras.updateModifierGroup(g.id, r.body); else await extras.createModifierGroup(r.body);
      toast.success(g ? `${r.body.name} saved` : `${r.body.name} added`);
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not save the group"); } finally { setBusy(false); }
  }

  return (
    <Sheet side="right" open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title={g ? `Edit ${g.name}` : "Add modifier group"}
      description="Set how many options the cashier must pick. A default option is added automatically, so a required group with a default costs no extra tap."
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{g ? "Save changes" : "Add group"}</Button></>}>
      <form className="space-y-4 pb-3" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label="Group name" placeholder="Spice level" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Minimum to pick" hint="0 = optional" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} />
          <Input label="Maximum to pick" hint="Empty = no limit" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} />
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold text-fg">Options</legend>
          {rows.map((r, i) => (
            <div key={r.key} className="rounded-xl border border-border p-2" data-testid="option-row">
              <div className="grid grid-cols-[1fr_6.5rem_2.75rem] items-start gap-2">
                <Input label={`Option ${i + 1} name`} placeholder={i === 0 ? "Mild" : "Hot"} autoComplete="off" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} maxLength={100} />
                <Input label="Price change ₹" inputMode="decimal" value={r.rupees} onChange={(e) => set(r.key, { rupees: e.target.value })} />
                <div className="pt-7"><IconButton variant="ghost" label={`Remove option ${i + 1}`} icon={<X />} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} /></div>
              </div>
              <Checkbox label="Default (picked automatically)" checked={r.isDefault}
                onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, isDefault: e.target.checked } : single && e.target.checked ? { ...x, isDefault: false } : x)))} />
            </div>
          ))}
          <Button iconStart={<Plus />} onClick={() => setRows((rs) => [...rs, newRow()])}>Add option</Button>
          <p className="text-xs text-fg-muted">Price change is added to the dish price (use a minus for a cheaper option). Removed options stay on past bills.</p>
        </fieldset>
      </form>
    </Sheet>
  );
}
