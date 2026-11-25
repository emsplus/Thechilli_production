"use client";
import type { OrderSyncState } from "@/lib/queue/engine";
import { useT, type Key } from "@/lib/i18n";

const TEXT: Record<OrderSyncState, Key> = { queued: "sp.queued", sending: "sp.sending", confirmed: "sp.confirmed", failed: "sp.failed" };
const CLS: Record<OrderSyncState, string> = { queued: "pending", sending: "pending", confirmed: "synced", failed: "failed" };

/** Text + class: status never relies on colour alone. `label` is "order" or "kot". */
export function StatusPill({ state, label }: { state: OrderSyncState; label?: "order" | "kot" }) {
  const t = useT();
  return <span className={`pill ${CLS[state]}`}>{label ? `${t(label === "kot" ? "sp.kot" : "sp.order")}: ` : ""}{t(TEXT[state])}</span>;
}
