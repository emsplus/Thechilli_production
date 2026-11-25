"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Banknote, Bell, BellRing, Package, ReceiptText, Volume2, VolumeX } from "lucide-react";
import { Button, Sheet } from "@chilli/ui";
import { toast } from "@/components/ui";
import { TakePayment } from "@/components/pos/TakePayment";
import { api, ApiError } from "@/lib/api";
import { bellSoundOn, chime, setBellSound } from "@/lib/chime";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/datetime";
import { formatCurrency } from "@/lib/money";
import { useCurrency } from "@/lib/taxConfig";
import { isReminder, markBillRequestsRead, refreshBillRequests, reminderText, requestKey, requestLabel, useBillRequests } from "@/lib/billRequests";
import { useOpenAlerts } from "@/lib/useOpenAlerts";
import { useCan } from "@/lib/useRole";
import type { Bill, BillRequest } from "@/lib/types";

/** Where the cashier makes a requested bill: the counter opens that order as a ticket (/pos?order=<id>). */
export const billHref = (orderId: string) => `/pos?order=${encodeURIComponent(orderId)}`;

/**
 * Top-bar bell = notification centre. Bill requests and payment reminders from the waiter app (for staff who can bill:
 * bills.finalize) and the open low-stock alerts. Badge = unread requests / reminders + open alerts. A new bill request shows a
 * toast (no sound); a new PAYMENT REMINDER ("Table T2 is waiting to pay: bill ..., ₹760.00 (asked by Ramesh)") shows a toast with
 * "Take payment" and plays the chime (switch in the panel, on by default). "Take payment" opens the counter's pay sheet for that
 * bill; the reminder leaves the list by itself once the bill is paid, or with "Dismiss".
 * Opening a request (here, on its Orders card or at the counter) marks it read.
 */
export function NotificationBell() {
  const router = useRouter();
  const pathname = usePathname();
  const { can, ready } = useCan();
  const canBill = ready && can("bills.finalize");
  const alerts = useOpenAlerts() ?? 0;
  const currency = useCurrency();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(0);
  const [paying, setPaying] = useState<Bill | null>(null);
  const [sound, setSound] = useState(true);
  useEffect(() => { void Promise.resolve().then(() => setSound(bellSoundOn())); }, []);
  const money = useCallback((v: string) => formatCurrency(v, currency), [currency]);
  const openBill = useCallback((r: BillRequest) => {
    markBillRequestsRead([r.order_id]);
    setOpen(false);
    router.push(billHref(r.order_id));
  }, [router]);
  /** "Take payment": the bill's own pay sheet (same as Orders > Take payment). An older server without bill_id: open it at the counter. */
  const takePayment = useCallback((r: BillRequest) => {
    markBillRequestsRead([r.order_id]);
    setOpen(false);
    if (!r.bill_id) { router.push(billHref(r.order_id)); return; }
    api.bill(r.bill_id).then(setPaying).catch((e) => toast.error("Could not open the bill", { description: e instanceof ApiError && e.status === 0 ? "No internet connection." : "Please try again." }));
  }, [router]);
  const dismiss = useCallback((r: BillRequest) => {
    markBillRequestsRead([r.order_id]);
    api.dismissPaymentReminder(r.order_id).then(() => refreshBillRequests())
      .catch((e) => { if (!(e instanceof ApiError && (e.status === 404 || e.status === 405))) toast.error("Could not dismiss it", { description: "Please try again." }); });
  }, []);
  const onArrived = useCallback((rs: BillRequest[]) => {
    if (rs.some(isReminder) && bellSoundOn()) chime();
    for (const r of rs) {
      if (isReminder(r)) {
        toast.message(reminderText(r, money), { id: `bill-${requestKey(r)}`, duration: 15_000, action: { label: "Take payment", onClick: () => takePayment(r) } });
        continue;
      }
      toast.message(`${requestLabel(r)} asks for the bill`, {
        id: `bill-${requestKey(r)}`, duration: 10_000,
        description: [r.requested_by_name ?? r.waiter_name, `${r.item_count} ${r.item_count === 1 ? "item" : "items"}`].filter(Boolean).join(" · "),
        action: { label: "Open bill", onClick: () => openBill(r) },
      });
    }
  }, [openBill, takePayment, money]);
  const { requests, reminders, unread, seen } = useBillRequests(canBill, onArrived);
  useEffect(() => { if (!open) return; const t = () => setNow(Date.now()); t(); const i = setInterval(t, 30_000); return () => clearInterval(i); }, [open]);
  const count = unread.length + alerts;
  const unreadReminders = reminders.filter((r) => !seen.has(requestKey(r))).length;
  const toggleSound = () => { const on = !sound; setSound(on); setBellSound(on); if (on) chime(); }; // the tap also unlocks audio for later reminders
  const label = count > 0 ? `Notifications, ${count} new` : "Notifications";
  return (
    <>
      <button type="button" aria-label={label} title="Notifications" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} data-testid="notification-bell"
        className={cn("relative grid size-11 shrink-0 place-items-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          (open || pathname.startsWith("/alerts")) && "bg-primary-soft text-primary-soft-fg", unread.length > 0 && "text-danger-fg")}>
        {unread.length > 0 ? <BellRing aria-hidden className="size-5" /> : <Bell aria-hidden className="size-5" />}
        {count > 0 && <span aria-hidden data-testid="notification-count" className="tnum absolute right-0.5 top-0.5 grid min-w-[1.15rem] place-items-center rounded-full bg-danger-solid px-1 text-[0.65rem] font-bold leading-[1.15rem] text-white ring-2 ring-surface">{count > 9 ? "9+" : count}</span>}
      </button>
      <Sheet side="right" open={open} onOpenChange={setOpen} title="Notifications"
        footer={(unread.length > 0 || canBill) ? <div className="flex flex-wrap gap-2">
          {unread.length > 0 && <Button variant="secondary" onClick={() => markBillRequestsRead("all")}>Mark all read</Button>}
          {canBill && <Button variant="ghost" aria-pressed={sound} onClick={toggleSound} data-testid="bell-sound" iconStart={sound ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}>{sound ? "Sound on" : "Sound off"}</Button>}
        </div> : undefined}>
        <div className="space-y-5">
          {canBill && reminders.length > 0 && (
            <section aria-labelledby="nb-pay">
              <h3 id="nb-pay" className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg"><Banknote aria-hidden className="size-4" />Waiting to pay
                {unreadReminders > 0 && <span className="rounded-full bg-danger-soft px-2 text-xs font-bold text-danger-fg">{unreadReminders} new</span>}</h3>
              <ul className="space-y-2" data-testid="payment-reminders">
                {reminders.map((r) => {
                  const isNew = !seen.has(requestKey(r));
                  return (
                    <li key={requestKey(r)} data-unread={isNew ? "true" : "false"} data-testid="payment-reminder"
                      className={cn("rounded-xl border p-3", isNew ? "border-warning bg-warning-soft" : "border-border bg-surface")}>
                      <p className="font-semibold text-fg"><span translate="no">{reminderText(r, money)}</span>{isNew && <span className="sr-only"> (new)</span>}</p>
                      <time className="block text-xs text-fg-subtle" dateTime={r.requested_at}>{now ? relativeTime(r.requested_at, now) : ""}</time>
                      <div className="mt-2 flex gap-2">
                        <Button variant="primary" onClick={() => takePayment(r)} iconStart={<Banknote aria-hidden />}>Take payment</Button>
                        <Button variant="secondary" onClick={() => dismiss(r)}>Dismiss</Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {canBill && (
            <section aria-labelledby="nb-bills">
              <h3 id="nb-bills" className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg"><ReceiptText aria-hidden className="size-4" />Bill requests
                {unread.length - unreadReminders > 0 && <span className="rounded-full bg-danger-soft px-2 text-xs font-bold text-danger-fg">{unread.length - unreadReminders} new</span>}</h3>
              {requests.length === 0 ? <p className="text-sm text-fg-muted">No waiter is waiting for a bill.</p> : (
                <ul className="space-y-2" data-testid="bill-requests">
                  {requests.map((r) => {
                    const isNew = !seen.has(requestKey(r));
                    return (
                      <li key={requestKey(r)}>
                        <button type="button" onClick={() => openBill(r)} data-unread={isNew ? "true" : "false"}
                          className={cn("flex w-full min-h-14 items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-surface-2",
                            isNew ? "border-warning bg-warning-soft" : "border-border bg-surface")}>
                          <span aria-hidden className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", isNew ? "bg-danger-solid" : "bg-transparent")} />
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold text-fg">{requestLabel(r)} asks for the bill{isNew && <span className="sr-only"> (new)</span>}</span>
                            <span className="block text-sm text-fg-muted">
                              {[r.requested_by_name ?? r.waiter_name, `${r.item_count} ${r.item_count === 1 ? "item" : "items"}`].filter(Boolean).join(" · ")} · <span className="ch-money" translate="no">{formatCurrency(r.subtotal, currency)}</span>
                            </span>
                            <time className="block text-xs text-fg-subtle" dateTime={r.requested_at}>{now ? relativeTime(r.requested_at, now) : ""}</time>
                          </span>
                          <span className="self-center text-sm font-semibold text-primary">Open bill</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
          <section aria-labelledby="nb-stock">
            <h3 id="nb-stock" className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg"><Package aria-hidden className="size-4" />Low stock</h3>
            <Link href="/alerts" onClick={() => setOpen(false)} className="flex min-h-11 items-center justify-between rounded-xl border border-border px-3 text-sm hover:bg-surface-2">
              <span>{alerts > 0 ? `${alerts} open ${alerts === 1 ? "alert" : "alerts"}` : "No open alerts"}</span><span className="font-semibold text-primary">View alerts</span>
            </Link>
          </section>
        </div>
      </Sheet>
      <TakePayment bill={paying} onClose={() => setPaying(null)} onPaid={() => void refreshBillRequests()} />
    </>
  );
}
