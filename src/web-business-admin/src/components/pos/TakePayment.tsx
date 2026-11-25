"use client";

import { useRef, useState } from "react";
import { toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { PaySheet } from "@/app/pos/_components/PaySheet";
import { API_METHOD, type PayLine } from "@/app/pos/_components/pay-plan";
import type { Bill } from "@/lib/types";

/**
 * "Take payment" for a bill that is made but not paid, from the Orders list or its bill dialog. It is the counter's own pay sheet
 * (cash / card / UPI, tendered cash with change, split lines, one explicit confirm) and books each line with its own idempotency key
 * exactly like the counter does. Step-up rules are unchanged: the pay call is the same API call, the server decides.
 * `onPaid(bill)`: called with the bill as it stands now (paid in full, or part paid when a later line failed).
 */
export function TakePayment({ bill, onClose, onPaid }: { bill: Bill | null; onClose: () => void; onPaid: (b: Bill, settled: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<Bill | null>(null);
  const shown = fresh && bill && fresh.id === bill.id ? fresh : bill;
  const inflight = useRef(false);
  if (!bill || !shown) return null;
  async function pay(lines: PayLine[]) {
    if (inflight.current || !bill) return;
    inflight.current = true; setBusy(true);
    let booked = 0;
    try {
      for (const l of lines) { await api.pay(bill.id, { idempotency_key: l.key, method: API_METHOD[l.kind], amount: l.amount }); booked++; }
      const now = await api.bill(bill.id);
      setFresh(null);
      toast.success("Payment received", { description: now.invoice_number });
      onPaid(now, true); onClose();
    } catch (e) {
      if (booked > 0) { try { const now = await api.bill(bill.id); setFresh(now); onPaid(now, false); } catch { /* the next refresh shows it */ } }
      toast.error(e instanceof ApiError && e.status === 0 ? "No internet connection" : "Payment not taken", { description: e instanceof ApiError ? (e.status === 0 ? "Taking a payment here needs the connection. Use the counter to take it offline." : e.message) : "Please try again." });
    } finally { inflight.current = false; setBusy(false); }
  }
  return <PaySheet key={`${shown.id}:${shown.balance_due}`} open balance={shown.balance_due} currency={shown.currency} initialKind="cash" payeeName={shown.seller_name} busy={busy} onClose={onClose} onPay={pay} />;
}
