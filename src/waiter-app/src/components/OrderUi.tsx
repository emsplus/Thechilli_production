"use client";
import Link from "next/link";
import { memo, useState } from "react";
import { billLabel, billTabName } from "@/lib/bills";
import { cartTotal } from "@/lib/cart";
import { draftActions, useBills } from "@/lib/draft";
import { mediaUrl } from "@/lib/api";
import { formatMoney, formatPrice } from "@/lib/money";
import { groupsFor } from "@/lib/modifiers";
import type { DiningTable, MenuItem } from "@/lib/types";
import { FoodGlyph, foodKindFor } from "./FoodGlyph";

const TINTS = 6;
const tintOf = (k: string) => (Array.from(k).reduce((s, c) => s + c.charCodeAt(0), 0) % TINTS) + 1;

export function initialsOf(name: string): string {
  const w = name.trim().split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x));
  if (!w.length) return "·";
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).toUpperCase();
}

/** Dish photo, or (no photo / broken photo) the original POS fallback: tinted tile, category glyph, initials. Never a broken image. */
export function FoodImage({ src, name, category, thumb }: { src: string | null; name: string; category?: string; thumb?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const kind = foodKindFor(category, name);
  return (
    <div className={`food${thumb ? " thumb" : ""}`} data-tint={tintOf(kind)} aria-hidden>
      <FoodGlyph kind={kind} className="glyph" />
      {!thumb && <span className="initials" data-initials={initialsOf(name)} />}
      {/* eslint-disable-next-line @next/next/no-img-element -- server-hosted photos, cached by the WebView; next/image needs a server */}
      {src && failed !== src && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className={loaded === src ? "on" : ""} onLoad={() => setLoaded(src)} onError={() => setFailed(src)} />}
    </div>
  );
}

/**
 * Menu card as on the original counter: photo, name, price; tap adds one (dishes with options open the option picker);
 * once in the bill the footer is a - n + stepper. The small note button opens the full sheet (note, quantity, options).
 */
export const DishCard = memo(function DishCard({ item, category, qty, onPick, onDetail }: {
  item: MenuItem; category?: string; qty: number;
  onPick: (item: MenuItem) => void; onDetail: (item: MenuItem) => void;
}) {
  const hasOptions = item.variants.length > 0;
  const price = formatPrice(item.price);
  // Sold out today (set at the counter, arrives with the menu refresh): shown, not orderable; lines already in the bill can still be removed.
  const soldOut = !!item.sold_out;
  return (
    <article className={`dish${qty > 0 ? " in" : ""}${soldOut ? " soldout" : ""}`}>
      <button type="button" className="dish-main" disabled={soldOut} onClick={() => onPick(item)} aria-label={soldOut ? `${item.name}, ${price}, sold out today` : `${item.name}, ${price}${hasOptions ? `, ${item.variants.length + 1} options, choose option` : item.modifier_group_ids?.length ? `, ${groupsFor(item).map((g) => g.name).join(" · ")}, add to order` : ", add to order"}${qty > 0 ? `, ×${qty} in order` : ""}`}>
        <span className="dish-photo">
          <FoodImage src={mediaUrl(item.thumb_url ?? item.image_url)} name={item.name} category={category} />
          {qty > 0 && <span className="dish-qty">×{qty}</span>}
        </span>
        <span className="dish-name">{item.name}</span>
        {hasOptions ? <span className="dish-meta">{item.variants.length + 1} options</span> : item.modifier_group_ids?.length ? <span className="dish-meta clip">{groupsFor(item).map((g) => g.name).join(" · ")}</span> : null}
      </button>
      {/* Price row with the note button: nothing ever sits on the photo's corner over the name or the quantity badge. */}
      <div className="dish-row">
        <span className="dish-price">{price}</span>
        <button type="button" className="dish-note" aria-label={`Note or quantity for ${item.name}`} onClick={() => onDetail(item)}>
          <svg viewBox="0 0 24 24" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>
        </button>
      </div>
      <div className="dish-foot">
        {soldOut ? (
          <span className="dish-soldout" role="status">Sold out{qty > 0 ? ` · ${qty} in bill` : ""}</span>
        ) : qty > 0 && !hasOptions ? (
          <div className="stepper" role="group" aria-label={`Quantity of ${item.name}`}>
            <button type="button" aria-label={`Remove one ${item.name}`} onClick={() => draftActions.stepItem(item.id, -1)}>−</button>
            <output aria-live="polite">{qty}</output>
            <button type="button" aria-label={`Add one more ${item.name}`} onClick={() => draftActions.stepItem(item.id, 1)}>+</button>
          </div>
        ) : (
          <button type="button" className="dish-add" onClick={() => onPick(item)} aria-label={`Add ${item.name}`}>+ Add</button>
        )}
      </div>
    </article>
  );
});

/** Bill tabs (original counter: Bill 1, Bill 2, Hold). Always shown on the menu, so the grid never jumps under a finger on the first add. */
export function BillTabs({ tables }: { tables: DiningTable[] }) {
  const s = useBills();
  const [full, setFull] = useState(false);
  const active = s.bills.find((b) => b.client_uuid === s.active) ?? s.bills[0];
  return (
    // The tablist holds only tabs; "+ New bill" and the "6 bills" note sit next to it in the same scrolling row (axe aria-required-children).
    <div className="billtabs">
      <div className="billtabs-list" role="tablist" aria-label="Open bills">
      {s.bills.map((b) => {
        const n = b.lines.reduce((x, l) => x + l.quantity, 0);
        const on = b.client_uuid === active.client_uuid;
        return (
          <button key={b.client_uuid} type="button" role="tab" aria-selected={on} aria-label={billTabName(b, tables)} className="billtab" onClick={() => draftActions.switchBill(b.client_uuid)}>
            <span className="bt-name">{billLabel(b, tables)}</span>
            <span className="bt-sub">{n ? `${n} · ${formatMoney(cartTotal(b.lines))}` : "Empty"}</span>
          </button>
        );
      })}
      </div>
      {(active.lines.length > 0 || s.bills.length > 1) && <button type="button" className="billtab new" onClick={() => setFull(!draftActions.newBill())} aria-label="Hold this bill and start a new one">+ New bill</button>}
      {full && <span className="small muted" role="status">6 bills are open. Send or close one first.</span>}
    </div>
  );
}

/** Sticky bar above the tab bar: count, bill and total; one tap opens the review. */
export function CartBar({ count, total, label }: { count: number; total: string; label: string }) {
  if (count <= 0) return null;
  return (
    <Link href="/cart" className="cartbar2" aria-label={`Review order: ${count} item${count === 1 ? "" : "s"}, ${formatMoney(total)}`}>
      <span className="cb-count">{count}</span>
      <span className="cb-text"><span className="cb-label">{label}</span><span className="cb-total">{formatMoney(total)}</span></span>
      <span className="cb-go">Review<svg viewBox="0 0 24 24" aria-hidden><path d="M9 6l6 6-6 6" /></svg></span>
    </Link>
  );
}
