"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Download, FileSpreadsheet, SkipForward } from "lucide-react";
import { Badge, Button, Dialog, Notice, Table } from "@chilli/ui";
import { InlineTextarea } from "@/components/inline-fields";
import { toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { downloadCsv } from "@/lib/csv";
import { CSV_TEMPLATE, parseStockSheet, toBulkItems } from "@/lib/stockCsv";
import type { BulkCreateResult } from "@/lib/types";
import { uuid } from "@/lib/uuid";

const MAX_ROWS = 500;

/** Import a stock list: paste cells from Excel / Google Sheets, or drop a .csv. Rows are checked here, then created in one go. */
export function ImportStockDialog({ open, onOpenChange, existingNames, onDone, onViewStock }: {
  open: boolean; onOpenChange: (o: boolean) => void; existingNames: string[]; onDone: () => void; onViewStock: (ids: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<BulkCreateResult | null>(null);
  const key = useRef(uuid());
  const file = useRef<HTMLInputElement>(null);

  const sheet = useMemo(() => parseStockSheet(text, existingNames), [text, existingNames]);
  const ok = sheet.rows.filter((r) => r.status === "ok");
  const skipped = sheet.rows.filter((r) => r.status === "duplicate" || r.status === "existing").length;
  const bad = sheet.rows.filter((r) => r.status === "error").length;
  const tooMany = ok.length > MAX_ROWS;

  async function readFile(f: File | undefined) {
    if (!f) return;
    if (/\.(xlsx|xls|numbers|ods)$/i.test(f.name)) { setErr("That is a spreadsheet file. In Excel choose Save As > CSV, or select the cells and paste them here."); return; }
    if (f.size > 2 * 1024 * 1024) { setErr("That file is too large for an import (2 MB). Split it into smaller lists."); return; }
    setErr(null); setText(await f.text());
  }

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await api.bulkCreateItems({ idempotency_key: key.current, items: toBulkItems(sheet.rows) });
      setResult(r); onDone();
      toast.success(`${r.created.length} item${r.created.length === 1 ? "" : "s"} imported`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not import the list"); } finally { setBusy(false); }
  }

  function again() { setResult(null); setText(""); setErr(null); key.current = uuid(); }

  const resultBody = result && (
    <div className="space-y-3 py-2" role="status">
      <p className="flex items-center gap-2 font-display text-lg font-bold text-fg"><CheckCircle2 aria-hidden className="size-6 text-success" />{result.created.length} item{result.created.length === 1 ? "" : "s"} created</p>
      <dl className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-success-soft px-2 py-3 text-success-fg"><dt className="text-xs font-medium">Created</dt><dd className="tnum font-display text-2xl font-extrabold">{result.created.length}</dd></div>
        <div className="rounded-xl bg-surface-2 px-2 py-3"><dt className="text-xs font-medium text-fg-muted">Opening stock set</dt><dd className="tnum font-display text-2xl font-extrabold">{result.movements}</dd></div>
        <div className="rounded-xl bg-surface-2 px-2 py-3"><dt className="text-xs font-medium text-fg-muted">Already existed</dt><dd className="tnum font-display text-2xl font-extrabold">{result.existing.length}</dd></div>
      </dl>
      {skipped + bad > 0 && <p className="text-sm text-fg-muted">{skipped + bad} row{skipped + bad === 1 ? " was" : "s were"} left out (duplicates, items you already had, or rows with problems).</p>}
      <p className="text-sm text-fg-muted">Next: scan a supplier invoice and map its lines to these items. Opening stock shows in each item&apos;s ledger as “Opening stock (import)”.</p>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={result ? "Stock list imported" : "Import stock list"}
      description={result ? undefined : "Paste rows from Excel or Google Sheets, or drop a CSV file. You see every row checked before anything is created."}
      footer={result
        ? <><Button variant="secondary" onClick={again}>Import another list</Button><Button variant="primary" iconStart={<CheckCircle2 />} onClick={() => { onViewStock(result.created.map((i) => i.id)); onOpenChange(false); }}>View stock list</Button></>
        : <><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" iconStart={<Check />} loading={busy} disabled={!ok.length || tooMany} onClick={() => void submit()}>{ok.length ? `Import ${ok.length} item${ok.length === 1 ? "" : "s"}` : "Import"}</Button></>}>
      {result ? resultBody : <div className="space-y-4 py-2">
        {err && <Notice tone="danger">{err}</Notice>}
        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); void readFile(e.dataTransfer.files?.[0]); }}
          className={cn("rounded-xl border-2 border-dashed p-3 transition-colors sm:p-4", drag ? "border-primary bg-primary-soft" : "border-border-strong bg-surface")}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" iconStart={<FileSpreadsheet />} onClick={() => file.current?.click()}>Choose CSV file</Button>
            <Button size="sm" variant="ghost" iconStart={<Download />} onClick={() => downloadCsv("stock-list-template.csv", CSV_TEMPLATE)}>Download template</Button>
            <input ref={file} type="file" aria-label="CSV file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" tabIndex={-1} onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
          <InlineTextarea aria-label="Paste your list" rows={5} placeholder={"name\tunit\topening_quantity\treorder_level\tunit_cost\nBasmati Rice\tkg\t40\t10\t180"} spellCheck={false}
            className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
          <p className="mt-2 text-xs text-fg-subtle">Columns: <span className="font-mono">name, unit, opening_quantity, reorder_level, unit_cost</span>. The header row is optional. Quantities, reorder level and cost are all in the row&apos;s unit (20 kg, reorder at 5 kg, ₹180 per kg). Units: kg, g, l, ml, pcs, dozen.</p>
        </div>

        {tooMany && <Notice tone="warning">Import up to {MAX_ROWS} items at a time. Split this list in two.</Notice>}
        {sheet.rows.length > 0 && (
          <>
            <p aria-live="polite" className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="success">{<Check />}{ok.length} ready</Badge>
              {skipped > 0 && <Badge tone="neutral">{<SkipForward />}{skipped} skipped</Badge>}
              {bad > 0 && <Badge tone="danger">{<AlertTriangle />}{bad} need fixing</Badge>}
              {bad > 0 && <span className="text-xs text-fg-subtle">Fix the cells above, or import the rows that are ready.</span>}
            </p>
            <Table caption="Import preview" getKey={(r) => String(r.row)} rows={sheet.rows} columns={[
              { key: "row", header: "Row", render: (r) => <span className="tnum text-fg-subtle">{r.row}</span> },
              { key: "name", header: "Name", render: (r) => <span className="font-medium">{r.name || "(empty)"}</span> },
              { key: "unit", header: "Unit", render: (r) => r.unit },
              { key: "open", header: "Opening", align: "end", render: (r) => r.opening },
              { key: "reorder", header: "Reorder", align: "end", render: (r) => r.reorder },
              { key: "cost", header: "Cost", align: "end", render: (r) => r.cost },
              { key: "check", header: "Check", render: (r) => (
                <span className="text-xs">
                  {r.status === "ok" ? <span className="font-semibold text-success-fg">Ready</span>
                    : r.status === "error" ? <span role="alert" className="font-medium text-danger-fg">{r.errors.join(". ")}</span>
                      : <span>{r.note}</span>}
                </span>) },
            ]} />
          </>
        )}
      </div>}
    </Dialog>
  );
}
