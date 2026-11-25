"use client";

import { useEffect, useState } from "react";
import { Check, FileSpreadsheet, PencilLine, ScanLine } from "lucide-react";
import { Button } from "@chilli/ui";
import { Card } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useCan } from "@/lib/useRole";
import type { Purchase } from "@/lib/types";
import { useManage } from "./manage-context";

const STEPS = ["Scan invoice", "Check the lines", "Confirm", "Stock updated"] as const;

/** The whole chain in one line: Invoice -> Scan -> Review -> Confirm -> Stock. `step` highlights where you are. */
export function StockFlowStrip({ step, className }: { step?: 1 | 2 | 3 | 4; className?: string }) {
  return (
    <ol aria-label="How invoices become stock" className={cn("grid grid-cols-2 gap-2 sm:grid-cols-4", className)}>
      {STEPS.map((label, i) => {
        const n = i + 1;
        const on = step === n, done = !!step && n < step;
        return (
          <li key={label} aria-current={on ? "step" : undefined}
            className={cn("flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-sm transition-colors", on ? "border-primary/30 bg-primary-soft text-primary-soft-fg" : "border-border bg-surface-2/50 text-fg-muted")}>
            <span aria-hidden className={cn("tnum grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold", on ? "bg-primary text-primary-fg" : done ? "bg-success-soft text-success-fg" : "bg-surface-3 text-fg-muted")}>
              {done ? <Check className="size-3.5" /> : n}
            </span>
            <span className={cn("min-w-0 leading-tight", on && "font-semibold")}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Invoices read by OCR that wait for a human check. Refetches whenever `refreshKey` changes. */
export function useDrafts(refreshKey?: unknown): { drafts: Purchase[]; loading: boolean } {
  const [drafts, setDrafts] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const { feature } = useCan();
  const hasInventory = feature("inventory"); // purchases belong to the inventory module: a plan without it answers 403
  useEffect(() => {
    let off = false;
    if (!hasInventory) { void Promise.resolve().then(() => { if (!off) setLoading(false); }); return () => { off = true; }; }
    api.purchases().then((p) => { if (!off) setDrafts(p.filter((x) => x.status === "extracted")); }).catch(() => { /* the strip is optional */ }).finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [refreshKey, hasInventory]);
  return { drafts, loading };
}

export function WaitingLink({ count, onClick, className }: { count: number; onClick: () => void; className?: string }) {
  if (count <= 0) return null;
  return (
    <button type="button" onClick={onClick} className={cn("rounded-md text-sm font-semibold text-primary-soft-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", className)}>
      {count} invoice{count === 1 ? "" : "s"} waiting for your review
    </button>
  );
}

/** Card used on Overview and the Suppliers tab: what the scan flow is, a way in, and drafts waiting. */
export function ScanInvoiceCard({ from }: { from: "overview" | "suppliers" }) {
  const { goto } = useManage();
  const { drafts } = useDrafts();
  const open = () => goto("suppliers", "invoices", { from });
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold text-fg">Scan an invoice</h2>
          <p className="mt-0.5 text-sm text-fg-muted">Photograph or upload a supplier invoice. We read it, you check it, and stock goes up.</p>
        </div>
        <Button variant="primary" iconStart={<ScanLine />} onClick={open}>Scan invoice</Button>
      </div>
      <StockFlowStrip step={drafts.length ? 2 : undefined} className="mt-4" />
      {drafts.length > 0 && <p className="mt-3"><WaitingLink count={drafts.length} onClick={() => goto("suppliers", "invoices", { from })} /></p>}
    </Card>
  );
}

/**
 * First-run guidance for an empty stock list: the three ways in, scanning first. Used on Overview and the Inventory tab,
 * so each caller says what the second and third buttons do (open a dialog here, or jump to the Inventory tab).
 */
export function StartStockCard({ from, onImport, onAdd, className }: { from: "overview" | "inventory"; onImport: () => void; onAdd: () => void; className?: string }) {
  const { goto } = useManage();
  return (
    <Card className={cn("bg-gradient-to-br from-primary-soft/60 to-surface", className)}>
      <section aria-label="Start your stock list">
        <h2 className="font-display text-xl font-extrabold tracking-tight text-fg">Start your stock list</h2>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">Your stock list is empty. The quickest way to fill it is to scan the invoices your suppliers already gave you. Items are created from the lines, you check them, and stock goes up.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-[1.25fr_1fr_1fr]">
          <div className="flex flex-col items-start gap-3 rounded-2xl border border-primary/30 bg-surface p-4 shadow-card">
            <span className="grid size-10 place-items-center rounded-xl bg-primary-soft text-primary-soft-fg"><ScanLine aria-hidden className="size-5" /></span>
            <div className="min-w-0 flex-1"><h3 className="font-display text-base font-bold text-fg">Scan a supplier invoice</h3><p className="mt-0.5 text-sm text-fg-muted">Upload a photo or PDF. We read the lines and create the stock items for you.</p></div>
            <Button variant="primary" iconStart={<ScanLine />} onClick={() => goto("suppliers", "invoices", { from })}>Scan a supplier invoice</Button>
          </div>
          <div className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card">
            <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-fg-muted"><FileSpreadsheet aria-hidden className="size-5" /></span>
            <div className="min-w-0 flex-1"><h3 className="font-display text-base font-bold text-fg">Import a spreadsheet</h3><p className="mt-0.5 text-sm text-fg-muted">Already keep a stock list in Excel? Paste it or drop a CSV.</p></div>
            <Button variant="secondary" iconStart={<FileSpreadsheet />} onClick={onImport}>Import a spreadsheet</Button>
          </div>
          <div className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card">
            <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-fg-muted"><PencilLine aria-hidden className="size-5" /></span>
            <div className="min-w-0 flex-1"><h3 className="font-display text-base font-bold text-fg">Add items one by one</h3><p className="mt-0.5 text-sm text-fg-muted">Only a few things to track? Type them in.</p></div>
            <Button variant="secondary" iconStart={<PencilLine />} onClick={onAdd}>Add items one by one</Button>
          </div>
        </div>
      </section>
    </Card>
  );
}
