"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Clock3, LayoutDashboard, ReceiptText, Wallet } from "lucide-react";
import { IconButton } from "@chilli/ui";
import { TopBarSlot } from "@/components/shell/topbar-slot";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatCompactMoney, formatCurrency } from "@/lib/money";
import { getTaxConfig } from "@/lib/taxConfig";
import { todayRange } from "@/lib/today";
import { ticketWaitState } from "@/lib/ticketAge";
import { useKitchenTarget } from "@/lib/kitchenTarget";
import { useKitchenMode } from "@/lib/kitchenStatusMode";
import { useCan } from "@/lib/useRole";
import type { Customer, DiningTable, Kot, Order } from "@/lib/types";
import { counterQueue, elapsed, type QueueEntry } from "./counter-queue";

const KEY = "pos.counterStrip.open";
const REFRESH_MS = 30_000;
const CHIP: Record<QueueEntry["status"], { label: string; cls: string }> = {
  new: { label: "Not sent", cls: "bg-surface-2 text-fg-muted" },
  sent: { label: "Sent", cls: "bg-info-soft text-info-fg" },
  cooking: { label: "Cooking", cls: "bg-warning-soft text-warning-fg" },
  ready: { label: "Ready", cls: "bg-success-soft text-success-fg" },
  served: { label: "Served", cls: "bg-surface-2 text-fg-muted" },
};

/**
 * Desktop-only strip above the counter (the owner's reference layout): Open tickets, Today's sales (same source as the Today
 * page: daily-sales for the restaurant's calendar date) and a horizontal ticket queue (orders not billed yet, kitchen state,
 * elapsed time). Collapsible, remembered per device. Read-only: it never adds a tap to the order flow. A tap on a ticket of
 * this device opens it; others open the Orders screen.
 */
export function CounterStrip({ tables, customers, currency, localOrderIds, onOpenLocal }: {
  tables: DiningTable[]; customers: Customer[]; currency: string;
  /** Server order id -> ticket id, for the tickets open on this device. */
  localOrderIds: Map<string, string>;
  onOpenLocal: (ticketId: string) => void;
}) {
  const { can, ready } = useCan();
  const [open, setOpen] = useState(false); // opt-in (not in the original counter): off until turned on, remembered per device
  const [queue, setQueue] = useState<QueueEntry[] | null>(null);
  const [sales, setSales] = useState<{ total: string; bills: number } | null>(null);
  const [now, setNow] = useState(0);
  const target = useKitchenTarget();
  const kotOnly = useKitchenMode() === "kot_only";
  useEffect(() => { try { if (localStorage.getItem(KEY) === "1") void Promise.resolve().then(() => setOpen(true)); } catch { /* storage unavailable */ } }, []);
  const toggle = () => setOpen((o) => { try { localStorage.setItem(KEY, o ? "0" : "1"); } catch { /* ignore */ } return !o; });

  const load = useCallback(async () => {
    if (!ready) return;
    const { from, to } = todayRange(new Date(), getTaxConfig()?.timezone);
    const [o, k, d] = await Promise.allSettled([
      api.orders(),
      can("kot.view") ? api.kots() : Promise.resolve([] as Kot[]),
      can("reports.view") ? api.report<{ totals: { gross_total: string | number; bills: number } }>("daily-sales", from, to) : Promise.reject("off"),
    ]);
    if (o.status === "fulfilled") setQueue(counterQueue(o.value as Order[], k.status === "fulfilled" ? k.value : [], tables, customers, kotOnly ? "kot_only" : "track"));
    setSales(d.status === "fulfilled" ? { total: String(d.value.totals.gross_total), bills: d.value.totals.bills } : null);
    setNow(Date.now());
  }, [ready, can, tables, customers, kotOnly]);

  useEffect(() => {
    if (!open) return;
    void Promise.resolve().then(load);
    const poll = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [open, load]);

  // The switch lives in the top bar (page controls), so the counter itself looks exactly like the original when it is off.
  const toggleBtn = (
    <TopBarSlot>
      <IconButton label={open ? "Hide counter overview" : "Show counter overview"} icon={<LayoutDashboard aria-hidden className="size-5" />} aria-pressed={open} onClick={toggle}
        className={cn(open && "bg-primary-soft text-primary-soft-fg")} />
    </TopBarSlot>
  );
  if (!open) return toggleBtn;
  return (
    <section aria-label="Counter overview" className="flex min-w-0 shrink-0 items-stretch gap-3">
      <Stat icon={<ReceiptText />} label="Open tickets" value={queue ? String(queue.length) : "…"} hint={queue ? (kotOnly ? `${queue.filter((q) => q.status === "sent").length} in kitchen` : `${queue.filter((q) => q.status === "cooking").length} cooking · ${queue.filter((q) => q.status === "ready").length} ready`) : undefined} />
      {sales && <Stat icon={<Wallet />} label="Today sales" value={formatCompactMoney(sales.total, currency)} hint={`${sales.bills} ${sales.bills === 1 ? "bill" : "bills"}`} />}
      <div className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl border border-border bg-surface px-3 py-2">
        <p className="w-16 shrink-0 text-sm font-semibold leading-tight text-fg">Ticket queue{queue ? <span className="block text-xs font-medium text-fg-muted">{queue.length} open</span> : null}</p>
        {queue && queue.length === 0 ? <p className="text-sm text-fg-muted">No open tickets.</p> : (
          <ul className="fade-x flex min-w-0 flex-1 gap-2 overflow-x-auto scrollbar-none" aria-label="Ticket queue">
            {(queue ?? []).map((q) => {
              const local = localOrderIds.get(q.orderId);
              const body = (
                <>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-display text-sm font-bold text-fg">{q.where}{q.customer ? <span className="font-medium text-fg-muted"> · {q.customer}</span> : null}</span>
                    <span className={cn("shrink-0 rounded-full px-2 py-px text-[0.7rem] font-semibold", CHIP[q.status].cls)}>{kotOnly && q.status === "sent" ? "In kitchen" : CHIP[q.status].label}</span>
                  </span>
                  <span className="flex items-center justify-between gap-2 text-xs text-fg-muted">
                    <span className="tnum">{q.items} {q.items === 1 ? "item" : "items"} · {formatCurrency(q.total, currency)}</span>
                    {q.since && (() => {
                      // Same lateness rule as the kitchen board (lib/ticketAge): only tickets still being cooked turn amber / red.
                      const w = (!kotOnly && (q.status === "sent" || q.status === "cooking")) ? ticketWaitState("pending", q.since, now, target) : "ok";
                      return <span data-wait={w} className={cn("tnum inline-flex items-center gap-1", w === "late" ? "font-semibold text-danger-fg" : w === "warn" ? "font-semibold text-warning-fg" : undefined)}>
                        {w === "ok" ? <Clock3 aria-hidden className="size-3" /> : <AlertTriangle aria-hidden className="size-3" />}{w !== "ok" && <span className="sr-only">{w === "late" ? "Late, " : "Getting late, "}</span>}{elapsed(q.since, now)}</span>;
                    })()}
                  </span>
                </>
              );
              const cls = "relative flex min-h-11 w-48 shrink-0 flex-col justify-center gap-0.5 rounded-xl border border-border bg-surface-2/50 px-2.5 py-1.5 text-left hover:border-border-strong hover:bg-surface-2";
              return (
                <li key={q.orderId}>
                  {local ? <button type="button" className={cls} onClick={() => onOpenLocal(local)}>{body}</button>
                    : <Link href="/orders" className={cls}>{body}</Link>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {toggleBtn}
    </section>
  );
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="w-40 shrink-0 rounded-2xl border border-border bg-surface px-3 py-2">
      <p className="flex items-center justify-between gap-2 text-xs font-medium text-fg-muted">{label}<span aria-hidden className="text-fg-subtle [&_svg]:size-3.5">{icon}</span></p>
      <p className="tnum font-display text-xl font-extrabold leading-tight tracking-tight text-fg">{value}</p>
      {hint && <p className="truncate text-[0.7rem] text-fg-muted">{hint}</p>}
    </div>
  );
}
