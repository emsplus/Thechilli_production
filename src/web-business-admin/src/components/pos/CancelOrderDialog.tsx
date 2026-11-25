"use client";

import { useState } from "react";
import { Dialog, Button, Textarea } from "@chilli/ui";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";

const REASONS = ["Customer changed their mind", "Wrong items entered", "Duplicate order", "Customer left", "Kitchen could not make it", "Other"] as const;

/**
 * Asks why an unbilled order is being cancelled (POST /orders/{id}/cancel needs 3-300 chars).
 * `onConfirm` should throw to keep the dialog open; ApiError messages are shown inline.
 */
export function CancelOrderDialog({ open, onOpenChange, onConfirm, subject }: {
  open: boolean; onOpenChange: (o: boolean) => void; onConfirm: (reason: string) => Promise<void>; subject: string;
}) {
  const [preset, setPreset] = useState<string>(REASONS[0]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const other = preset === "Other";
  const reason = (other ? note : note.trim() ? `${preset}: ${note.trim()}` : preset).trim();
  const tooShort = reason.length < 3;
  const tooLong = reason.length > 300;
  const fieldError = tooLong ? "Keep the reason under 300 characters" : other && tooShort && note.length > 0 ? "At least 3 characters" : undefined;

  async function submit() {
    if (tooShort || tooLong) return;
    setBusy(true); setErr(null);
    try { await onConfirm(reason); onOpenChange(false); setNote(""); setPreset(REASONS[0]); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not cancel the order"); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }} title="Cancel this order?"
      description={`${subject} has not been billed. Any tickets still waiting in the kitchen will be cancelled too. This cannot be undone.`}
      footer={<>
        <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Keep order</Button>
        <Button variant="danger-soft" onClick={() => void submit()} loading={busy} disabled={tooShort || tooLong}>Cancel order</Button>
      </>}>
      <fieldset className="mb-4">
        <legend className="mb-2 text-sm font-medium text-fg">Reason</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Reason">
          {REASONS.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={preset === r} onClick={() => setPreset(r)}
              className={cn("min-h-11 rounded-full border px-4 text-sm font-semibold transition-colors",
                preset === r ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border-strong bg-surface text-fg-muted hover:bg-surface-2")}>
              {r}
            </button>
          ))}
        </div>
      </fieldset>
      <Textarea label={other ? "Describe the reason" : "Add a note (optional)"} value={note} maxLength={300} rows={2}
        onChange={(e) => setNote(e.target.value)} error={fieldError} />
      {err && <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm font-medium text-danger-fg">{err}</p>}
    </Dialog>
  );
}
