"use client";

import { useState } from "react";
import { Button, DateInput, Dialog, Input, Notice, Select } from "@chilli/ui";
import { toast } from "@/components/ui";
import { useLocale, useMsg } from "@/lib/i18n";
import { buildReceiptLines, inv, isQty, trimDec, remainingQty, todayIso, type PurchaseOrder, type ReceiptRow } from "@/lib/inventoryApi";
import { INV_MSG } from "./messages";
import { errText, useIdempotencyKey, useRefs } from "./shared";

/** Goods receipt (GRN) against a purchase order: accepted / rejected quantity, actual rate, batch and expiry per line. Partial receipts are normal. */
export function ReceiveDialog({ po, onClose, onDone }: { po: PurchaseOrder | null; onClose: () => void; onDone: () => void }) {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const refs = useRefs();
  const key = useIdempotencyKey();
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [loc, setLoc] = useState("");
  const [on, setOn] = useState(todayIso());
  const [invoice, setInvoice] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<string | null>(null);

  if ((po?.id ?? null) !== shown) {
    setShown(po?.id ?? null);
    if (po) {
      setRows(po.lines.map((l) => ({ po_line_id: l.id, accepted: remainingQty(l) === "0" ? "" : remainingQty(l), rejected: "", rate: "", batch_no: "", expiry: "" })));
      setLoc(refs.locations.find((l) => l.is_default)?.id ?? ""); setOn(todayIso()); setInvoice(""); setNote(""); setErr(null); key.renew();
    }
  }
  const set = (id: string, patch: Partial<ReceiptRow>) => setRows((rs) => rs.map((r) => (r.po_line_id === id ? { ...r, ...patch } : r)));

  async function save() {
    if (!po) return;
    const lines = buildReceiptLines(rows);
    if (!lines.length) { setErr(t("nothingToReceive")); return; }
    for (const l of lines) {
      const pl = po.lines.find((x) => x.id === l.po_line_id)!;
      if (refs.itemById(pl.item_id)?.tracks_batches && !l.expiry_date) { setErr(`${refs.itemName(pl.item_id)}: ${t("expiryNeeded")}`); return; }
    }
    setBusy(true); setErr(null);
    try {
      await inv.receive(po.id, { idempotency_key: key.get(), location_id: loc || null, received_on: on || null, supplier_invoice_no: invoice.trim() || null, note: note.trim() || null, lines });
      key.renew(); toast.success(t("grnSaved")); onDone();
    } catch (e) { setErr(errText(e, "Could not receive the goods")); } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!po} onOpenChange={(o) => { if (!o) onClose(); }} locale={locale} title={po ? `${t("grnNew")}: ${po.number}` : t("grnNew")}
      footer={<><Button onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{t("grnNew")}</Button></>}>
      {po && (
        <div className="space-y-3">
          {err && <Notice tone="danger" locale={locale}>{err}</Notice>}
          <p className="text-sm text-fg-muted">{refs.supplierName(po.supplier_id)}</p>
          {refs.locations.length > 1 && (
            <Select label={t("location")} value={loc} onChange={(e) => setLoc(e.target.value)}>
              {refs.locations.filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          )}
          <DateInput label={t("date")} value={on} onChange={(e) => setOn(e.target.value)} />
          <Input label={t("invoiceNo")} value={invoice} onChange={(e) => setInvoice(e.target.value)} maxLength={100} />
          <ul className="space-y-3">
            {po.lines.map((l) => {
              const r = rows.find((x) => x.po_line_id === l.id);
              if (!r) return null;
              const item = refs.itemById(l.item_id);
              const left = remainingQty(l);
              return (
                <li key={l.id} className="space-y-2 rounded-xl border border-border p-3">
                  <p className="text-sm font-semibold text-fg">{refs.itemName(l.item_id)} <span className="tnum font-normal text-fg-subtle">({left} {l.unit_code} {t("remaining").toLowerCase()})</span></p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Input label={t("accepted")} aria-label={`${t("accepted")} ${refs.itemName(l.item_id)}`} inputMode="decimal" value={r.accepted} disabled={left === "0"}
                      error={r.accepted && !isQty(r.accepted) ? "0.000" : undefined} onChange={(e) => set(l.id, { accepted: e.target.value })} />
                    <Input label={t("rejected")} aria-label={`${t("rejected")} ${refs.itemName(l.item_id)}`} inputMode="decimal" value={r.rejected} onChange={(e) => set(l.id, { rejected: e.target.value })} />
                    <Input label={t("price")} aria-label={`${t("price")} ${refs.itemName(l.item_id)}`} inputMode="decimal" placeholder={trimDec(l.unit_price)} value={r.rate} onChange={(e) => set(l.id, { rate: e.target.value })} />
                    {item?.tracks_batches && <Input label={t("batchNo")} aria-label={`${t("batchNo")} ${refs.itemName(l.item_id)}`} value={r.batch_no} onChange={(e) => set(l.id, { batch_no: e.target.value })} />}
                  </div>
                  {item?.tracks_batches && <DateInput label={`${t("expiry")}: ${refs.itemName(l.item_id)}`} value={r.expiry} onChange={(e) => set(l.id, { expiry: e.target.value })} />}
                </li>);
            })}
          </ul>
          <Input label={t("note")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </div>
      )}
    </Dialog>
  );
}
