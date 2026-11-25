"use client";

import { Button, Checkbox, Dialog, Notice } from "@chilli/ui";
import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { cmpMoney, formatCurrency } from "@/lib/money";
import { autoPrintZ } from "@/lib/printing";
import type { ZReportData } from "@/lib/types";
import { uuid } from "@/lib/uuid";
import { formatLocal } from "./ReportPaper";
import { billedOf, hasTakingsSplit } from "@/lib/takings";
import { formatDate } from "@/lib/datetime";

export interface CloseWarning { id: string; title: string; text: string }

/** Everything that should make the owner pause before closing, taken from a fresh X report. */
export function closeWarnings(x: ZReportData): CloseWarning[] {
  const cur = x.restaurant.currency;
  const out: CloseWarning[] = [];
  if (x.completeness && !x.completeness.data_complete) {
    out.push({ id: "unsynced", title: "Some devices have unsynced sales", text: `${x.completeness.incomplete_reason ?? "A device is holding sales that have not reached the server."} If you close now, those bills will land in the NEXT Z-report.` });
  }
  const oo = x.open_items.open_orders, ub = x.open_items.unpaid_bills;
  if (oo.count > 0) out.push({ id: "open-orders", title: `${oo.count} open ${oo.count === 1 ? "order" : "orders"} (${formatCurrency(oo.amount, cur)})`, text: "Not billed yet, so not in this report. They will count in the next one once billed." });
  if (ub.count > 0 || cmpMoney(ub.balance, 0) > 0) out.push({ id: "unpaid", title: `${ub.count} unpaid ${ub.count === 1 ? "bill" : "bills"} (${formatCurrency(ub.balance, cur)} still to collect)`, text: "Their payments will be counted in the next report when they are paid." });
  x.warnings.forEach((w, i) => out.push({ id: `check-${i}`, title: "Report check failed", text: w }));
  return out;
}

/**
 * Confirmation before the irreversible close. The idempotency key is created once per dialog open and reused by every
 * retry, so a lost response or double tap can never close two days.
 */
export function CloseDayDialog({ open, onOpenChange, report, busy, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; report: ZReportData | null; busy: boolean;
  onConfirm: (key: string, autoPrint: boolean) => void;
}) {
  const key = useRef<string>("");
  const [ack, setAck] = useState(false);
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    if (!open) return;
    key.current = uuid();
    void Promise.resolve().then(() => { setAck(false); setAuto(autoPrintZ.get()); });
  }, [open]);

  if (!report) return null;
  const warnings = closeWarnings(report);
  const tz = report.period.timezone;
  const cur = report.restaurant.currency;
  const blocked = warnings.length > 0 && !ack;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }} title="Close the day?" description="This ends the trading period and creates the Z-report."
      footer={<div className="flex w-full gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" className="flex-1" iconStart={<Lock />} loading={busy} disabled={blocked} onClick={() => { autoPrintZ.set(auto); onConfirm(key.current, auto); }}>Yes, close the day</Button>
      </div>}>
      <div className="space-y-4 pb-3">
        <dl className="space-y-1.5 rounded-xl bg-surface-2 p-3 text-sm">
          <div className="flex justify-between gap-3"><dt className="text-fg-muted">From</dt><dd className="tnum text-right font-medium">{formatLocal(report.period.from, tz)}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-fg-muted">To (now)</dt><dd className="tnum text-right font-medium">{formatLocal(report.period.to, tz)}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-fg-muted">Orders</dt><dd className="tnum font-medium">{report.grand_total.orders}</dd></div>
          {hasTakingsSplit(report.deductions) && <div className="flex justify-between gap-3"><dt className="text-fg-muted">Total billed</dt><dd className="tnum text-right font-medium" data-testid="close-billed">{formatCurrency(billedOf(report.deductions), cur)}</dd></div>}
          <div className="flex items-baseline justify-between gap-3 border-t border-border pt-1.5"><dt className="font-semibold">{hasTakingsSplit(report.deductions) ? "Total takings (received)" : "Net takings"}</dt><dd className="tnum font-display text-lg font-extrabold" data-testid="close-takings">{formatCurrency(report.deductions.total_takings, cur)}</dd></div>
        </dl>
        {report.close_period?.first_close && <Notice tone="info" title="This is the first close"><span data-testid="first-close">This close covers {report.close_period.days} {report.close_period.days === 1 ? "day" : "days"} since {formatDate(report.close_period.from, tz)}.</span></Notice>}
        {report.empty && <p className="text-sm text-fg-muted">Nothing was sold in this period. Closing still saves an empty report and moves the start to now.</p>}

        {warnings.length > 0 && (
          <div className="space-y-2" data-testid="close-warnings">
            {warnings.map((w) => (
              <Notice key={w.id} tone={w.id === "unsynced" || w.id.startsWith("check") ? "danger" : "warning"} title={w.title}>{w.text}</Notice>
            ))}
            <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} label="I have read these warnings and want to close the day anyway" />
          </div>
        )}

        <p className="text-sm font-medium text-fg">Closing cannot be undone. The Z-report is saved for good and cannot be edited; the next report starts from this moment.</p>
        <Checkbox checked={auto} onChange={(e) => setAuto(e.target.checked)} label="Print the Z slip straight after closing" hint="Remembered on this device." />
      </div>
    </Dialog>
  );
}
