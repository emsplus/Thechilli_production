"use client";

import { AnimatePresence, motion } from "motion/react";
import { ChevronUp, ShoppingBasket } from "lucide-react";
import { NumberRoll } from "@/components/ui";
import { Button } from "@chilli/ui";
import { currencyMark, formatMoney } from "@/lib/money";
import { spring } from "@/lib/motion";

/**
 * Phone-only "View order" bar, docked onto the shell's bottom tab bar (UI_REVIEW BA-2): one bottom unit, the action row on top
 * and the tabs below, sharing one surface and border (no second floating card, no overlap). Its bottom edge is the tab bar's top
 * edge (same inset, width and safe-area offset as tab-bar.tsx); globals.css squares the tab bar's top corners while it is docked.
 */
export function MobileCartBar({ show, count, total, currency, label, onOpen }: { show: boolean; count: number; total: string; currency: string; label: string; onOpen: () => void }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={spring.gentle}
          data-cart-dock="" className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.5rem+var(--tabbar-h))] z-30 mx-auto max-w-xl rounded-t-2xl border border-b-0 border-border bg-surface p-2 md:hidden">
          <div className="flex items-center gap-3">
            <span className="vt-cart-icon relative grid size-12 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-fg">
              <ShoppingBasket className="size-5" aria-hidden />
              <span data-cart-target className="tnum absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[0.7rem] font-bold text-primary-fg ring-2 ring-surface">{count}<span className="sr-only"> items</span></span>
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-xs font-medium text-fg-muted">{label}</p>
              <p className="vt-cart-total font-display text-lg font-extrabold text-fg"><NumberRoll value={formatMoney(total)} prefix={currencyMark(currency)} /></p>
            </div>
            <Button variant="primary" size="lg" onClick={onOpen}>View order<ChevronUp aria-hidden /></Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
