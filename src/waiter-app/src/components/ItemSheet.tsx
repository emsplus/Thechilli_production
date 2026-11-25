"use client";
import { useRef, useState } from "react";
import { addDecimal, formatMoney, mulDecimal } from "@/lib/money";
import { makeLine, NOTE_MAX, type CartLine } from "@/lib/cart";
import type { MenuItem } from "@/lib/types";
import { defaultSelection, groupsFor, selectedModifiers, selectionProblem, toggleOption, type Selection } from "@/lib/modifiers";
import { mediaUrl } from "@/lib/api";
import { useDialogFocus } from "@/lib/dialogFocus";
import { FoodImage } from "./OrderUi";

/**
 * Two ways in, as on the original counter:
 * - "pick": a dish with options was tapped. One tap on an option row adds one (no silent default: "Regular" is a row too).
 * - "detail": the small note button on the card. Option, quantity and a kitchen note, then "Add".
 */
export function ItemSheet({ item, mode = "detail", category, onAdd, onClose }: { item: MenuItem; mode?: "pick" | "detail"; category?: string; onAdd: (l: CartLine) => void; onClose: () => void }) {
  const hasOptions = item.variants.length > 0;
  // Modifier groups appear only for a dish that has them; defaults are pre-selected, so a variant row still adds in one tap.
  const [groups] = useState(() => groupsFor(item));
  const [sel, setSel] = useState<Selection>(() => defaultSelection(groups));
  const mods = groups.length ? selectedModifiers(groups, sel) : undefined;
  const modProblem = groups.length ? selectionProblem(groups, sel) : null;
  const [variant, setVariant] = useState<string | null | undefined>(hasOptions ? undefined : null); // undefined = not chosen yet
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose); // focus in, Esc closes, Tab stays inside, focus back to the dish on close
  const options = [{ id: null as string | null, name: "Regular", price: item.price }, ...item.variants.map((v) => ({ id: v.id as string | null, name: v.name, price: addDecimal(item.price, v.price_delta) }))];
  const chosen = variant !== undefined;
  const line = makeLine(item, variant ?? null, qty, note, mods);
  const add = () => { onAdd(line); onClose(); };

  return (
    <div className="sheet" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={mode === "pick" ? `Choose ${item.name}` : `Customize ${item.name}`} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="grabber" aria-hidden />
        <div className="row sheet-head">
          <FoodImage src={mediaUrl(item.thumb_url ?? item.image_url)} name={item.name} category={category} thumb />
          <div className="grow"><h2 className="sheet-title">{item.name}</h2><div className="muted small">{formatMoney(item.price)}</div></div>
          <button className="iconbtn" aria-label="Close" onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </div>
        {groups.map((g) => (
          <fieldset key={g.id} className="opts mods">
            <legend>{g.name} <span className="muted small">{g.min_select >= 1 ? (g.max_select === 1 ? "choose 1" : `choose ${g.min_select}+`) : g.max_select ? `optional, up to ${g.max_select}` : "optional"}</span></legend>
            {g.options.map((o) => (
              <button key={o.id} type="button" className="optrow" role={g.max_select === 1 ? "radio" : "checkbox"} aria-checked={(sel[g.id] ?? []).includes(o.id)}
                onClick={() => setSel((s) => toggleOption(s, g, o.id))}>
                <span><i className="tick" aria-hidden />{o.name}</span>{o.price_delta_paise !== 0 && <strong className="money">{o.price_delta_paise > 0 ? "+" : "−"}{formatMoney(String(Math.abs(o.price_delta_paise) / 100))}</strong>}
              </button>
            ))}
          </fieldset>
        ))}
        {hasOptions && (
          <fieldset className="opts">
            <legend>{mode === "pick" ? "Tap an option to add it" : "Option (required)"}</legend>
            {options.map((o) => (
              <button key={o.id ?? "regular"} type="button" className="optrow" aria-pressed={mode === "detail" && variant === o.id}
                disabled={mode === "pick" && !!modProblem}
                onClick={() => { if (mode === "pick") { onAdd(makeLine(item, o.id, 1, "", mods)); onClose(); } else setVariant(o.id); }}>
                <span>{o.name}</span><strong className="money">{formatMoney(o.price)}</strong>
              </button>
            ))}
          </fieldset>
        )}
        {mode === "pick" && !hasOptions && (
          <button className="btn primary block" disabled={!!modProblem} onClick={() => { onAdd(makeLine(item, null, 1, "", mods)); onClose(); }}>{modProblem ?? `Add · ${formatMoney(line.unit_price)}`}</button>
        )}
        {mode === "pick" && hasOptions && modProblem && <p className="small warn-text" role="status">{modProblem}</p>}
        {mode === "detail" && (
          <>
            <label className="field"><span>Note for the kitchen (optional)</span>
              <textarea className="input" maxLength={NOTE_MAX} rows={2} value={note} placeholder="e.g. no onion, extra spicy" onChange={(e) => setNote(e.target.value)} /></label>
            <div className="row between" style={{ marginBottom: 16 }}>
              <div className="stepper big" role="group" aria-label="Quantity">
                <button type="button" aria-label="Decrease" onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
                <output aria-live="polite">{qty}</output>
                <button type="button" aria-label="Increase" onClick={() => setQty(Math.min(99, qty + 1))}>+</button>
              </div>
              <strong className="money" style={{ fontSize: 20 }}>{formatMoney(mulDecimal(line.unit_price, qty))}</strong>
            </div>
            <button className="btn primary block" disabled={!chosen || !!modProblem} onClick={add}>{!chosen ? "Choose an option" : modProblem ?? "Add to order"}</button>
          </>
        )}
      </div>
    </div>
  );
}
