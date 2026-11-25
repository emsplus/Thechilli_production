"use client";
import { UnpaidBillCard } from "@/components/UnpaidBillCard";
import { NOT_AVAILABLE_CODE } from "@/lib/capabilities";
import { useT } from "@/lib/i18n";
import { formatMoney } from "@/lib/money";
import { entryLabel, entryTotal, type OrderEntry } from "@/lib/orderEntries";
import { TABLE_HAS_OPEN_ORDER, orderSyncState } from "@/lib/queue/engine";
import { engine, retryNow } from "@/lib/sync";
import type { DiningTable } from "@/lib/types";

/** Entries with a step the server refused (or that could not be sent for good). */
export const failedEntries = (entries: OrderEntry[]): OrderEntry[] => entries.filter((e) => e.ops.some((o) => o.status === "failed"));

/**
 * The failed-orders list: every order that could not be sent, with the reason and Retry / Discard on each (what the
 * "N orders could not be sent. Tap to review." link opens). A table that has a bill waiting for payment gets the plain-words card
 * with its two ways forward instead of a dead "rejected" message.
 */
export function FailedOrders({ entries, tables }: { entries: OrderEntry[]; tables: DiningTable[] }) {
  const t = useT();
  const failed = failedEntries(entries);
  return (
    <section id="failed-orders" tabIndex={-1} aria-label={t("orders.failedTitle")} data-testid="failed-orders" style={{ outline: "none", display: failed.length ? undefined : "none" }}>
      {failed.length > 0 && (
        <>
          <h2 className="sec">{t("orders.failedTitle")}</h2>
          <p className="small muted">{t("orders.failedHint")}</p>
          {failed.map((e) => <FailedOrder key={e.ref} e={e} tables={tables} />)}
        </>
      )}
    </section>
  );
}

function FailedOrder({ e, tables }: { e: OrderEntry; tables: DiningTable[] }) {
  const t = useT();
  const s = orderSyncState(e.ops);
  const label = entryLabel(e, tables);
  const total = entryTotal(e);
  const conflicts = e.ops.flatMap((o) => o.conflicts ?? []);
  const existing = (s.errorDetails?.existing_order ?? null) as { bill_id?: string; total?: string; order_id?: string } | null;
  const blocked = s.errorCode === TABLE_HAS_OPEN_ORDER;
  const discard = () => void engine.discard(e.ref);
  return (
    <div className="card failedorder" role="group" aria-label={`${label}: ${t("sp.failed")}`} data-testid="failed-order" style={{ borderColor: "var(--err)" }}>
      <div className="row between"><strong className="clip">{label}</strong>{total && <strong className="money">{formatMoney(total)}</strong>}</div>
      {blocked && existing?.bill_id ? (
        <UnpaidBillCard total={existing.total ?? null} orderId={typeof s.errorDetails?.existing_order_id === "string" ? s.errorDetails.existing_order_id : (existing.order_id ?? null)}
          onStartNew={() => void retryNow(e.ref, false, true)}>
          <button className="btn danger" onClick={discard}>{t("order.discard")}</button>
        </UnpaidBillCard>
      ) : (
        <>
          <div className="small" style={{ color: "var(--err)" }} role="alert">{s.error ?? t("order.rejected")}</div>
          {conflicts.map((c, i) => <div key={i} className="small">{t("order.priceChanged", { item: c.item, expected: c.expected, current: c.current })}</div>)}
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
            {s.errorCode !== NOT_AVAILABLE_CODE && <button className="btn" onClick={() => void retryNow(e.ref, conflicts.length > 0)}>{conflicts.length ? t("order.acceptPrices") : t("order.retry")}</button>}
            {blocked && <button className="btn primary" onClick={() => void retryNow(e.ref, false, true)}>{t("bill.startNew")}</button>}
            <button className="btn danger" onClick={discard}>{t("order.discard")}</button>
          </div>
        </>
      )}
    </div>
  );
}
