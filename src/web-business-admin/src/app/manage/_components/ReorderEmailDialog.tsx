"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Mail, Trash2 } from "lucide-react";
import { Button, Dialog, IconButton, Input, Notice, Select } from "@chilli/ui";
import { InlineInput, InlineSelect } from "@/components/inline-fields";
import { Skeleton, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { EmailSettings, InventoryItem, ReorderPreview, Supplier } from "@/lib/types";
import { DECIMAL_RE, prettyQty, unitsFor } from "@/lib/units";

interface Row { item_id: string; quantity: string; unit: string }

/** A base-unit quantity in a friendly unit for typing: 1500 g -> "1.5" kg, 2000 ml -> "2" l. */
export function friendly(qtyBase: string | number | null | undefined, base: string): { quantity: string; unit: string } {
  const n = Number(qtyBase);
  if (!Number.isFinite(n) || n <= 0) return { quantity: "", unit: base };
  if (base === "g" && n >= 1000) return { quantity: String(+(n / 1000).toFixed(3)), unit: "kg" };
  if (base === "ml" && n >= 1000) return { quantity: String(+(n / 1000).toFixed(3)), unit: "l" };
  return { quantity: String(+n.toFixed(3)), unit: base };
}

const rowFor = (i: InventoryItem): Row => ({ item_id: i.id, ...friendly(i.reorder_quantity ?? i.suggested_quantity, i.base_unit) });

/**
 * "Email supplier now": pick the supplier, check/edit the items and quantities, add a note, read the exact email, send.
 * Works for items that are not low too. The server writes the email to the history (kind "manual") and sends it in the background.
 */
export function ReorderEmailDialog({ open, onClose, suppliers, items, supplierId, itemIds, onDone }: {
  open: boolean; onClose: () => void; suppliers: Supplier[]; items: InventoryItem[]; supplierId?: string | null; itemIds?: string[]; onDone: () => void;
}) {
  const [sid, setSid] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [note, setNote] = useState("");
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [preview, setPreview] = useState<ReorderPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const supplier = suppliers.find((s) => s.id === sid);

  // Opening: choose the supplier and pre-fill the items (the ones asked for, else everything of that supplier that is low).
  useEffect(() => {
    if (!open) return;
    const first = supplierId ?? (itemIds?.length ? byId.get(itemIds[0])?.supplier_id : null) ?? "";
    const want = itemIds?.length ? itemIds : items.filter((i) => i.supplier_id === first && i.low_stock && i.is_active !== false).map((i) => i.id);
    const sameSupplier = itemIds?.length && first ? items.filter((i) => i.supplier_id === first && i.low_stock && i.is_active !== false).map((i) => i.id) : [];
    const ids = [...new Set([...want, ...sameSupplier])].filter((id) => byId.has(id));
    void Promise.resolve().then(() => {
      setSid(first ?? ""); setRows(ids.map((id) => rowFor(byId.get(id)!))); setNote(""); setPreview(null); setPreviewErr(null); setErr(null);
    });
    api.emailSettings().then(setSettings).catch(() => setSettings(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the dialog opens
  }, [open]);

  const valid = rows.length > 0 && rows.every((r) => DECIMAL_RE.test(r.quantity.trim()) && Number(r.quantity) > 0);
  const key = JSON.stringify([sid, rows, note]);
  const seq = useRef(0);
  useEffect(() => {
    if (!open || !sid || !valid) { void Promise.resolve().then(() => { setPreview(null); setPreviewErr(null); }); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true);
      api.previewReorder(sid, { items: rows.map((r) => ({ item_id: r.item_id, quantity: r.quantity.trim(), unit: r.unit })), note: note.trim() || null })
        .then((p) => { if (mine === seq.current) { setPreview(p); setPreviewErr(null); } })
        .catch((e) => { if (mine === seq.current) { setPreview(null); setPreviewErr(e instanceof ApiError ? e.message : "Could not prepare the email"); } })
        .finally(() => { if (mine === seq.current) setBusy(false); });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers sid, rows and note
  }, [open, key, valid]);

  const patch = (id: string, p: Partial<Row>) => setRows((x) => x.map((r) => (r.item_id === id ? { ...r, ...p } : r)));
  const addable = items.filter((i) => i.is_active !== false && !rows.some((r) => r.item_id === i.id)).sort((a, b) => Number(b.low_stock) - Number(a.low_stock) || a.name.localeCompare(b.name));
  const reason = settings && !settings.configured ? "Email is not set up" : !sid ? "Choose a supplier" : supplier && !supplier.email ? "This supplier has no email address yet" : preview && !preview.can_send ? preview.reason : null;
  const canSend = !!preview?.can_send && valid && !!settings?.configured && !busy;

  async function send() {
    setSending(true); setErr(null);
    try {
      await api.sendReorder(sid, { items: rows.map((r) => ({ item_id: r.item_id, quantity: r.quantity.trim(), unit: r.unit })), note: note.trim() || null });
      toast.success(`Email to ${supplier?.name ?? "the supplier"} is being sent`);
      onClose(); onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not send the email"); } finally { setSending(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title="Email supplier now"
      description="A short, polite re-order request. You see exactly what will be sent."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" iconStart={<Mail />} loading={sending} disabled={!canSend} onClick={() => void send()}>Send email</Button></>}>
      <div className="space-y-4 py-2">
        {settings && !settings.configured && <Notice tone="warning" title="Email is not set up">Ask whoever looks after the server to add the mailbox settings (see the runbook). Nothing can be sent until then.</Notice>}
        {err && <Notice tone="danger">{err}</Notice>}
        <Select label="Supplier" value={sid} onChange={(e) => setSid(e.target.value)}>
          <option value="">Choose supplier…</option>
          {suppliers.filter((s) => s.is_active !== false).map((s) => <option key={s.id} value={s.id}>{s.name}{s.email ? "" : " (no email)"}</option>)}
        </Select>
        {supplier && !supplier.email && <Notice tone="info">Add an email address to {supplier.name} in Suppliers first.</Notice>}

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-fg">Items and quantities to ask for</legend>
          {rows.length === 0 && <p className="text-sm text-fg-muted">No items yet. Add the items you want to re-order.</p>}
          {rows.map((r) => {
            const it = byId.get(r.item_id);
            if (!it) return null;
            return (
              <div key={r.item_id} className="grid grid-cols-[minmax(0,1fr)_5.5rem_auto] items-center gap-2 rounded-xl bg-surface-2/60 p-2.5 sm:grid-cols-[minmax(0,1fr)_6rem_5.5rem_auto]">
                <div className="col-span-3 min-w-0 sm:col-span-1">
                  <p className="truncate text-sm font-medium text-fg">{it.name}</p>
                  <p className="tnum text-xs text-fg-subtle">In stock {prettyQty(it.balance, it.base_unit)}{it.low_stock ? " · low" : ""}</p>
                </div>
                <InlineInput aria-label={`Quantity of ${it.name}`} inputMode="decimal" value={r.quantity} onChange={(e) => patch(r.item_id, { quantity: e.target.value })}
                  error={r.quantity && !(DECIMAL_RE.test(r.quantity.trim()) && Number(r.quantity) > 0) ? "Number" : undefined} />
                <InlineSelect aria-label={`Unit of ${it.name}`} value={r.unit} onChange={(e) => patch(r.item_id, { unit: e.target.value })}>
                  {unitsFor(it.base_unit).map((u) => <option key={u}>{u}</option>)}
                </InlineSelect>
                <IconButton label={`Remove ${it.name}`} icon={<Trash2 />} onClick={() => setRows((x) => x.filter((y) => y.item_id !== r.item_id))} />
              </div>
            );
          })}
          <InlineSelect aria-label="Add another item" value="" onChange={(e) => { const i = byId.get(e.target.value); if (i) setRows((x) => [...x, rowFor(i)]); }}>
            <option value="">+ Add another item…</option>
            {addable.map((i) => <option key={i.id} value={i.id}>{i.name}{i.low_stock ? " (low)" : ""}</option>)}
          </InlineSelect>
        </fieldset>

        <Input label="Note for the supplier" hint="Optional, e.g. “Please deliver before 9am”." maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />

        <section aria-label="Email preview" className="rounded-xl border border-border bg-surface-2/40 p-3">
          <h3 className="mb-2 text-sm font-semibold text-fg">Preview</h3>
          {busy && !preview ? <Skeleton className="h-24 rounded-lg" />
            : preview ? (
              <div className="space-y-2 text-sm">
                <p><span className="text-fg-subtle">To: </span><span className="font-medium text-fg" data-testid="reorder-to">{preview.to ?? "no email address"}</span></p>
                <p><span className="text-fg-subtle">Subject: </span><span className="font-medium text-fg" data-testid="reorder-subject">{preview.subject}</span></p>
                <pre data-testid="reorder-body" className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-3 font-sans text-[0.8125rem] leading-relaxed text-fg-muted">{preview.body_text}</pre>
              </div>
            ) : <p className="text-sm text-fg-muted">{previewErr ?? (reason ?? "Choose a supplier and the quantities to see the email.")}</p>}
          {reason && preview && <p className="mt-2 text-sm font-medium text-warning-fg">{reason}</p>}
        </section>
      </div>
    </Dialog>
  );
}
