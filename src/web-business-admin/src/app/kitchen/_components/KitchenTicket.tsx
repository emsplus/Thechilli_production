"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { Button } from "@chilli/ui";
import { cn } from "@/lib/cn";
import { formatWait, waitState, type WaitState } from "@/lib/ticketAge";

export interface KitchenTicketItem {
  id: string; name: string; qty: number; note?: string;
  /** Modifier choices as the KOT carries them ("Spice level: Medium"). */
  mods?: string[];
  /** Combo contents ("Naan x2"). */
  parts?: { name: string; qty: number }[];
}

/**
 * One kitchen ticket on the board (replaces @chilli/ui KdsTicket here). A LIGHT card (white surface, dark text; owner approval 2026-11-03, BREAK_UI_REPORT D07):
 * it no longer opts into the always-dark [data-kds] palette.
 * Lateness is proportional (UI_REVIEW BA-13, shared rule in lib/ticketAge): the card border is always neutral; a ticket that is
 * getting late gets an amber wait chip and a thin amber leading accent, a late one (twice the target) a red chip and accent.
 * The wait reads as words ("12 min", "Waiting 4 h 25 min"), never colour alone. No stage label inside the card: the column
 * already says New / Preparing / Ready; the line under the number says where the order goes and its type instead.
 * Big type and 56px actions for a wall tablet; one tap anywhere on the card (outside its buttons) advances it (`tapAdvance`).
 * KOT-only kitchen (the default mode): the single action is "Done" and a stray tap never completes a ticket (tapAdvance off).
 */
export function KitchenTicket({
  number, where, kind, icon, items, token, orderNote, addOn, labelAddOn, minutes, tracksLate, targetMin, onAdvance, advanceLabel, busy, fresh, actions, labels, tapAdvance = true,
}: {
  number: number | string;
  /** "Table T3", "Takeaway". */
  where: string;
  /** Order type shown when `where` does not already say it ("Dine-in" for a table). */
  kind?: string;
  icon?: ReactNode;
  items: KitchenTicketItem[];
  /** Same content as the printed slip: the order's token, its note, and a later KOT of an order (only the items added since). */
  token?: number | null;
  orderNote?: string | null;
  addOn?: boolean;
  labelAddOn?: string;
  /** Whole minutes since the ticket was sent. */
  minutes: number;
  /** New / preparing tickets can run late; a ready ticket only shows its time. */
  tracksLate: boolean;
  targetMin: number;
  onAdvance?: () => void;
  advanceLabel?: string;
  busy?: boolean;
  fresh?: boolean;
  /** One tap anywhere on the card advances it (track mode). Off in KOT-only mode: only the Done button completes a ticket. */
  tapAdvance?: boolean;
  actions?: ReactNode;
  labels: { waiting: (t: string) => string; late: string; gettingLate: string };
}) {
  const state: WaitState = tracksLate ? waitState(minutes, targetMin) : "ok";
  const time = formatWait(minutes);
  const text = state === "ok" ? time : labels.waiting(time);
  const Icon = state === "ok" ? Clock : AlertTriangle;
  return (
    // The click handler is a pointer convenience for wet hands; the advance button is the accessible control.
    <article className={cn("ch-kds-ticket kitchen-ticket", onAdvance && tapAdvance && "ch-kds-ticket--tap")} data-density="far" data-wait={state}
      data-fresh={fresh || undefined} aria-label={`#${number}`}
      onClick={onAdvance && tapAdvance ? (e) => { if (!busy && !(e.target as HTMLElement).closest("button,a,input,select,textarea")) onAdvance(); } : undefined}>
      <header className="kitchen-ticket__head">
        <span className="ch-kds-ticket__no">#{number}</span>
        <span className="kitchen-ticket__wait" data-testid="ticket-wait" data-wait={state}>
          <Icon aria-hidden className="size-5 shrink-0" />
          {state !== "ok" && <span className="sr-only">{state === "late" ? labels.late : labels.gettingLate}: </span>}
          <span>{text}</span>
        </span>
      </header>
      <p className="kitchen-ticket__where">{icon}<span className="min-w-0 truncate">{where}</span>{kind && <span className="kitchen-ticket__kind">{kind}</span>}</p>
      {(token != null || addOn) && <p className="kitchen-ticket__mods" data-testid="ticket-meta">{[token != null ? `Token ${token}` : "", addOn ? (labelAddOn ?? "Add-on to earlier order") : ""].filter(Boolean).join(" · ")}</p>}
      {orderNote ? <p className="kitchen-ticket__mods" data-testid="ticket-order-note"><b>Note:</b> {orderNote}</p> : null}
      <ul className="ch-kds-ticket__items">
        {items.map((i) => (
          <li key={i.id}>
            <span className="ch-kds-ticket__qty">{i.qty}×</span>
            <span className="min-w-0">
              {i.name}
              {i.parts?.length ? <span className="kitchen-ticket__mods">{i.parts.map((p) => `${p.name} ×${p.qty}`).join(", ")}</span> : null}
              {i.mods?.length ? <span className="kitchen-ticket__mods">{i.mods.join(" · ")}</span> : null}
              {i.note ? <em className="ch-kds-ticket__note">{i.note}</em> : null}
            </span>
          </li>
        ))}
      </ul>
      <div className="kitchen-ticket__foot">
        {onAdvance && advanceLabel && <Button variant="primary" size="lg" className="kitchen-ticket__go" loading={busy} disabled={busy} onClick={onAdvance}>{advanceLabel}</Button>}
        {actions}
      </div>
    </article>
  );
}
