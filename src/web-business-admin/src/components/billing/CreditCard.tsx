"use client";

import Link from "next/link";
import { ChevronRight, Coins } from "lucide-react";
import { Section } from "@chilli/ui";
import { useEffect, useState } from "react";
import { Card, Skeleton } from "@/components/ui";
import { billingApi, billsLeft, chilli, signedChilli, daysText, isBlocked, ordersLeft } from "@/lib/billing";
import { RechargeButton, RechargeWatcher } from "./recharge";
import { StateChip, UNAVAILABLE_TEXT, useWallet, WalletBanner } from "./wallet-parts";

/**
 * "Chilli" on Today (docs/CHILLI_WALLET.md): state chip, balance in Chilli, Chilli per bill, bills left or trial days left,
 * the server's banner and a Recharge button. Shown only with billing.view; hidden entirely on a server without the wallet routes
 * or for a subscription-model restaurant (no metering). The card opens Manage > Billing.
 */
export function CreditCard({ canView, canTopUp }: { canView: boolean; canTopUp: boolean }) {
  const { load } = useWallet(canView);
  const [bonus, setBonus] = useState(0);
  const bal = load.state === "ok" ? load.data.billing?.balance_paise : undefined;
  useEffect(() => {
    if (!canView) return;
    let off = false;
    billingApi.ledger({ kind: "promo", limit: 200 }).then((pg) => { if (!off) setBonus(pg.items.reduce((n, r) => n + r.amount_paise, 0)); }).catch(() => {});
    return () => { off = true; };
  }, [canView, bal]);
  if (!canView || load.state === "missing") return null;
  const b = load.state === "ok" ? load.data.billing : null;
  if (b && b.model === "subscription") return null;

  return (
    <Section title="Chilli" className="mt-6">
      <Card data-testid="credit-card" className="space-y-3">
        {load.state === "loading" ? <Skeleton className="h-16 rounded-xl" />
          : !b ? <p className="text-sm text-fg-muted">{load.state === "error" ? load.message : UNAVAILABLE_TEXT}</p>
          : <>
            <Link href="/manage?tab=billing" className="group -m-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl p-2 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              <Coins aria-hidden className="size-6 shrink-0 text-fg-subtle" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-muted">Balance <StateChip b={b} /></span>
                <span className="tnum block font-display text-2xl font-extrabold tracking-tight text-fg" data-testid="credit-balance">{chilli(b.balance_paise)}</span>
                {bonus > 0 && <span className="tnum block text-sm font-medium text-success-fg" data-testid="credit-bonus">{signedChilli(bonus)} bonus included</span>}
                <span className="block text-sm text-fg-muted">
                  {b.state === "trial"
                    ? `Free trial, ${daysText(b.days_left)} left. Then ${chilli(b.per_bill_paise)} per bill.`
                    : b.state === "grace" ? `${ordersLeft(b) ?? "A few"} orders left before billing stops`
                    : isBlocked(b) ? "Recharge to continue taking new orders"
                    : `${chilli(b.per_bill_paise)} per bill${billsLeft(b) !== null ? ` · about ${billsLeft(b)} ${billsLeft(b) === 1 ? "bill" : "bills"} left` : ""}`}
                </span>
              </span>
              <ChevronRight aria-hidden className="size-5 text-fg-subtle transition-transform group-hover:translate-x-0.5" />
              <span className="sr-only">Open Chilli details</span>
            </Link>
            <WalletBanner b={b} />
            <RechargeWatcher />
            <RechargeButton b={b} mayTopUp={canTopUp} size="sm" />
          </>}
      </Card>
    </Section>
  );
}
