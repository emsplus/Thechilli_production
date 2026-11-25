"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Clock, Printer, Send } from "lucide-react";
import { toast } from "@/components/ui";
import { Badge, Button } from "@chilli/ui";
import type { BadgeTone } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import { JOB_STATE, jobBusy, latestPerPrinter, plainError, useHasPrinters } from "@/lib/printJobs";
import type { PrintJob } from "@/lib/types";

const TONE: Record<PrintJob["status"], BadgeTone> = { queued: "warning", sent: "info", printed: "success", failed: "danger" };
const ICON: Record<PrintJob["status"], React.ReactNode> = { queued: <Clock />, sent: <Send />, printed: <CircleCheck />, failed: <CircleAlert /> };

/**
 * "Print" on a restaurant thermal printer for a finalized bill or a KOT, plus the latest job state of that document. Renders nothing
 * until at least one active printer exists, so a restaurant without printers sees the POS exactly as before. Printing is a request
 * to the server's queue and never blocks the sale; `onPdf` (the existing PDF print) is offered when the device is offline.
 */
export function ThermalPrint({ kind, refId, onPdf }: { kind: "bill" | "kot"; refId: string; onPdf?: () => void }) {
  const has = useHasPrinters();
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { api.printJobs({ ref_id: refId }).then(setJobs).catch(() => { /* the status line just stays as it was */ }); }, [refId]);
  useEffect(() => { if (has) void Promise.resolve().then(load); }, [has, load]);
  const live = jobs.some(jobBusy);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [live, load]);

  if (!has) return null;

  async function print() {
    setBusy(true);
    try {
      const r = kind === "bill" ? await api.printBill(refId) : await api.printKot(refId);
      const names = [...new Set(r.jobs.map((j) => j.printer_name).filter(Boolean))].join(", ");
      toast.success(`Sent to ${names || "the printer"}`, { description: "Queued: the hub prints it in a moment." });
      load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        toast.error("This device is offline, so the print was not sent", { description: onPdf ? "Print the PDF instead." : undefined, action: onPdf ? { label: "Print PDF", onClick: onPdf } : undefined });
      } else toast.error(e instanceof ApiError ? e.message : "Could not send to the printer");
    } finally { setBusy(false); }
  }

  const latest = latestPerPrinter(jobs);
  return (
    <div className="space-y-1.5" data-testid={`thermal-print-${kind}`}>
      <Button className="w-full" variant="secondary" loading={busy} iconStart={<Printer />} onClick={() => void print()}>{kind === "bill" ? "Print" : "Print KOT slip"}</Button>
      {latest.length > 0 && (
        <ul aria-live="polite" data-testid="print-status" className="space-y-1">
          {latest.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-muted">
              <Badge tone={TONE[j.status]}>{ICON[j.status]}{j.printer_name ?? "Printer"}: {JOB_STATE[j.status]}</Badge>
              {j.status === "failed" && <span className="text-danger-fg">{plainError(j.last_error)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
