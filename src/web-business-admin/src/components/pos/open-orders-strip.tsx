"use client";

import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/money";
import { layoutTransition, spring } from "@/lib/motion";

export type OpenOrderStatus = "draft" | "placed" | "sent" | "billed" | "paid" | "offline" | "attention";

export interface OpenOrderChip {
  id: string;
  /** Short identity: "Bill 3". */
  label: string;
  /** Small badge beside it: "Dine-in · T3", "Takeaway". */
  badge?: string;
  itemCount: number;
  /** Decimal string total, e.g. "45.00". */
  total: string;
  status?: OpenOrderStatus;
}

const STATUS: Record<OpenOrderStatus, { dot: string; text: string }> = {
  draft: { dot: "bg-fg-subtle", text: "Not sent" },
  placed: { dot: "bg-info", text: "Placed" },
  sent: { dot: "bg-info", text: "In kitchen" },
  paid: { dot: "bg-success", text: "Paid" },
  billed: { dot: "bg-warning", text: "Awaiting payment" },
  offline: { dot: "bg-warning", text: "Saved offline" },
  attention: { dot: "bg-danger", text: "Needs attention" },
};

/**
 * Ticket switcher for several bills open at once (e.g. 4-5 tables in parallel). Presentational: the POS page owns
 * the list and the active id.
 *   <OpenOrdersStrip orders={chips} activeId={active} onSelect={setActive} onNew={newOrder} onClose={park} />
 * Keyboard: it is a tablist (Left/Right/Home/End move + select; Delete closes when onClose is given).
 * The "+ New" button's accessible name is `newLabel` (default "Open another order"; deliberately not "New order",
 * which the POS uses after payment).
 */
export function OpenOrdersStrip({ orders, activeId, onSelect, onNew, onClose, currency = "", label = "Open orders", newLabel = "Open another order", maxOrders, className }: {
  orders: OpenOrderChip[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew?: () => void;
  /** Optional per-chip close (park / discard an empty order). Confirm in the page if the order has items. */
  onClose?: (id: string) => void;
  currency?: string;
  label?: string;
  newLabel?: string;
  /** Disables "+ New" once this many orders are open. */
  maxOrders?: number;
  className?: string;
}) {
  const id = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const full = maxOrders != null && orders.length >= maxOrders;

  useEffect(() => {
    if (activeId) refs.current.get(activeId)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [activeId]);

  function onKey(e: KeyboardEvent, idx: number) {
    const n = orders.length;
    let j = -1;
    if (e.key === "ArrowRight") j = (idx + 1) % n;
    else if (e.key === "ArrowLeft") j = (idx - 1 + n) % n;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = n - 1;
    else if ((e.key === "Delete" || e.key === "Backspace") && onClose) { e.preventDefault(); onClose(orders[idx].id); return; }
    if (j < 0) return;
    e.preventDefault();
    onSelect(orders[j].id);
    refs.current.get(orders[j].id)?.focus();
  }

  return (
    <div className={cn("flex min-w-0 items-stretch gap-2", className)}>
      {orders.length > 0 && <div data-testid="open-orders-scroll" className="fade-x -my-1 min-w-0 flex-[0_1_auto] overflow-x-auto px-1 py-1 scrollbar-none">
        {/* The close buttons are siblings of the tablist (a tablist may only own tabs); the grid puts each one back on its chip's corner. */}
        <div className="grid auto-cols-max grid-flow-col gap-2">
        <div role="tablist" aria-label={label} aria-orientation="horizontal" className="contents">
        {orders.map((o, idx) => {
          const on = o.id === activeId;
          const st = STATUS[o.status ?? "draft"];
          return (
            <motion.div key={o.id} layout="position" transition={layoutTransition} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
              style={{ gridColumn: idx + 1, gridRow: 1 }} className="group/chip relative shrink-0">
              <button
                ref={(el) => { if (el) refs.current.set(o.id, el); else refs.current.delete(o.id); }}
                type="button" role="tab" aria-selected={on} tabIndex={on || (!activeId && idx === 0) ? 0 : -1}
                onClick={() => onSelect(o.id)} onKeyDown={(e) => onKey(e, idx)}
                aria-label={`${o.label}${o.badge ? `, ${o.badge}` : ""}, ${o.itemCount} ${o.itemCount === 1 ? "item" : "items"}, ${formatCurrency(o.total, currency)}, ${st.text}`}
                className={cn(
                  "relative flex h-14 min-w-[8.5rem] flex-col justify-center rounded-2xl border px-3.5 text-left transition-[border-color,background-color,box-shadow] duration-200",
                  onClose && "pr-9",
                  on ? "border-primary/40 bg-surface shadow-pop" : "border-border bg-surface/70 hover:border-border-strong hover:bg-surface",
                )}
              >
                {on && <motion.span layoutId={`order-chip-${id}`} transition={layoutTransition} className="absolute inset-x-3 -bottom-px h-[3px] rounded-full bg-primary-vivid" />}
                <span className="flex items-center gap-2">
                  <span aria-hidden className={cn("size-2 shrink-0 rounded-full", st.dot, o.status === "attention" && "anim-pulse-dot text-danger")} />
                  <span className={cn("truncate font-display text-sm font-bold", on ? "text-fg" : "text-fg-muted")}>{o.label}</span>{" "}
                  {o.badge && <span aria-hidden data-testid="chip-badge" className="truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-[0.65rem] font-semibold text-fg-muted">{o.badge}</span>}
                </span>{" "}
                <span aria-hidden className="tnum mt-0.5 whitespace-nowrap text-xs text-fg-muted">
                  {o.itemCount} {o.itemCount === 1 ? "item" : "items"}{" "}<span className={cn("font-semibold before:mx-1 before:font-normal before:text-fg-subtle before:content-['·']", on ? "text-primary-soft-fg" : "text-fg-muted")}>{formatCurrency(o.total, currency)}</span>
                </span>
              </button>
            </motion.div>
          );
        })}
        </div>
        {/* End spacer: the last chip (and its close button) scroll clear of the faded edge and the New button (QA D10). */}
        <span aria-hidden style={{ gridColumn: orders.length + 1, gridRow: 1 }} className="w-4" />
        {onClose && orders.map((o, idx) => (
          <button key={o.id} type="button" tabIndex={-1} onClick={() => onClose(o.id)} aria-label={`Close ${o.label}`} style={{ gridColumn: idx + 1, gridRow: 1 }}
            className="z-10 grid size-11 self-start justify-self-end pointer-fine:size-8 place-items-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg">
            <X aria-hidden className="size-3.5" />
          </button>
        ))}
        </div>
      </div>}
      {onNew && (
        <motion.button type="button" onClick={onNew} disabled={full} aria-label={`New: ${newLabel}`} title={full ? `Up to ${maxOrders} open orders` : newLabel}
          whileTap={{ scale: 0.95 }} transition={spring.snappy}
          className="flex h-14 shrink-0 items-center gap-1.5 rounded-2xl border border-dashed border-primary/45 bg-primary-soft/60 px-4 text-sm font-bold text-primary-soft-fg transition-colors hover:bg-primary-soft disabled:opacity-50">
          <Plus aria-hidden className="size-4" /><span aria-hidden>New</span>
        </motion.button>
      )}
    </div>
  );
}
