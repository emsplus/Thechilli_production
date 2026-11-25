"use client";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { LiveStamp } from "@/components/LiveStamp";
import { mergeOrders, OrderCard } from "@/components/OrderCard";
import { FailedOrders, failedEntries } from "@/components/FailedOrders";
import { useServerOrders } from "@/lib/serverOrders";
import { useLive } from "@/lib/liveSync";
import { useMenu } from "@/lib/menu";
import { useOnline, useQueue } from "@/lib/sync";
import { useEffect } from "react";
import { useTableStatus } from "@/lib/tableStatusHook";
import { useT } from "@/lib/i18n";
import { homeRoute } from "@/lib/capabilities";
import { isSessionExpiredMessage } from "@/lib/apiErrors";
import { useProfile } from "@/lib/capsStore";

export default function Orders() {
  const ops = useQueue();
  const { snap } = useMenu();
  const t = useT();
  const online = useOnline();
  const { status } = useTableStatus();
  const home = homeRoute(useProfile());
  const { orders, err } = useServerOrders("open,sent_to_kitchen");
  const live = useLive();
  const entries = mergeOrders(ops, orders, live.live ? live.at : null).filter((e) => !e.server || e.server.status === "open" || e.server.status === "sent_to_kitchen");
  const all = mergeOrders(ops, orders, live.live ? live.at : null);
  const nFailed = failedEntries(all).length;
  // "N orders could not be sent. Tap to review." lands here (#failed-orders): show the failed list, title first
  useEffect(() => {
    if (!nFailed || typeof window === "undefined" || window.location.hash !== "#failed-orders") return;
    const el = document.getElementById("failed-orders");
    el?.scrollIntoView({ block: "start" }); el?.focus({ preventScroll: true });
  }, [nFailed]);
  return (
    <AppShell title="Active orders">
      <LiveStamp />
      <FailedOrders entries={all} tables={snap?.tables ?? []} />
      {err && online && <div className="banner">{isSessionExpiredMessage(err) ? `${err}. Showing what is on this device; orders waiting to send stay saved.` : `Could not refresh from server (${err}). Showing what is on this device.`}</div>}
      {!entries.length && <div className="empty"><strong>No active orders</strong><p className="muted">Orders you send to the kitchen show here until they are billed.</p><Link className="btn primary" href={home}>{t("orders.take")}</Link></div>}
      {(snap?.tables ?? []).filter((tb) => status[tb.id]?.state === "clash").map((tb) => <div key={tb.id} className="banner err" role="alert">{t("orders.clashBanner", { name: tb.label })}</div>)}
      {entries.map((e) => {
        const tid = e.server?.table_id ?? (e.ops.find((o) => o.op.type === "create_order")?.op.type === "create_order" ? (e.ops.find((o) => o.op.type === "create_order")!.op as { order: { table_id: string | null } }).order.table_id : null);
        return <OrderCard key={e.ref} e={e} tables={snap?.tables ?? []} clash={!!tid && status[tid]?.state === "clash"} />;
      })}
    </AppShell>
  );
}
