"use client";

import { formatTime, formatWeekdayDate } from "@/lib/datetime";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Banknote, Boxes, ChevronDown, ClipboardList, Flame, ReceiptText, ShoppingBag, Wallet } from "lucide-react";
import { Button, Skeleton } from "@chilli/ui";
import { api, auth } from "@/lib/api";
import { formatCurrency, formatMoney, formatCompactMoney } from "@/lib/money";
import { ordersCreated, todayRange } from "@/lib/today";
import { formatWait, waitCounts } from "@/lib/ticketAge";
import { useKitchenTarget } from "@/lib/kitchenTarget";
import { useKitchenMode } from "@/lib/kitchenStatusMode";
import { getTaxConfig } from "@/lib/taxConfig";
import { useTaxPhrases } from "@/lib/taxWords";
import { useCan } from "@/lib/useRole";
import { useCashSession } from "@/lib/cashSession";
import type { CashSession, ManageSummary, ZReportData } from "@/lib/types";

const REFRESH_MS = 60_000;
const OPEN_KEY = "manage.todayOpen";
type Part<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "off" }; // off = not allowed / not available: tile hidden

/** The parts of /reports/daily-sales and /reports/order-summary the tiles read (one day: from = to = today). */
interface DaySales { totals: { bills: number; gross_total: string | number } }
interface DayOrders { orders_created_by_status: Record<string, number>; billed_orders: number }

/** A compact KPI tile. Attention is proportional: neutral frame, a thin leading accent and a coloured hint for warning / danger. */
function Tile({ href, icon, label, value, hint, tone = "neutral" }: { href: string; icon: ReactNode; label: string; value: ReactNode; hint?: ReactNode; tone?: "neutral" | "warning" | "danger" }) {
  const accent = tone === "danger" ? "border-l-4 border-l-danger" : tone === "warning" ? "border-l-4 border-l-warning" : "";
  const hintTone = tone === "danger" ? "font-medium text-danger-fg" : tone === "warning" ? "font-medium text-warning-fg" : "text-fg-muted";
  return (
    <Link href={href} data-tone={tone} className={`block h-full min-h-11 rounded-xl border border-border bg-surface px-3 py-2.5 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${accent}`}>
      <span className="flex items-center justify-between gap-2 text-xs font-medium text-fg-muted">{label}<span aria-hidden className="text-fg-subtle [&_svg]:size-4">{icon}</span></span>
      <span className="tnum mt-1 block font-display text-xl font-extrabold tracking-tight text-fg">{value}</span>
      {hint && <span className={`block truncate text-xs ${hintTone}`}>{hint}</span>}
    </Link>
  );
}

const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== "0"; } catch { return true; } };

/**
 * "Today" on Manage > Overview (the former /today page, folded in by the owner's request): sales and orders for the
 * restaurant's calendar date, open orders, unpaid bills, late kitchen tickets, low stock and the cash drawer, as one compact,
 * collapsible strip (the open/closed choice is remembered on this device). Only for users who may read reports. Low stock comes
 * from the Overview's own summary (no second request); the drawer from the shared cash-session query.
 */
export function TodayStrip({ summary }: { summary: ManageSummary | null }) {
  const { can, ready } = useCan();
  const allowed = ready && can("reports.view");
  const [open, setOpen] = useState(true);
  useEffect(() => { const v = readOpen(); if (!v) void Promise.resolve().then(() => setOpen(false)); }, []);
  const toggle = () => setOpen((o) => { const n = !o; try { localStorage.setItem(OPEN_KEY, n ? "1" : "0"); } catch { /* private mode */ } return n; });

  const [x, setX] = useState<Part<ZReportData>>({ state: "loading" });
  const [late, setLate] = useState<Part<{ warn: number; late: number }>>({ state: "loading" });
  const [sales, setSales] = useState<Part<DaySales>>({ state: "loading" });
  const [orders, setOrders] = useState<Part<DayOrders>>({ state: "loading" });
  const [dayLabel, setDayLabel] = useState("");
  const tx = useTaxPhrases();
  const target = useKitchenTarget();
  const kotOnly = useKitchenMode() === "kot_only";

  const load = useCallback(async () => {
    if (!auth.token) return;
    const { from, to } = todayRange(new Date(), getTaxConfig()?.timezone);
    setDayLabel(formatWeekdayDate(from, undefined, true));
    const r = await Promise.allSettled([
      api.xReport(),
      can("kot.view") ? api.kots() : Promise.reject("off"),
      api.report<DaySales>("daily-sales", from, to),
      api.report<DayOrders>("order-summary", from, to),
    ]);
    const part = <T,>(i: number): Part<T> => { const o = r[i]; return o.status === "fulfilled" ? { state: "ok", value: o.value as T } : { state: "off" }; };
    setX(part<ZReportData>(0));
    const k = r[1];
    setLate(k.status === "fulfilled" ? { state: "ok", value: waitCounts(k.value as never, Date.now(), target, kotOnly ? "kot_only" : "track") } : { state: "off" });
    setSales(part<DaySales>(2));
    setOrders(part<DayOrders>(3));
  }, [can, target, kotOnly]);

  useEffect(() => {
    if (!allowed || !open) return;
    void Promise.resolve().then(load);
    const tick = () => { if (document.visibilityState === "visible") void load(); };
    const id = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [allowed, open, load]);

  const drawer = useCashSession(allowed && open && can("cashier.shift"));
  if (!allowed) return null;
  const cash: Part<CashSession | null> = drawer.data === undefined ? { state: drawer.error ? "off" : "loading" } : drawer.data === "unsupported" ? { state: "off" } : { state: "ok", value: drawer.data };
  const cur = x.state === "ok" ? x.value.restaurant.currency : getTaxConfig()?.currency ?? "INR";
  const money = (v: string) => formatCurrency(v, cur);
  const oi = x.state === "ok" ? x.value.open_items : null;
  const sk = <li><Skeleton height={72} className="rounded-xl" /></li>;

  return (
    <section aria-labelledby="today-strip-title" data-testid="today-strip" className="rounded-2xl border border-border bg-surface-2/60 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="today-strip-title" className="font-display text-base font-bold text-fg">Today{dayLabel && <span className="ml-2 text-sm font-medium text-fg-muted">{dayLabel}</span>}</h2>
        <Button size="sm" variant="ghost" className="min-h-11" aria-expanded={open} aria-controls="today-strip-body" onClick={toggle}>
          {open ? "Hide" : "Show"}<ChevronDown aria-hidden className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </Button>
      </div>
      {open && (
        <div id="today-strip-body" className="mt-3 space-y-3">
          <ul data-testid="today-tiles" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {sales.state === "loading" ? sk : sales.state === "ok" && (
              <li><Tile href="/reports" icon={<Wallet />} label="Sales today" value={formatCompactMoney(String(sales.value.totals.gross_total), cur)} hint={`${sales.value.totals.bills} ${sales.value.totals.bills === 1 ? "bill" : "bills"}, ${tx.incl}`} /></li>)}
            {orders.state === "loading" ? sk : orders.state === "ok" && (
              <li><Tile href="/orders" icon={<ShoppingBag />} label="Orders today" value={ordersCreated(orders.value.orders_created_by_status)} hint={`${orders.value.billed_orders} billed`} /></li>)}
            {x.state === "loading" ? <>{sk}{sk}</> : oi && <>
              <li><Tile href="/orders" icon={<ClipboardList />} label="Open orders now" value={oi.open_orders.count} hint={oi.open_orders.count ? `${money(oi.open_orders.amount)} not billed` : "Nothing waiting"} /></li>
              <li><Tile href="/orders" icon={<ReceiptText />} label="Unpaid bills" value={oi.unpaid_bills.count} hint={oi.unpaid_bills.count ? `${money(oi.unpaid_bills.balance)} to collect` : "All paid"} tone={oi.unpaid_bills.count ? "warning" : "neutral"} /></li>
            </>}
            {kotOnly ? null /* KOT only: nobody clicks in the kitchen, so there is no late-ticket count */ : late.state === "loading" ? sk : late.state === "ok" && <li><Tile href="/kitchen" icon={<Flame />} label="Late kitchen tickets" value={late.value.warn + late.value.late}
              hint={late.value.late ? `${late.value.late} waiting ${formatWait(2 * target)}+` : late.value.warn ? `Waiting ${formatWait(target)}+` : "Kitchen is on time"}
              tone={late.value.late ? "danger" : late.value.warn ? "warning" : "neutral"} /></li>}
            {summary ? <li><Tile href="/manage?tab=inventory" icon={<Boxes />} label="Low stock" value={summary.low_stock} hint={summary.low_stock ? "Running low" : "Stock is fine"} tone={summary.low_stock ? "warning" : "neutral"} /></li> : sk}
          </ul>
          {cash.state === "ok" && (
            <div data-testid="today-cash" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface px-3 py-2">
              <Banknote aria-hidden className="size-5 shrink-0 text-fg-subtle" />
              {cash.value && cash.value.status === "open"
                ? <p className="min-w-0 flex-1 text-sm"><span className="font-semibold text-fg">Cash drawer open</span> <span className="text-fg-muted">since {formatTime(cash.value.opened_at)}, float {money(formatMoney(cash.value.opening_float))}</span></p>
                : <p className="min-w-0 flex-1 text-sm text-fg-muted">No cash drawer shift is open.</p>}
              <Link href="/cash" className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-primary-soft-fg hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-ring">
                {cash.value && cash.value.status === "open" ? "View drawer" : "Open a shift"}
              </Link>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
