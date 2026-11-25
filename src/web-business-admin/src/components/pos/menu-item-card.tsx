"use client";

import type { MouseEvent, ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { useMsg } from "@/lib/i18n";
import { currencyMark, formatCurrency, formatMoney } from "@/lib/money";
import { popIn, spring } from "@/lib/motion";
import { QtyStepper } from "@/components/ui/qty-stepper";
import { VegMark } from "@/components/menu/veg-mark";
import { FOOD_LABEL, type FoodKind } from "@/lib/menuAdmin";
import { FoodImage } from "./food-image";
import { MENU_CARD_MSG } from "./menu-card-messages";

export interface MenuItemCardProps {
  name: string;
  /** Decimal string, e.g. "12.50" (never a float). */
  price: string;
  currency?: string;
  /** Category name: shown as a tag and used to pick the fallback glyph/tint. */
  category?: string | null;
  /** Optional photo URL; a designed fallback tile is shown when missing or broken. */
  imageUrl?: string | null;
  /** e.g. "/ serving", "/ kg". */
  unit?: string;
  /** Short line under the name (e.g. "2 options", "Spicy"). */
  meta?: ReactNode;
  /** FSSAI mark drawn before the name (null / absent = not marked: nothing drawn). Spoken after the name. */
  foodType?: FoodKind | null;
  /** One-line description: the card's tooltip, and its secondary line when there is no `meta` (full cards only). */
  description?: string | null;
  /** Quantity of this dish already in the active order (0 = not in cart). */
  qty?: number;
  /**
   * Main action (tap the card / the Add button). Receives the click event so you can
   * `flyToCart(e.currentTarget, { imageUrl })`.
   */
  onAdd: (e: MouseEvent<HTMLButtonElement>) => void;
  /** When both are given and qty > 0, the footer becomes a − n + stepper. */
  onIncrement?: (e: MouseEvent<HTMLButtonElement>) => void;
  onDecrement?: () => void;
  soldOut?: boolean;
  soldOutLabel?: string;
  disabled?: boolean;
  /** "card" (photo on top, footer actions) or "compact" (phones: shorter photo, tap to add, no footer). */
  variant?: "card" | "compact";
  className?: string;
}

/**
 * Menu grid card (POS). The photo + name area is ONE button whose accessible name starts with the dish name
 * ("Latte, ₹120.00, add to order"), so `getByRole("button", { name: /Latte/ }).first()` adds the dish.
 * Hover lift on pointer devices, press scale on touch, qty badge pops in, price in tabular figures.
 */
export function MenuItemCard({
  name, price, currency = "", category, imageUrl, unit, meta, foodType, description, qty = 0, onAdd, onIncrement, onDecrement,
  soldOut, soldOutLabel: soldOutProp, disabled, variant = "card", className,
}: MenuItemCardProps) {
  const t = useMsg(MENU_CARD_MSG);
  const soldOutLabel = soldOutProp ?? t("soldOut");
  const off = disabled || soldOut;
  const compact = variant === "compact";
  const priceText = formatMoney(price);
  const stepper = qty > 0 && onIncrement && onDecrement && !compact;
  const mark = currencyMark(currency);
  const sub = meta ?? (!compact && description ? description : null); // the description never adds a line on phones
  const priceNode = (
    <span className="tnum font-bold text-primary-soft-fg">{mark && <span className={cn("text-[0.78em] font-semibold", /[A-Za-z]/.test(mark) ? "mr-1" : "mr-px")}>{mark}</span>}{/[A-Za-z]/.test(mark) ? " " : ""}{priceText}{unit && <span className="ml-1 text-xs font-medium text-fg-subtle">{unit}</span>}</span>
  );
  return (
    <motion.article
      whileHover={off ? undefined : { y: -3 }}
      transition={spring.snappy}
      className={cn(
        "group/menu relative flex flex-col rounded-2xl border bg-surface p-2 shadow-card transition-[box-shadow,border-color] duration-200",
        qty > 0 ? "border-primary/35 shadow-pop ring-1 ring-primary/15" : "border-border hover:border-border-strong hover:shadow-pop",
        off && "opacity-60",
        className,
      )}
    >
      {/* The original Karahi card: photo with the category chip, name, price, then a full-width "+ Add" (a stepper once in the order). */}
      <motion.button
        type="button"
        disabled={off}
        onClick={onAdd}
        whileTap={off ? undefined : { scale: 0.97 }}
        transition={spring.snappy}
        title={description || undefined}
        aria-label={`${name}, ${formatCurrency(price, currency)}${foodType ? `, ${FOOD_LABEL[foodType]}` : ""}${soldOut ? `, ${soldOutLabel}` : `, ${t("addToOrderSuffix")}`}${qty > 0 ? `, ${t("inOrder", { qty })}` : ""}`}
        className="flex flex-1 flex-col rounded-xl text-left outline-offset-2 disabled:cursor-not-allowed"
      >
        <div className="relative">
          <FoodImage src={imageUrl} name={name} category={category} className={cn("w-full rounded-xl", compact ? "aspect-[16/10]" : "aspect-[4/3] max-h-[130px]")} />
          {category && !compact && (
            <span aria-hidden data-label={category} className="absolute left-2 top-2 max-w-[70%] truncate rounded-full bg-surface/90 px-2.5 py-1 text-[0.7rem] font-semibold text-fg-muted shadow-xs before:content-[attr(data-label)]" />
          )}
          <AnimatePresence>
            {qty > 0 && (
              <motion.span key="qty" variants={popIn} initial="hidden" animate="show" exit="exit" aria-hidden data-label={`×${qty}`}
                className="tnum absolute right-2 top-2 grid h-7 min-w-7 place-items-center rounded-full bg-primary bg-primary-gradient px-2 text-xs font-bold text-primary-fg shadow-[var(--shadow-glow)] before:content-[attr(data-label)]" />
            )}
          </AnimatePresence>
          {soldOut && (
            <span className="absolute inset-x-2 bottom-2 z-10 rounded-lg bg-fg py-1 text-center text-xs font-bold text-bg">{soldOutLabel}</span>
          )}
        </div>
        <div className={cn("flex flex-1 flex-col px-1.5", compact ? "pt-2" : "pt-2.5")}>
          <h3 className={cn("line-clamp-2 font-display font-bold leading-snug text-fg", compact ? "text-sm" : "text-[0.95rem]")}>{foodType && <VegMark kind={foodType} decorative className="mr-1.5 inline-grid align-[-2px]" />}{name}</h3>{" "}
          {sub && <p aria-hidden data-label={String(sub)} className="mt-0.5 line-clamp-1 text-xs text-fg-subtle before:content-[attr(data-label)]" />}{" "}
          <p className="mt-auto pt-1.5 text-sm">{priceNode}</p>{/* the category chip is drawn with ::before so it stays decoration (axe label-content-name-mismatch) */}
        </div>
      </motion.button>

      {!compact && (
        <div className="mt-2 flex h-11 items-center gap-2 px-0.5">
          {stepper ? (
            <QtyStepper value={qty} onIncrement={(e) => onIncrement?.(e)} onDecrement={() => onDecrement?.()}
              incLabel={t("addOneMore", { name })} decLabel={t("removeOne", { name })} tone="primary" className="w-full justify-between" disabled={off} />
          ) : (
            <motion.button type="button" disabled={off} onClick={onAdd} whileTap={off ? undefined : { scale: 0.96 }} transition={spring.snappy}
              aria-label={t("addNameToOrder", { name })} title={t("addNameToOrder", { name })}
              className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-surface-2/60 text-sm font-semibold text-fg transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary-soft-fg disabled:opacity-50">
              <Plus aria-hidden className="size-4" />{t("add")}
            </motion.button>
          )}
        </div>
      )}
    </motion.article>
  );
}
