import type { OrderType } from "./types";

/**
 * Business types and what they switch on (docs/BUSINESS_TYPES.md). Screens read `capabilities` from GET /auth/me (or
 * GET /restaurant) and never hard-code by type id. A server that does not send them yet is treated as a restaurant, with
 * every order type it offered before (so nothing disappears on the current backend).
 */
export type BusinessType = "restaurant" | "cloud_kitchen" | "hotel_kitchen";
export const BUSINESS_TYPE_IDS: readonly BusinessType[] = ["restaurant", "cloud_kitchen", "hotel_kitchen"];

/** The hint every hotel kitchen choice carries (once). */
export const HOTEL_HINT = "Select Restaurant as well if the hotel has a dine-in restaurant.";

/** What the sign-up shows when GET /business-types cannot be loaded (same ids, labels and wording as pos-service). */
export const BUSINESS_TYPE_FALLBACK: readonly { id: BusinessType; label: string; description: string }[] = [
  { id: "restaurant", label: "Restaurant or cafe", description: "Guests eat in: tables, dine-in orders, reservations and the waiter table flow, plus takeaway." },
  { id: "cloud_kitchen", label: "Cloud kitchen", description: "Delivery-only or pickup kitchen: takeaway and delivery orders, no tables or dine-in." },
  { id: "hotel_kitchen", label: "Hotel kitchen", description: `A hotel's food service run like a cloud kitchen: takeaway and delivery orders, no tables. ${HOTEL_HINT}` },
];

/** The text under a type's checkbox: its description, plus the hotel hint unless the description already says it. */
export function typeHint(t: { id: string; description: string }): string {
  return t.id === "hotel_kitchen" && !/select restaurant/i.test(t.description) ? `${t.description} ${HOTEL_HINT}` : t.description;
}

/** A selection in canonical order without duplicates or unknown ids. */
export const canonicalTypes = (sel: readonly string[]): BusinessType[] => BUSINESS_TYPE_IDS.filter((t) => sel.includes(t));

export interface BizCaps {
  dine_in: boolean; outdoor: boolean; takeaway: boolean; delivery_orders: boolean; tables: boolean; reservations: boolean;
  waiter_app: boolean; waiter_table_flow: boolean; kitchen_display: boolean; inventory: boolean; aggregator: boolean;
  order_types: OrderType[];
}
export type BizCapKey = Exclude<keyof BizCaps, "order_types">;

const ALL_TYPES: OrderType[] = ["indoor", "outdoor", "takeaway", "delivery"];

/** What a restaurant had before business types existed (the fallback). Delivery admin stays hidden unless the plan says it is on. */
export const LEGACY_CAPS: BizCaps = {
  dine_in: true, outdoor: true, takeaway: true, delivery_orders: false, tables: true, reservations: true, waiter_app: true,
  waiter_table_flow: true, kitchen_display: true, inventory: true, aggregator: false, order_types: ALL_TYPES,
};

/**
 * Capabilities from a GET /auth/me or GET /restaurant body. Missing or malformed fields fall back to the restaurant defaults;
 * a module the tenant's entitlements turn on explicitly (`features.delivery.enabled`) still shows its screens on an older server.
 */
export function bizCapsOf(src: { capabilities?: Partial<BizCaps> | null; entitlements?: { features?: Record<string, { enabled: boolean }> } | null } | null | undefined): BizCaps {
  const c = src?.capabilities;
  const feat = (code: string) => src?.entitlements?.features?.[code]?.enabled === true;
  if (!c || typeof c !== "object") return { ...LEGACY_CAPS, delivery_orders: feat("delivery"), aggregator: feat("aggregator") };
  const b = (k: BizCapKey) => (typeof c[k] === "boolean" ? (c[k] as boolean) : LEGACY_CAPS[k]);
  const out: BizCaps = {
    dine_in: b("dine_in"), outdoor: b("outdoor"), takeaway: b("takeaway"), delivery_orders: b("delivery_orders"), tables: b("tables"),
    reservations: b("reservations"), waiter_app: b("waiter_app"), waiter_table_flow: b("waiter_table_flow"), kitchen_display: b("kitchen_display"),
    inventory: b("inventory"), aggregator: b("aggregator"), order_types: [],
  };
  const listed = Array.isArray(c.order_types) ? ALL_TYPES.filter((t) => c.order_types!.includes(t)) : null;
  out.order_types = listed && listed.length ? listed
    : ALL_TYPES.filter((t) => (t === "indoor" ? out.dine_in : t === "outdoor" ? out.outdoor : t === "takeaway" ? out.takeaway : out.delivery_orders));
  if (!out.order_types.length) out.order_types = ["takeaway"];
  return out;
}

/** The order type a new or changed ticket may use: the wanted one when allowed, else the first allowed (takeaway for kitchens). */
export function allowedType(want: OrderType, caps: Pick<BizCaps, "order_types">): OrderType {
  return caps.order_types.includes(want) ? want : caps.order_types.includes("takeaway") ? "takeaway" : caps.order_types[0];
}

/** Types removed by a change of selection lose these screens (shown in the owner's warning). */
export function hiddenBy(before: BizCaps, after: BizCaps): string[] {
  const names: [BizCapKey, string][] = [["tables", "Tables"], ["dine_in", "Dine-in and Outdoor orders"], ["reservations", "Reservations"], ["delivery_orders", "Delivery"]];
  return names.filter(([k]) => before[k] && !after[k]).map(([, n]) => n);
}

/** Capabilities of a selection, from the GET /business-types catalogue (the union of the selected types; delivery per entitlements is the server's call). */
export function capsOfSelection(selection: readonly string[], catalogue: readonly { id: string; capabilities?: Partial<BizCaps> }[]): BizCaps {
  const picked = catalogue.filter((c) => selection.includes(c.id));
  const any = (k: BizCapKey) => picked.some((p) => p.capabilities?.[k] === true);
  const caps = { ...LEGACY_CAPS, order_types: [] as OrderType[] };
  for (const k of Object.keys(LEGACY_CAPS) as (keyof BizCaps)[]) if (k !== "order_types") caps[k] = any(k);
  return bizCapsOf({ capabilities: { ...caps, order_types: undefined } });
}
