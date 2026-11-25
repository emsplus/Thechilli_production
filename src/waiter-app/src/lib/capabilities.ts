import type { OrderType } from "./queue/types";

/**
 * Business type -> what the waiter app may show (pos-service docs/BUSINESS_TYPES.md). Pure: no storage, no React.
 *
 * The SERVER decides (GET /auth/me: `business_types`, `capabilities`, and `order_types` inside `capabilities`); this file only
 * reads that answer and turns it into the few questions a screen asks: which order types may be chosen, is there a table
 * picker, where does the app open. Unknown or missing data (an older server) means "restaurant", which is today's flow.
 */
export type BusinessType = "restaurant" | "cloud_kitchen" | "hotel_kitchen";
export type ServiceMode = "dine_in" | "takeaway" | "delivery";

export interface Capabilities {
  dine_in: boolean; outdoor: boolean; takeaway: boolean; delivery_orders: boolean; tables: boolean; reservations: boolean;
  waiter_app: boolean; waiter_table_flow: boolean; kitchen_display: boolean; inventory: boolean; aggregator: boolean;
  order_types: OrderType[];
}
export interface BusinessProfile {
  types: BusinessType[];
  caps: Capabilities;
  /** False when nothing usable came from the server (older server, first run): the restaurant defaults are used. */
  known: boolean;
}

const TYPES: BusinessType[] = ["restaurant", "cloud_kitchen", "hotel_kitchen"];
const KITCHEN: BusinessType[] = ["cloud_kitchen", "hotel_kitchen"];
const ORDER_TYPES: OrderType[] = ["indoor", "outdoor", "takeaway", "delivery"];

/** The same rule as pos-service app/services/business_type.py `capabilities()` (the union over the selected types, type defaults). */
export function capabilitiesFor(types: readonly BusinessType[]): Capabilities {
  const dine = types.includes("restaurant");
  const kitchen = types.some((t) => KITCHEN.includes(t));
  return {
    dine_in: dine, outdoor: dine, takeaway: true, delivery_orders: kitchen, tables: dine, reservations: dine, waiter_app: true,
    waiter_table_flow: dine, kitchen_display: true, inventory: true, aggregator: kitchen,
    order_types: [...(dine ? ["indoor", "outdoor"] as OrderType[] : []), "takeaway", ...(kitchen ? ["delivery"] as OrderType[] : [])],
  };
}

export const RESTAURANT_PROFILE: BusinessProfile = { types: ["restaurant"], caps: capabilitiesFor(["restaurant"]), known: false };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const cleanTypes = (v: unknown): BusinessType[] => (Array.isArray(v) ? TYPES.filter((t) => v.includes(t)) : []);

/** Reads the /auth/me answer (or the copy cached on the device). Anything missing falls back per key, never to "everything off". */
export function profileFromMe(me: unknown): BusinessProfile {
  if (!isObj(me)) return RESTAURANT_PROFILE;
  const types = cleanTypes(me.business_types);
  const raw = isObj(me.capabilities) ? me.capabilities : null;
  if (!types.length && !raw) return RESTAURANT_PROFILE;
  const base = capabilitiesFor(types.length ? types : ["restaurant"]);
  if (!raw) return { types, caps: base, known: true };
  const caps = { ...base };
  for (const k of Object.keys(base) as (keyof Capabilities)[]) {
    if (k !== "order_types" && typeof raw[k] === "boolean") (caps[k] as boolean) = raw[k] as boolean;
  }
  const ot = Array.isArray(raw.order_types) ? raw.order_types : Array.isArray(me.order_types) ? me.order_types : null;
  if (ot) caps.order_types = ORDER_TYPES.filter((x) => ot.includes(x));
  return { types: types.length ? types : ["restaurant"], caps, known: true };
}

/**
 * Kitchen status tracking of the restaurant (pos-service docs/KOT_ONLY_KITCHEN.md), from /auth/me `order_rules.kitchen_status_mode`.
 * "kot_only" (the default, also for anything missing: older servers, no copy yet) = the order just goes to the kitchen: the waiter
 * sees "Sent to kitchen", no Preparing / Ready / Served progress and no "ready" alert. "track" = the full workflow as before.
 */
export type KitchenStatusMode = "kot_only" | "track";
export function kitchenModeFromMe(me: unknown): KitchenStatusMode {
  const rules = isObj(me) && isObj(me.order_rules) ? me.order_rules : null;
  return rules?.kitchen_status_mode === "track" ? "track" : "kot_only";
}

/** Business without any dine-in: a cloud kitchen and / or hotel kitchen. */
export const kitchenOnly = (p: BusinessProfile): boolean => !showTables(p);

/**
 * The table picker, the Tables tab and "My tables": only where the server says tables + the waiter table flow + dine-in orders.
 * (A restaurant that also runs a kitchen brand keeps all of it.)
 */
export function showTables(p: BusinessProfile): boolean {
  const c = p.caps;
  return c.tables && c.waiter_table_flow && c.dine_in && c.order_types.some((o) => o === "indoor" || o === "outdoor");
}

/**
 * Order types the waiter may choose, in display order. Never a type the server would refuse: dine-in only with tables, takeaway
 * only if the server lists it, delivery if the server lists it. A restaurant keeps its Delivery button (today's flow): the server
 * does not refuse delivery orders for a restaurant, it only gates the delivery MODULE (entitlements) for the kitchen channels.
 */
export function allowedModes(p: BusinessProfile): ServiceMode[] {
  const c = p.caps, dine = showTables(p);
  const out: ServiceMode[] = [];
  if (dine) out.push("dine_in");
  if (c.takeaway && c.order_types.includes("takeaway")) out.push("takeaway");
  if (c.order_types.includes("delivery") || (dine && c.takeaway)) out.push("delivery");
  return out.length ? out : ["takeaway"];
}

export const defaultMode = (p: BusinessProfile): ServiceMode => allowedModes(p)[0];

/** Where the app opens after sign-in: the floor for a restaurant, a new order (the menu) for a kitchen. */
export const homeRoute = (p: BusinessProfile): "/tables" | "/menu" => (showTables(p) ? "/tables" : "/menu");

/** Bottom tab bar, in order. A kitchen has no Tables tab, and its first tab is the new order. */
export function navItems(p: BusinessProfile): { href: "/tables" | "/menu" | "/cart" | "/orders" | "/more" }[] {
  return [...(showTables(p) ? [{ href: "/tables" as const }] : []), { href: "/menu" }, { href: "/cart" }, { href: "/orders" }, { href: "/more" }];
}

export const reservationsOn = (p: BusinessProfile): boolean => p.caps.reservations && showTables(p);

/** Server error code for an order / call the business type does not allow (pos-service ERROR_CODE). */
export const NOT_AVAILABLE_CODE = "not_available_for_business_type";

/** Short label for the business, for the order-type notes ("Cloud kitchen"). */
export function profileLabel(p: BusinessProfile): string {
  const names: Record<BusinessType, string> = { restaurant: "Restaurant or cafe", cloud_kitchen: "Cloud kitchen", hotel_kitchen: "Hotel kitchen" };
  return p.types.map((t) => names[t]).join(" + ");
}
