"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatMoney } from "@/lib/money";
import { clearReminded, lastRemindedAt, markReminded, remindCounter, remindWaitMs } from "@/lib/remind";

/**
 * A table whose bill was made and is not paid yet. The server refuses a new order on it unless it is explicitly a separate one, so
 * the waiter gets the reason in words and two ways forward: remind the counter (once a minute) or start a new order for the table.
 */
export function UnpaidBillCard({ total, orderId, onStartNew, children }: { total: string | null; orderId: string | null; onStartNew?: () => void; children?: React.ReactNode }) {
  const t = useT();
  const [msg, setMsg] = useState<string | null>(null);
  const [wait, setWait] = useState(() => (orderId ? remindWaitMs(lastRemindedAt(orderId), Date.now()) : 0));
  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait(orderId ? remindWaitMs(lastRemindedAt(orderId), Date.now()) : 0), Math.min(wait, 1000));
    return () => clearTimeout(id);
  }, [wait, orderId]);

  async function remind() {
    if (!orderId) return;
    const w = remindWaitMs(lastRemindedAt(orderId), Date.now());
    if (w > 0) { setWait(w); setMsg(t("bill.remindWait", { s: Math.ceil(w / 1000) })); return; }
    if (typeof navigator !== "undefined" && navigator.onLine === false) { setMsg(t("bill.needsConnection")); return; } // nothing is queued
    markReminded(orderId); setWait(remindWaitMs(lastRemindedAt(orderId), Date.now()));
    const r = await remindCounter(orderId, api.remindPayment, typeof navigator === "undefined" || navigator.onLine !== false);
    if (r.kind === "told") setMsg(t("bill.reminded"));
    else if (r.kind === "already") setMsg(t("bill.alreadyReminded"));
    else {
      clearReminded(orderId); setWait(0); // nothing went out: the waiter may try again at once
      // unsupported = an older server without the endpoint: the counter's own list has the bill, there is no bell for it.
      if (r.kind === "offline") setMsg(t("bill.needsConnection"));
      else if (r.kind === "unsupported") setMsg(t("bill.atCounter"));
      else if (r.kind === "refused") setMsg(r.message || t("bill.atCounter"));
      else setMsg(t("bill.remindFailed", { error: r.message }));
    }
  }

  const title = total ? t("bill.awaiting", { amount: formatMoney(total) }) : t("bill.awaitingNoAmt");
  return (
    <div className="card" role="group" aria-label={title} data-testid="unpaid-bill">
      <p style={{ marginTop: 0 }}><strong>{title}</strong></p>
      <p className="small muted">{t("bill.awaitingHelp")}</p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {orderId && <button className="btn" disabled={wait > 0} onClick={() => void remind()}>{t("bill.remind")}</button>}
        {onStartNew && <button className="btn primary" onClick={onStartNew}>{t("bill.startNew")}</button>}
        {children}
      </div>
      {wait > 0 && <p className="small muted" role="status">{t("bill.remindWait", { s: Math.ceil(wait / 1000) })}</p>}
      {msg && <p className="small" role="status">{msg}</p>}
    </div>
  );
}
