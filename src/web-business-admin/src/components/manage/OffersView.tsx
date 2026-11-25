"use client";

import { ViewHeader } from "@/components/ui/view-header";
import { useMemo, useState } from "react";
import { BadgePercent, Pencil, Plus } from "lucide-react";
import { Badge, Button, Checkbox, IconButton, Input, Notice, SegmentedControl, Sheet, Skeleton, Switch } from "@chilli/ui";
import { Card, EmptyState } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { extras, type Offer } from "@/lib/extras";
import { blankOffer, formOf, offerBody, offerSummary, ORDER_TYPE_NAMES, WEEKDAYS, type OfferForm } from "@/lib/menuAdmin";
import { formatCurrency } from "@/lib/money";
import { useCurrency } from "@/lib/taxConfig";
import { useLoader } from "@/lib/useLoader";
import { useNotify } from "@/lib/useNotify";
import { useCan } from "@/lib/useRole";
import type { Category, MenuItem, OrderType } from "@/lib/types";

const fetchAll = async () => {
  const [offers, active, items, cats] = await Promise.all([extras.offers(true), extras.activeOffers().catch(() => [] as Offer[]), api.allItems(), api.allCategories()]);
  return { offers, active, items, cats };
};

/**
 * Menu > Offers: automatic discounts ("Lunch 10%", "₹20 off every lassi") that the counter applies by itself on the bill
 * preview and the bill ("Offer: Lunch 10%"). Only the largest non-stackable offer applies; stackable ones add on top.
 * Offers are switched off, never deleted (past bills keep their name).
 */
export function OffersView({ embedded = false }: { embedded?: boolean }) {
  const { can, ready } = useCan();
  const allowed = ready && can("offers.manage");
  const { data, error, loading, reload } = useLoader(fetchAll);
  const toast = useNotify();
  const cur = useCurrency();
  const money = (v: string) => formatCurrency(v, cur);
  const [edit, setEdit] = useState<{ offer: Offer | null } | null>(null);

  async function setActive(o: Offer, on: boolean) {
    try { await extras.setOfferActive(o.id, on); toast.success(on ? `${o.name} is on` : `${o.name} is off`); void reload(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not change the offer"); }
  }

  if (ready && !allowed) {
    return <><ViewHeader embedded={embedded} title="Offers" /><Card><EmptyState icon={<BadgePercent />} title="Offers are managed by the owner or a manager" hint="Ask them to give your role the offers permission." /></Card></>;
  }
  const offers = [...(data?.offers ?? [])].sort((a, b) => Number(b.is_active) - Number(a.is_active) || b.priority - a.priority || a.name.localeCompare(b.name));
  const running = data?.active ?? [];

  return (
    <>
      <ViewHeader embedded={embedded} title="Offers" description="Discounts the counter applies by itself, shown on the bill as 'Offer: name'. Only the biggest offer applies unless an offer is set to add to others."
        actions={<Button variant="primary" iconStart={<Plus />} onClick={() => setEdit({ offer: null })}>Add offer</Button>} />
      {error && <Notice tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => void reload()}>Retry</Button>}>{error}</Notice>}
      {loading || !ready ? (
        <div role="status" aria-label="Loading offers" className="space-y-3"><Skeleton className="h-20 rounded-2xl" />{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
      ) : (
        <>
          <Card className="mb-4" data-testid="active-offers">
            <h2 className="font-display text-base font-bold text-fg">Active offers right now</h2>
            {running.length === 0
              ? <p className="mt-1 text-sm text-fg-muted">No offer is running at this moment. Bills are charged at menu prices.</p>
              : <ul className="mt-2 flex flex-wrap gap-2">{running.map((o) => <li key={o.id}><Badge tone="success">{o.label || `Offer: ${o.name}`}</Badge></li>)}</ul>}
          </Card>
          {offers.length === 0 ? (
            <Card><EmptyState icon={<BadgePercent />} title="No offers yet" hint="Add a happy-hour or lunch offer. It applies at the counter automatically during its days and times."
              action={<Button variant="primary" iconStart={<Plus />} onClick={() => setEdit({ offer: null })}>Add your first offer</Button>} /></Card>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2" data-testid="offers">
              {offers.map((o) => (
                <li key={o.id}>
                  <Card className={o.is_active ? "" : "opacity-75"}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="flex flex-wrap items-center gap-2 font-display text-lg font-bold text-fg">{o.name}{running.some((r) => r.id === o.id) && <Badge tone="success">Running now</Badge>}</h2>
                        <p className="mt-0.5 text-sm text-fg-muted">{offerSummary(o, money)}</p>
                      </div>
                      <IconButton label={`Edit ${o.name}`} icon={<Pencil />} onClick={() => setEdit({ offer: o })} />
                    </div>
                    <div className="mt-2"><Switch label={o.is_active ? "On" : "Off"} checked={o.is_active} onChange={(e) => void setActive(o, e.target.checked)} /></div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <OfferSheet state={edit} items={data?.items ?? []} cats={data?.cats ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />
    </>
  );
}

function OfferSheet({ state, items, cats, onClose, onSaved }: { state: { offer: Offer | null } | null; items: MenuItem[]; cats: Category[]; onClose: () => void; onSaved: () => void }) {
  const { biz } = useCan(); // only the order types this business runs (a cloud kitchen: Takeaway, Delivery)
  const toast = useNotify();
  const o = state?.offer ?? null;
  const [f, setF] = useState<OfferForm>(blankOffer);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<typeof state>(null);
  if (state !== seen) { setSeen(state); if (state) { setF(o ? formOf(o) : blankOffer()); setErr(null); } }
  const up = (p: Partial<OfferForm>) => setF((x) => ({ ...x, ...p }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const targets = useMemo(() => (f.scope === "item" ? items.filter((i) => i.is_active || f.targets.includes(i.id)).map((i) => ({ id: i.id, name: i.name })) : cats.filter((c) => c.is_active || f.targets.includes(c.id)).map((c) => ({ id: c.id, name: c.name }))), [f.scope, f.targets, items, cats]);

  async function save() {
    const r = offerBody(f);
    if ("error" in r) { setErr(r.error); return; }
    setBusy(true); setErr(null);
    try {
      if (o) await extras.updateOffer(o.id, r.body); else await extras.createOffer(r.body);
      toast.success(o ? `${r.body.name} saved` : `${r.body.name} added`); onSaved();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? "This offer is bigger than the cashier discount limit: it needs a manager or owner to save it." : e instanceof ApiError ? e.message : "Could not save the offer");
    } finally { setBusy(false); }
  }

  return (
    <Sheet side="right" open={state !== null} onOpenChange={(x) => { if (!x && !busy) onClose(); }} title={o ? `Edit ${o.name}` : "Add offer"}
      description="The counter applies it by itself when the order matches. Leave days, times and order types empty for always."
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{o ? "Save changes" : "Add offer"}</Button></>}>
      <form className="space-y-4 pb-3" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label="Offer name" hint="Printed on the bill as 'Offer: name'" placeholder="Lunch 10%" autoComplete="off" maxLength={100} value={f.name} onChange={(e) => up({ name: e.target.value })} />
        <SegmentedControl legend="Discount" value={f.kind} onValueChange={(v) => up({ kind: v as OfferForm["kind"] })} options={[{ value: "percent", label: "Percent off" }, { value: "amount", label: "Amount off (₹)" }]} />
        <Input label={f.kind === "percent" ? "Discount %" : "Discount ₹"} inputMode="decimal" placeholder={f.kind === "percent" ? "10" : "50"} value={f.value} onChange={(e) => up({ value: e.target.value })} />
        <SegmentedControl legend="Applies to" value={f.scope} onValueChange={(v) => up({ scope: v as OfferForm["scope"], targets: [] })} options={[{ value: "bill", label: "Whole bill" }, { value: "item", label: "Dishes" }, { value: "category", label: "Categories" }]} />
        {f.scope !== "bill" && (
          <fieldset className="max-h-56 space-y-0.5 overflow-y-auto rounded-xl border border-border p-2" aria-label={f.scope === "item" ? "Dishes" : "Categories"}>
            <legend className="sr-only">{f.scope === "item" ? "Dishes" : "Categories"}</legend>
            {targets.length === 0 ? <p className="p-2 text-sm text-fg-muted">Nothing on the menu yet.</p>
              : targets.map((t) => <Checkbox key={t.id} label={t.name} checked={f.targets.includes(t.id)} onChange={() => up({ targets: toggle(f.targets, t.id) })} />)}
          </fieldset>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Minimum order ₹" hint="Optional" inputMode="decimal" value={f.minOrder} onChange={(e) => up({ minOrder: e.target.value })} />
          <Input label="Maximum discount ₹" hint="Optional cap per bill" inputMode="decimal" value={f.maxDiscount} onChange={(e) => up({ maxDiscount: e.target.value })} />
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-semibold text-fg">Days</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d, i) => (
              <button key={d} type="button" aria-pressed={f.days.includes(i)} onClick={() => up({ days: toggle(f.days, i) })}
                className={`min-h-11 min-w-11 rounded-xl border px-3 text-sm font-semibold transition-colors ${f.days.includes(i) ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border text-fg-muted hover:bg-surface-2"}`}>{d}</button>
            ))}
          </div>
          <p className="mt-1 text-xs text-fg-muted">None selected = every day.</p>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Input label="From time" type="time" value={f.start} onChange={(e) => up({ start: e.target.value })} />
          <Input label="Until time" type="time" hint="Empty = all day" value={f.end} onChange={(e) => up({ end: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Starts on" type="date" value={f.from} onChange={(e) => up({ from: e.target.value })} />
          <Input label="Ends on" type="date" value={f.to} onChange={(e) => up({ to: e.target.value })} />
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-semibold text-fg">Order types</legend>
          <div className="grid grid-cols-2 gap-x-3">
            {(Object.keys(ORDER_TYPE_NAMES) as OrderType[]).filter((t) => biz.order_types.includes(t) || f.orderTypes.includes(t)).map((t) => <Checkbox key={t} label={ORDER_TYPE_NAMES[t]} checked={f.orderTypes.includes(t)} onChange={() => up({ orderTypes: toggle(f.orderTypes, t) })} />)}
          </div>
          <p className="mt-1 text-xs text-fg-muted">None ticked = every order type.</p>
        </fieldset>
        <Switch label="Adds to other offers (stackable)" checked={f.stackable} onChange={(e) => up({ stackable: e.target.checked })} />
        <Switch label="Offer is on" checked={f.active} onChange={(e) => up({ active: e.target.checked })} />
      </form>
    </Sheet>
  );
}
