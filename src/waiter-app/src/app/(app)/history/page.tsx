"use client";
import { AppShell } from "@/components/AppShell";
import { mergeOrders, OrderCard } from "@/components/OrderCard";
import { useMenu } from "@/lib/menu";
import { useServerOrders } from "@/lib/serverOrders";

export default function History() {
  const { snap } = useMenu();
  const { orders, err } = useServerOrders("billed,cancelled");
  const entries = mergeOrders([], orders);
  return (
    <AppShell title="Order history">
      {err && <div className="banner">Could not load history ({err}).</div>}
      {!entries.length && !err && <p className="muted">No completed orders yet.</p>}
      {entries.map((e) => <OrderCard key={e.ref} e={e} tables={snap?.tables ?? []} />)}
    </AppShell>
  );
}
