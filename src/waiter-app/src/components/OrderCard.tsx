"use client";
import { orderHref } from "@/lib/routes";
import Link from "next/link";
import { formatMoney } from "@/lib/money";
import { entryLabel, entryTotal, type OrderEntry } from "@/lib/orderEntries";
import { orderSyncState, type OrderSyncState } from "@/lib/queue/engine";
import type { DiningTable } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { StatusPill } from "./StatusPill";

export { mergeOrders, entryTotal, type OrderEntry } from "@/lib/orderEntries";

export function OrderCard({ e, tables, clash }: { e: OrderEntry; tables: DiningTable[]; clash?: boolean }) {
  const t = useT();
  const s = e.ops.length ? orderSyncState(e.ops) : null;
  const label = entryLabel(e, tables);
  const items = e.server ? e.server.lines.reduce((n, l) => n + l.quantity, 0) : 0;
  // The TRUE state from the queue: any failed step shows as failed, anything not yet accepted as waiting / sending; "confirmed" only when every step was.
  const orderState: OrderSyncState | null = s ? s.order : null;
  const id = e.server?.id ?? e.ref;
  const total = entryTotal(e);
  return (
    <Link className="card ordercard" href={orderHref(id)}>
      <div className="row between"><strong className="clip">{label}</strong>{total && <strong className="money">{formatMoney(total)}</strong>}</div>
      {items > 0 && <div className="small muted">{items} item{items === 1 ? "" : "s"}{e.server?.created_at ? ` · ${new Date(e.server.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</div>}
      <div className="row" style={{ flexWrap: "wrap", marginTop: 6 }}>
        {orderState && <StatusPill state={orderState} label="order" />}
        {s && s.kot !== "none" && <StatusPill state={s.kot} label="kot" />}
        {e.server && !e.ops.length && <span className="pill">{e.server.status === "sent_to_kitchen" ? "In kitchen" : e.server.status === "open" ? "Open" : e.server.status === "billed" ? "Billed" : "Cancelled"}</span>}
      </div>
      {clash && <div className="small" style={{ color: "var(--err)" }} role="status">{t("orders.clash")}</div>}
      {s?.error && s.order === "failed" && <div className="small" style={{ color: "var(--err)" }}>{s.error}</div>}
    </Link>
  );
}
