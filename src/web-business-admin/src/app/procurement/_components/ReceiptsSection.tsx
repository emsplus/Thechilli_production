"use client";

import { useState } from "react";
import { Undo2 } from "lucide-react";
import { Badge, Button, Dialog, Input, Notice, Sheet } from "@chilli/ui";
import { DataTable, type DataColumn } from "@chilli/ui/data";
import { toast } from "@/components/ui";
import { InlineInput } from "@/components/inline-fields";
import { useLocale, useMsg } from "@/lib/i18n";
import { inv, isQty, PERM, trimDec, type GoodsReceipt, type PurchaseReturn } from "@/lib/inventoryApi";
import { formatCurrency } from "@/lib/money";
import { prettyQty } from "@/lib/units";
import { useCurrency } from "@/lib/taxConfig";
import { useCan } from "@/lib/useRole";
import { INV_MSG } from "./messages";
import { errText, fmtDate, Gate, useIdempotencyKey, useRefs, useSection } from "./shared";

export function ReceiptsSection() {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const cur = useCurrency();
  const refs = useRefs();
  const { can } = useCan();
  const { state, reload } = useSection(() => inv.receipts(), []);
  const returns = useSection(() => inv.returns(), []);
  const [view, setView] = useState<GoodsReceipt | null>(null);
  const [ret, setRet] = useState<GoodsReceipt | null>(null);

  const cols: DataColumn<GoodsReceipt>[] = [
    { key: "number", header: t("number"), sortValue: (g) => g.number, render: (g) => <button type="button" className="min-h-11 font-semibold text-primary underline-offset-2 hover:underline" onClick={() => setView(g)}>{g.number}</button> },
    { key: "supplier", header: t("supplier"), sortValue: (g) => refs.supplierName(g.supplier_id), render: (g) => refs.supplierName(g.supplier_id) },
    { key: "date", header: t("date"), sortValue: (g) => g.received_on, csv: (g) => g.received_on, render: (g) => fmtDate(g.received_on) },
    { key: "invoice", header: t("invoiceNo"), sortValue: (g) => g.supplier_invoice_no ?? "", render: (g) => g.supplier_invoice_no ?? "" },
    { key: "total", header: t("total"), align: "end", sortValue: (g) => Number(g.total), csv: (g) => g.total, render: (g) => <span className="tnum">{formatCurrency(g.total, cur)}</span> },
  ];
  const retCols: DataColumn<PurchaseReturn>[] = [
    { key: "number", header: t("number"), sortValue: (r) => r.number, render: (r) => r.number },
    { key: "supplier", header: t("supplier"), sortValue: (r) => refs.supplierName(r.supplier_id), render: (r) => refs.supplierName(r.supplier_id) },
    { key: "reason", header: t("returnReason"), sortValue: (r) => r.reason, render: (r) => r.reason },
    { key: "total", header: t("total"), align: "end", sortValue: (r) => Number(r.total), csv: (r) => r.total, render: (r) => <span className="tnum">{formatCurrency(r.total, cur)}</span> },
  ];

  return (
    <section aria-label={t("receipts")} className="space-y-6">
      <Gate state={state} reload={() => void reload()}>
        {(rows) => <DataTable caption={t("receipts")} columns={cols} rows={rows} getKey={(g) => g.id} exportName="goods-receipts" locale={locale}
          empty={<div className="py-8 text-center"><p className="font-semibold text-fg">{t("grnEmpty")}</p><p className="mt-1 text-sm text-fg-muted">{t("grnEmptyHint")}</p></div>} />}
      </Gate>
      {returns.state.status === "ready" && returns.state.data.length > 0 && (
        <div>
          <h2 className="mb-2 font-display text-lg font-bold text-fg">{t("returnsTitle")}</h2>
          <DataTable caption={t("returnsTitle")} columns={retCols} rows={returns.state.data} getKey={(r) => r.id} locale={locale} />
        </div>
      )}
      <Sheet side="right" open={!!view} onOpenChange={(o) => { if (!o) setView(null); }} locale={locale} title={view ? `${view.number} · ${refs.supplierName(view.supplier_id)}` : t("receipts")}
        description={view ? `${fmtDate(view.received_on)}${view.location_id ? ` · ${refs.locationName(view.location_id)}` : ""}` : undefined}
        footer={view && can(PERM.purchases) ? <Button iconStart={<Undo2 />} onClick={() => { setRet(view); setView(null); }}>{t("returnNew")}</Button> : undefined}>
        {view && (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {view.lines.map((l) => (
              <li key={l.id} className="px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-3"><span className="font-medium text-fg">{refs.itemName(l.item_id)}</span><span className="tnum">{formatCurrency(l.net, cur)}</span></div>
                <p className="tnum text-xs text-fg-subtle">{t("accepted")} {trimDec(l.quantity)} {l.unit_code}{Number(l.rejected_quantity) > 0 ? ` · ${t("rejected")} ${trimDec(l.rejected_quantity)}` : ""}</p>
                {(l.batch_no || l.expiry_date) && <p className="mt-1 flex flex-wrap gap-1"><Badge tone="info">{t("batchNo")} {l.batch_no ?? "-"}</Badge>{l.expiry_date && <Badge tone="neutral">{t("expiry")} {fmtDate(l.expiry_date)}</Badge>}</p>}
              </li>))}
          </ul>
        )}
      </Sheet>
      <ReturnDialog grn={ret} onClose={() => setRet(null)} onDone={() => { setRet(null); void returns.reload(); void reload(); }} />
    </section>
  );
}

/** Return goods from a receipt. Quantities are in the item's base unit and capped at what was received minus what was already returned. */
function ReturnDialog({ grn, onClose, onDone }: { grn: GoodsReceipt | null; onClose: () => void; onDone: () => void }) {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const refs = useRefs();
  const key = useIdempotencyKey();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  if ((grn?.id ?? null) !== shown) { setShown(grn?.id ?? null); setQty({}); setReason(""); setErr(null); key.renew(); }

  async function save() {
    if (!grn) return;
    const lines = grn.lines.filter((l) => isQty(qty[l.id] ?? "")).map((l) => ({ grn_line_id: l.id, quantity: qty[l.id].trim() }));
    if (!lines.length || !reason.trim()) { setErr(!reason.trim() ? t("returnReason") : t("nothingToReceive")); return; }
    setBusy(true); setErr(null);
    try { await inv.createReturn({ idempotency_key: key.get(), grn_id: grn.id, reason: reason.trim(), lines }); toast.success(t("returnSaved")); onDone(); }
    catch (e) { setErr(errText(e, "Could not record the return")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!grn} onOpenChange={(o) => { if (!o) onClose(); }} locale={locale} title={grn ? `${t("returnNew")}: ${grn.number}` : t("returnNew")}
      footer={<><Button onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{t("returnNew")}</Button></>}>
      {grn && (
        <div className="space-y-3">
          {err && <Notice tone="danger" locale={locale}>{err}</Notice>}
          <Input label={t("returnReason")} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          {grn.lines.map((l) => {
            const unit = refs.itemById(l.item_id)?.base_unit ?? "";
            const room = Number(l.quantity_base) - Number(l.returned_base);
            return (
              <div key={l.id} className="flex items-center gap-3">
                <p className="min-w-0 flex-1 text-sm"><span className="font-medium text-fg">{refs.itemName(l.item_id)}</span><br /><span className="tnum text-xs text-fg-subtle">{prettyQty(String(Math.max(room, 0)), unit)}</span></p>
                <InlineInput aria-label={`${t("qty")} ${refs.itemName(l.item_id)} (${unit})`} wrapperClassName="w-28" inputMode="decimal" placeholder={unit} disabled={room <= 0} value={qty[l.id] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))} />
              </div>);
          })}
        </div>
      )}
    </Dialog>
  );
}
