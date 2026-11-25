"use client";

import { useRef, useState } from "react";
import { Button, Dialog, Textarea } from "@chilli/ui";
import { useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/money";
import { uuid } from "@/lib/uuid";
import { isStepUpCancelled, withStepUp } from "@/lib/stepUpPrompt";
import type { Bill, VoidResult } from "@/lib/types";

const REASONS = ["Wrong order", "Customer left without paying", "Duplicate bill", "Test bill", "Other"] as const;
/** Statuses that mean the server does not have (or does not allow) the void route at all. */
const ABSENT = [404, 405, 501];

/**
 * "Void bill" (owner / manager, permission bills.void; the caller gates on can()). Reason is required (3-300 characters), then an
 * explicit confirm. A void cancels the whole bill with a credit note; it is NOT a refund. Any money returned to the customer is
 * handed back by hand: the dialog says so and shows the amount the server reports.
 * A 404 / 405 / 501 means this server has no void route: `onUnavailable` lets the caller hide the button for the session.
 */
export function VoidBillDialog({ bill, open, onClose, onDone, onUnavailable }: {
  bill: Bill; open: boolean; onClose: () => void; onDone: (r: VoidResult) => void; onUnavailable: () => void;
}) {
  const confirm = useConfirm();
  const [preset, setPreset] = useState<string>(REASONS[0]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<VoidResult | null>(null);
  const key = useRef(uuid()); // one key per dialog: a retry after a lost response never voids twice

  const other = preset === "Other";
  const reason = (other ? note : note.trim() ? `${preset}: ${note.trim()}` : preset).trim();
  const bad = reason.length < 3 || reason.length > 300;
  const paid = bill.payments.filter((p) => p.method !== "credit_note").reduce((s, p) => s + Number(p.amount), 0);

  async function submit() {
    if (bad) return;
    const ok = await confirm({ title: `Void ${bill.invoice_number}?`, tone: "danger", confirmLabel: "Yes, void the bill", cancelLabel: "Keep bill",
      description: "The whole bill is cancelled with a credit note. This cannot be undone." });
    if (!ok) return;
    setBusy(true); setErr(null);
    // With STEP_UP_REQUIRED on the server, a void asks for the PIN again first (docs/STAFF_PIN_DEVICES_API.md 5).
    try { const r = await withStepUp(() => api.voidBill(bill.id, { reason, idempotency_key: key.current }), "void this bill"); setResult(r); onDone(r); }
    catch (e) {
      if (isStepUpCancelled(e)) { setErr("Not voided: your PIN is needed to void a bill."); return; }
      if (e instanceof ApiError && ABSENT.includes(e.status)) { onUnavailable(); setErr("This server does not support voiding bills yet."); }
      else setErr(e instanceof ApiError ? e.message : "Could not void the bill");
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title={result ? "Bill voided" : "Void this bill?"}
      description={result ? bill.invoice_number : `${bill.invoice_number}, ${formatCurrency(bill.total, bill.currency)}. The whole bill is cancelled and stays on record with a credit note.`}
      footer={result
        ? <Button variant="primary" className="w-full" onClick={onClose}>Done</Button>
        : <><Button variant="secondary" onClick={onClose} disabled={busy}>Keep bill</Button><Button variant="danger-soft" onClick={() => void submit()} loading={busy} disabled={bad}>Void bill</Button></>}>
      {result ? (
        <div className="space-y-2 pb-3 text-sm" role="status">
          <p className="font-medium text-fg">The bill is cancelled.</p>
          {result.refund_due && Number(result.refund_due.amount) > 0 && <p data-testid="void-refund-due" className="rounded-lg bg-warning-soft px-3 py-2 font-semibold text-warning-fg">Hand {formatCurrency(result.refund_due.amount, bill.currency)} back to the customer.</p>}
          <p className="text-fg-muted">Money returned to the customer is handed back manually. Nothing is sent to a card or UPI provider.</p>
        </div>
      ) : (
        <div className="space-y-4 pb-3">
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-fg">Reason</legend>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Reason">
              {REASONS.map((r) => (
                <button key={r} type="button" role="radio" aria-checked={preset === r} onClick={() => setPreset(r)}
                  className={cn("min-h-11 rounded-full border px-4 text-sm font-semibold transition-colors", preset === r ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border-strong bg-surface text-fg-muted hover:bg-surface-2")}>{r}</button>
              ))}
            </div>
          </fieldset>
          <Textarea label={other ? "Describe the reason" : "Add a note (optional)"} value={note} maxLength={300} rows={2} onChange={(e) => setNote(e.target.value)}
            error={other && note.length > 0 && bad ? "At least 3 characters" : undefined} />
          {paid > 0 && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg-muted">This bill was paid. Any money returned to the customer is handed back manually; nothing is refunded to a card or UPI provider.</p>}
          {err && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm font-medium text-danger-fg">{err}</p>}
        </div>
      )}
    </Dialog>
  );
}
