"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Notice } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import { chilli, isBlocked, ordersLeft, RECHARGE_TO_CONTINUE, type BillingBlock } from "@/lib/billing";
import { useCan } from "@/lib/useRole";

const EVERY_MS = 60_000;
export const CHILLI_REFRESH = "chilli:refresh";

/**
 * On every screen, the counter included: a warning when the Chilli are low (100 or fewer), "N orders left before billing stops" while the 20-order grace after zero is
 * running, and a clear blocking message when the grace is spent (new orders are refused with 402 chilli_empty; an order that is already open can still be billed and paid). The state
 * comes from GET /auth/me `billing`, re-read every minute and right after a refused order. Only the owner and managers can recharge:
 * everyone else is told to ask the owner. Nothing is shown for a healthy balance, a trial, or when the server says nothing.
 */
export function ChilliBanner() {
  const { can } = useCan();
  const [b, setB] = useState<BillingBlock | null>(null);

  useEffect(() => {
    let off = false;
    const load = () => api.me().then((m) => { if (!off) setB(m.billing ?? null); }).catch((e) => { if (!(e instanceof ApiError)) return; });
    void Promise.resolve().then(load);
    const t = setInterval(load, EVERY_MS);
    window.addEventListener(CHILLI_REFRESH, load);
    return () => { off = true; clearInterval(t); window.removeEventListener(CHILLI_REFRESH, load); };
  }, []);

  if (!b || b.model === "subscription" || (b.state !== "low" && b.state !== "grace" && !isBlocked(b) && b.state !== "suspended")) return null;
  const mayRecharge = can("billing.topup");
  const empty = isBlocked(b);
  const grace = b.state === "grace";
  const left = ordersLeft(b);
  const suspended = b.state === "suspended";
  return (
    <div className="page-width mx-auto w-full px-3 pt-3 sm:px-5 lg:pr-6" data-testid="chilli-banner" data-state={b.state}>
      <Notice tone={empty || suspended || grace ? "danger" : "warning"}
        title={suspended ? "Billing is paused" : empty ? "Recharge to continue" : grace ? `${left ?? "A few"} ${left === 1 ? "order" : "orders"} left before billing stops` : "Chilli are running low"}
        action={mayRecharge ? <Link href="/manage?tab=billing" className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg" data-testid="chilli-recharge-link">Recharge</Link> : undefined}>
        {suspended ? "Billing is paused by Chilli support. New orders are paused; open orders can still be billed and paid."
          : grace ? `Your Chilli are used up. Recharge now to keep taking orders.${mayRecharge ? "" : " Ask the owner to recharge."}`
          : empty ? `${RECHARGE_TO_CONTINUE} Open orders can still be billed and paid.${mayRecharge ? "" : " Ask the owner to recharge."}`
          : `${chilli(b.balance_paise)} left, about ${Math.max(0, b.bills_left ?? Math.floor(b.balance_paise / Math.max(b.per_bill_paise, 1)))} bills.${mayRecharge ? "" : " Ask the owner to recharge."}`}
      </Notice>
    </div>
  );
}
