import type { Bill, DiscountInput, MenuItem, OrderType, PaymentMethod, TaxConfig } from "@/lib/types";
import type { EstimateInvoice } from "@/lib/taxEstimate";

/** `unit` is a Decimal string with 2 places ("12.50"); never a float. */
/** Chosen modifier options of a cart line (only on dishes with modifier groups; absent = a plain line, sent exactly as before). */
export interface LineMods { ids: string[]; names: string[]; deltaPaise: number }
/** `note`: kitchen note for this line ("no onion"); a different note makes a different line. */
export interface CartLine { key: string; item: MenuItem; variantId: string | null; label: string; unit: string; qty: number; mods?: LineMods; note?: string;
  /** Added by voice ("done") with a doubt ("not sure about this dish", "check the quantity"): marked "Check" until staff edit or confirm it. */
  check?: boolean }
/** `lineIds`: cart key -> server order line id (online orders), so a line not yet sent to the kitchen can be removed. */
export interface LocalOrder { client_uuid: string; id: string | null; offline: boolean; subtotal: string; lines: CartLine[]; lineIds?: Record<string, string> }
/** What happened to the kitchen ticket's print (pos-service phase4 KOT `print.status`; absent on older servers). */
export type KotPrint = "queued" | "sent" | "printed" | "failed" | "no_printer"
export interface Provisional {
  ref: string; method: PaymentMethod; lines: CartLine[]; subtotal: string; vat: string | null; total: string | null;
  rate: string | null; currency: string; at: string;
  /** Full client-side estimate (GST by rate, discount, service charge). Absent on receipts saved by older versions. */
  inv?: EstimateInvoice | null;
  /** Country of the estimate (always IN). */
  country?: string;
  /** Label of the seller's tax number on this receipt (GSTIN). */
  taxNumberLabel?: string;
}
/** The restaurant's GST configuration (GET /billing/tax-config); null until known. */
export type Tax = TaxConfig | null;
/** number = kitchen ticket sent from this screen; "queued" = saved offline; "sent" = the kitchen already has this order (opened from the server, e.g. a waiter sent it); null = not sent yet. */
export type Kotstate = number | "queued" | "sent" | null;

export const offlineRef = (o: { client_uuid: string }) => `OFF-${o.client_uuid.slice(0, 6).toUpperCase()}`;

/** draft -> placed -> kitchen -> billed -> paid (kitchen may be skipped). */
export type Stage = "draft" | "placed" | "kitchen" | "billed" | "paid";

/**
 * One open bill. Fully self-contained and JSON-serialisable (persisted in IndexedDB "drafts"): its own cart,
 * order type/table/customer, order + bill state and idempotency keys. `id` doubles as the order's client_uuid, so a
 * retry (online or via the offline queue) can never create a second order for the same ticket.
 */
export interface Ticket {
  id: string;
  /** Bill number shown as "Bill 3": the lowest number free among the open tickets on this device, stable while the ticket is open. */
  no: number;
  createdAt: string;
  lines: CartLine[];
  type: OrderType;
  tableId: string;
  customerId: string;
  order: LocalOrder | null;
  kot: Kotstate;
  /**
   * Items added AFTER the order was placed, not on the server yet (the customer ordered more). Absent on tickets saved
   * by older versions. "Add to order" moves them into `lines` / `order.lines`.
   */
  more?: CartLine[];
  /** Idempotency key of the add-on being sent, kept until it succeeds; `sig` ties it to the exact lines so edited items get a new key. */
  addBatch?: { id: string; sig: string };
  /** An earlier KOT was already sent (or queued) for this order: `kot` went back to null for the new items. */
  hadKot?: boolean;
  /** Server id of the KOT sent online (for the printable slip); absent for queued/offline KOTs. */
  kotId?: string;
  /** The cashier chose "Start a separate order" on a table that already has one (sent as allow_second_order). */
  secondOrder?: boolean;
  /** Print result of the last kitchen ticket; "failed" shows a persistent "Needs reprint" chip until a reprint works. */
  kotPrint?: KotPrint;
  bill: Bill | null;
  prov: Provisional | null;
  /** Payment idempotency key, stable across retries of the same method. */
  payKey: { method: PaymentMethod; key: string } | null;
  /** Bill discount chosen at the till (percent or fixed amount + reason). Absent on tickets saved by older versions. */
  discount?: DiscountInput | null;
  /** false = the service charge is removed from this bill only. Absent/true = applied when configured and eat-in. */
  serviceCharge?: boolean;
  /** false = a manager removed the automatic offers from this bill. Absent/true = offers apply (when any run). */
  applyOffers?: boolean;
  /** When the ticket reached "paid" (used to age finished tickets out). */
  paidAt?: string;
}

export const MAX_OPEN_TICKETS = 8;
