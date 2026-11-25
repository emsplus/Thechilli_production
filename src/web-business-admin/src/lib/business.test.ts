import { describe, expect, it } from "vitest";
import { allowedType, bizCapsOf, BUSINESS_TYPE_FALLBACK, canonicalTypes, capsOfSelection, HOTEL_HINT, hiddenBy, LEGACY_CAPS, typeHint } from "./business";

const KITCHEN = { dine_in: false, outdoor: false, takeaway: true, delivery_orders: true, tables: false, reservations: false, waiter_app: true,
  waiter_table_flow: false, kitchen_display: true, inventory: true, aggregator: true, order_types: ["takeaway", "delivery"] };

describe("business capabilities (docs/BUSINESS_TYPES.md)", () => {
  it("an older server (no capabilities) is a restaurant with every order type it offered before", () => {
    const c = bizCapsOf({});
    expect(c).toEqual(LEGACY_CAPS);
    expect(c.order_types).toEqual(["indoor", "outdoor", "takeaway", "delivery"]);
    expect(c.delivery_orders).toBe(false);
    expect(bizCapsOf({ entitlements: { features: { delivery: { enabled: true } } } }).delivery_orders).toBe(true);
  });
  it("a cloud kitchen: takeaway and delivery only, no tables or reservations", () => {
    const c = bizCapsOf({ capabilities: KITCHEN as never });
    expect(c.order_types).toEqual(["takeaway", "delivery"]);
    expect(c.tables || c.reservations || c.dine_in).toBe(false);
    expect(allowedType("indoor", c)).toBe("takeaway");
    expect(allowedType("delivery", c)).toBe("delivery");
  });
  it("order types derive from the flags when the list is missing; never empty", () => {
    expect(bizCapsOf({ capabilities: { ...KITCHEN, order_types: undefined } as never }).order_types).toEqual(["takeaway", "delivery"]);
    expect(bizCapsOf({ capabilities: { ...KITCHEN, takeaway: false, delivery_orders: false, order_types: [] } as never }).order_types).toEqual(["takeaway"]);
  });
  it("removing Restaurant warns about Tables, Dine-in and Reservations", () => {
    expect(hiddenBy(LEGACY_CAPS, bizCapsOf({ capabilities: KITCHEN as never }))).toEqual(["Tables", "Dine-in and Outdoor orders", "Reservations"]);
  });
  it("the union of the selected types from the catalogue", () => {
    const cat = [{ id: "restaurant", capabilities: { ...LEGACY_CAPS, delivery_orders: false } }, { id: "cloud_kitchen", capabilities: KITCHEN as never }];
    const both = capsOfSelection(["restaurant", "cloud_kitchen"], cat);
    expect(both.tables && both.delivery_orders && both.dine_in).toBe(true);
    expect(capsOfSelection(["cloud_kitchen"], cat).tables).toBe(false);
  });
  it("sign-up selection: canonical order, no duplicates or unknown ids; the hotel hint appears once", () => {
    expect(canonicalTypes(["hotel_kitchen", "restaurant", "restaurant", "bar"])).toEqual(["restaurant", "hotel_kitchen"]);
    const hotel = BUSINESS_TYPE_FALLBACK.find((t) => t.id === "hotel_kitchen")!;
    expect(typeHint(hotel).split(HOTEL_HINT).length - 1).toBe(1);
    expect(typeHint({ id: "hotel_kitchen", description: "A hotel's food service." })).toBe(`A hotel's food service. ${HOTEL_HINT}`);
    expect(typeHint({ id: "cloud_kitchen", description: "Delivery only." })).toBe("Delivery only.");
  });
});
