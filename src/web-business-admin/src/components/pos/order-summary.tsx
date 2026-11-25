"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Minus, NotebookPen, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { currencyMark, formatCurrency, formatMoney } from "@/lib/money";
import { listItem, spring } from "@/lib/motion";
import { NumberRoll } from "@/components/ui/number-roll";
import { FoodImage } from "./food-image";
import { VegMark } from "@/components/menu/veg-mark";
import type { FoodKind } from "@/lib/menuAdmin";
import { useMediaQuery } from "@/lib/useMediaQuery";

/**
 * Order panel layout (right column on tablets/laptops, a sheet on phones). Presentational: pass content in slots.
 *
 *   <OrderSummaryPanel
 *     orderLabel="Order #20" status={<StatusPill kind="order" status="open" />} itemCount={3} onClear={clear}
 *     fields={<div className="grid grid-cols-2 gap-3"><Input label="Customer" .../><Select label="Table" .../></div>}
 *     totals={<OrderTotals rows={[{ label: "Subtotal", value: "40.00" }, { label: "GST 5%", value: "2.00" }]} total="42.00" />}
 *     actions={<OrderActions primary={<Button className="w-full" size="pay">Place order</Button>} secondary={[...]} />}
 *   >
 *     <OrderItemList>{lines.map((l) => <OrderLineItem key={l.id} ... />)}</OrderItemList>
 *   </OrderSummaryPanel>
 */
export function OrderSummaryPanel({ title = "Order summary", orderLabel, status, headerActions, notice, fields, itemCount, onClear, clearLabel = "Clear", empty, totals, actions, children, className, showItemsHeader = true }: {
  title?: ReactNode;
  /** "Order #20", "T4 · Dine-in". */
  orderLabel?: ReactNode;
  status?: ReactNode;
  headerActions?: ReactNode;
  /** Banner slot under the header (offline, stale prices...). */
  notice?: ReactNode;
  /** Customer / table / order-type controls. */
  fields?: ReactNode;
  itemCount?: number;
  onClear?: () => void;
  clearLabel?: string;
  /** Shown instead of children when itemCount is 0. */
  empty?: ReactNode;
  totals?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Hide the "Order items" heading + count (e.g. on the paid / success view). */
  showItemsHeader?: boolean;
}) {
  const isEmpty = itemCount === 0;
  // Short windows (a laptop at 150-175 % zoom): the totals scroll with the items so the actions (Place order, Pay) always stay on screen.
  const short = useMediaQuery("(max-height: 820px)");
  return (
    <section aria-label={typeof title === "string" ? title : "Order summary"} className={cn("flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-pop", className)}>
      <header className="panel-head-warm flex items-start justify-between gap-3 border-b border-border px-4 pb-3 pt-4 sm:px-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">{title}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            {orderLabel && <h2 className="truncate font-display text-xl font-extrabold tracking-tight text-fg">{orderLabel}</h2>}
            {status}
          </div>
        </div>
        {headerActions && <div className="flex shrink-0 items-center gap-1">{headerActions}</div>}
      </header>
      {/* One scroll region for everything between the header and the footer, so the footer (totals + actions) never squeezes the items on short screens. */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {notice && <div className="px-4 pt-3 empty:hidden sm:px-5">{notice}</div>}
        {fields && <div className="border-b border-border px-4 py-3 sm:px-5">{fields}</div>}

        {showItemsHeader && <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3 sm:px-5">
          <h3 className="flex items-center gap-2 font-display text-base font-bold text-fg">
            Order items
            {itemCount != null && (
              <span data-cart-target className="tnum grid h-6 min-w-6 place-items-center rounded-full bg-primary-soft px-1.5 text-xs font-bold text-primary-soft-fg">{itemCount}</span>
            )}
          </h3>
          {onClear && !isEmpty && (
            <button type="button" onClick={onClear} className="inline-flex h-11 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-danger-fg transition-colors hover:bg-danger-soft">
              <Trash2 aria-hidden className="size-4" />{clearLabel}
            </button>
          )}
        </div>}

        <div className="px-3 pb-3 sm:px-4">
          {isEmpty && empty ? empty : children}
        </div>
        {short && totals && <div className="border-t border-border bg-surface-2/40 px-4 pb-1 pt-3 sm:px-5">{totals}</div>}
      </div>

      {((totals && !short) || actions) && (
        <footer className="border-t border-border bg-surface-2/40 px-4 pb-4 pt-3 pb-safe sm:px-5">
          {!short && totals}
          {actions && <div className={cn(totals && !short && "mt-3")}>{actions}</div>}
        </footer>
      )}
    </section>
  );
}

/** Animated list wrapper for order lines: lines slide in, collapse out, and reflow smoothly. */
export function OrderItemList({ children, label = "Items in this order", className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <ul aria-label={label} className={cn("flex flex-col", className)}>
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </ul>
  );
}

export interface OrderLineItemProps {
  /** React key is still required on the element; id is used for motion layout. */
  id: string;
  name: string;
  qty: number;
  /** Decimal strings. */
  unitPrice: string;
  lineTotal: string;
  currency?: string;
  imageUrl?: string | null;
  category?: string | null;
  /** Modifiers / options, e.g. [{ label: "Large", price: "3.00" }]. */
  addons?: { label: string; price?: string }[];
  note?: string | null;
  /** Small status node on the right of the name (e.g. <Badge tone="warning">Saved offline</Badge>). */
  badge?: ReactNode;
  /** FSSAI mark before the name (null / absent = not marked). */
  foodType?: FoodKind | null;
  onIncrement?: () => void;
  onDecrement?: () => void;
  onRemove?: () => void;
  onNote?: () => void;
  /** "Change options" (dishes with modifier groups). */
  onOptions?: () => void;
  /** Extra control in the line's button row (e.g. "Change to Full"), so the line stays one row of controls tall. */
  extra?: ReactNode;
  /** No thumbnail: the counter's order list fits more lines (the dish card already shows the photo). */
  dense?: boolean;
  /** Lock quantity controls (e.g. already sent to kitchen). */
  locked?: boolean;
  "data-testid"?: string;
}

/**
 * One order line: thumbnail, name, add-ons, note, − qty +, line total. Must be a direct child of <OrderItemList>.
 * Stepper names are "Decrease <name>" / "Increase <name>" (a single line still matches getByRole name "increase").
 */
export function OrderLineItem({ id, name, qty, unitPrice, lineTotal, currency = "", imageUrl, category, addons, note, badge, foodType, onIncrement, onDecrement, onRemove, onNote, onOptions, extra, dense, locked, ...rest }: OrderLineItemProps) {
  return (
    <motion.li layout="position" data-line={id} variants={listItem} initial="hidden" animate="show" exit="exit" className="overflow-hidden" data-testid={rest["data-testid"]}>
      <div className="flex gap-3 border-b border-border/70 py-2 last:border-0">
        {!dense && <FoodImage src={imageUrl} name={name} category={category} variant="thumb" className="size-11 shrink-0 rounded-xl" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 font-semibold leading-snug text-fg">{foodType && <VegMark kind={foodType} className="mr-1.5 inline-grid size-3.5 align-[-2px]" />}{name}</p>
            <span className="tnum shrink-0 font-bold text-fg"><NumberRoll value={formatMoney(lineTotal)} prefix={currencyMark(currency)} prefixClassName="text-[0.7rem]" /></span>
          </div>
          {(!dense || qty > 1 || (addons?.length ?? 0) > 0) && <p className="tnum text-xs text-fg-subtle">{formatCurrency(unitPrice, currency)} × {qty}</p>}
          {addons && addons.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-1">
              {addons.map((a) => (
                <li key={a.label} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[0.7rem] font-medium text-fg-muted">{a.label}{a.price ? ` +${formatMoney(a.price)}` : ""}</li>
              ))}
            </ul>
          )}
          {note && <p className="mt-1 line-clamp-2 [overflow-wrap:anywhere] text-xs italic text-fg-muted">“{note}”</p>}
          {badge && <div className="mt-1">{badge}</div>}
          {(onIncrement || onDecrement || onRemove || onNote || onOptions || extra) && (
            <div className={cn("flex flex-wrap items-center", dense ? "mt-1 gap-1" : "mt-2 gap-1.5")}>
              {(onIncrement || onDecrement) && (
                <div className="inline-flex items-center rounded-xl border border-border bg-surface-2/60 p-0.5">
                  <LineBtn label={`Decrease ${name}`} onClick={onDecrement} disabled={locked}><Minus className="size-4" /></LineBtn>
                  <span className="tnum min-w-7 text-center text-sm font-bold"><NumberRoll value={qty} /></span>
                  <LineBtn label={`Increase ${name}`} onClick={onIncrement} disabled={locked} primary><Plus className="size-4" /></LineBtn>
                </div>
              )}
              {extra}
              <span className="flex-1" />
              {onOptions && <LineBtn label={`Change options for ${name}`} onClick={onOptions} disabled={locked}><SlidersHorizontal className="size-4" /></LineBtn>}
              {onNote && <LineBtn label={`Note for ${name}`} onClick={onNote}><NotebookPen className="size-4" /></LineBtn>}
              {onRemove && <LineBtn label={`Remove ${name}`} onClick={onRemove} disabled={locked} danger><Trash2 className="size-4" /></LineBtn>}
            </div>
          )}
        </div>
      </div>
    </motion.li>
  );
}

function LineBtn({ label, onClick, disabled, primary, danger, children }: { label: string; onClick?: () => void; disabled?: boolean; primary?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <motion.button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled || !onClick}
      whileTap={{ scale: 0.86 }} transition={spring.snappy}
      className={cn("grid size-11 place-items-center rounded-[0.6rem] transition-colors disabled:opacity-40",
        primary ? "text-primary-soft-fg hover:bg-primary-soft" : danger ? "text-fg-subtle hover:bg-danger-soft hover:text-danger-fg" : "text-fg-muted hover:bg-surface hover:text-fg")}>
      <span aria-hidden>{children}</span>
    </motion.button>
  );
}

/**
 * Totals block. Values are decimal strings; the grand total rolls when it changes (exact string always read out).
 *   <OrderTotals rows={[{ label: "Subtotal", value: sub }, { label: "Discount", value: disc, negative: true }, { label: "GST 5%", value: gst }]} total={grand} />
 */
export function OrderTotals({ rows, total, totalLabel = "Total", currency = "", className }: {
  rows: { label: ReactNode; value: string; negative?: boolean; hint?: ReactNode }[];
  total: string;
  totalLabel?: ReactNode;
  currency?: string;
  className?: string;
}) {
  return (
    <dl className={cn("space-y-1.5 text-sm", className)}>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <dt className="text-fg-muted">{r.label}{r.hint && <span className="ml-1 text-xs text-fg-subtle">{r.hint}</span>}</dt>
          <dd className={cn("tnum font-medium", r.negative ? "text-success-fg" : "text-fg")}>{r.negative ? "− " : ""}{formatCurrency(r.value, currency)}</dd>
        </div>
      ))}
      <div className="!mt-3 flex items-end justify-between gap-3 border-t border-dashed border-border-strong pt-3">
        <dt className="font-display text-base font-bold text-fg">{totalLabel}</dt>
        <dd className="font-display text-2xl font-extrabold tracking-tight text-fg">
          <NumberRoll value={formatMoney(total)} prefix={currencyMark(currency)} />
        </dd>
      </div>
    </dl>
  );
}

/**
 * Sticky action area: optional secondary row (2-up grid) above one primary CTA.
 *   <OrderActions secondary={[<Button variant="ink">KOT & print</Button>, <Button variant="secondary">Draft</Button>]} primary={<Button className="w-full" size="pay">Place order</Button>} />
 */
export function OrderActions({ primary, secondary, className }: { primary: ReactNode; secondary?: ReactNode[]; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {secondary && secondary.length > 0 && <div className={cn("grid gap-2", secondary.length === 1 ? "grid-cols-1" : "grid-cols-2")}>{secondary}</div>}
      {primary}
    </div>
  );
}
