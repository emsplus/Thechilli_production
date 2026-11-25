import { describe, expect, it } from "vitest";
import type { ModifierGroup, Offer } from "./extras";
import { chosenOf, combinedDiscount, defaultSelection, deltaLabel, estimateOffers, groupProblem, groupsFor, needsPicker, toggleOption, unitWithModifiers } from "./modifiers";

const opt = (id: string, name: string, price_delta_paise = 0, is_default = false, sort_order = 0) => ({ id, name, price_delta_paise, is_default, is_active: true, sort_order });
const spice: ModifierGroup = { id: "g1", name: "Spice level", min_select: 1, max_select: 1, sort_order: 0, is_active: true, item_ids: [], options: [opt("mild", "Mild", 0, false, 0), opt("med", "Medium", 0, true, 1), opt("hot", "Hot", 0, false, 2)] };
const extras: ModifierGroup = { id: "g2", name: "Extras", min_select: 0, max_select: 2, sort_order: 1, is_active: true, item_ids: [], options: [opt("cheese", "Cheese", 2000), opt("egg", "Egg", 1500, false, 1), opt("butter", "Butter", 1000, false, 2)] };
const sauce: ModifierGroup = { id: "g3", name: "Sauce", min_select: 1, max_select: 1, sort_order: 2, is_active: true, item_ids: [], options: [opt("red", "Red"), opt("green", "Green")] };
const all = [spice, extras, sauce];

describe("modifier picker rules", () => {
  it("items without groups or with defaults for every required group never need the picker (no extra tap)", () => {
    expect(needsPicker({ variants: [], modifier_group_ids: [] }, all)).toBe(false);
    expect(needsPicker({ variants: [] }, all)).toBe(false); // older server: no field
    expect(needsPicker({ variants: [], modifier_group_ids: ["g1", "g2"] }, all)).toBe(false);
  });
  it("a required group without a default, or variants, opens the picker", () => {
    expect(needsPicker({ variants: [], modifier_group_ids: ["g3"] }, all)).toBe(true);
    expect(needsPicker({ variants: [{ id: "v", name: "Full", price_delta: "50" }], modifier_group_ids: [] }, all)).toBe(true);
  });
  it("inactive groups and unknown ids are ignored, item order is kept", () => {
    expect(groupsFor({ modifier_group_ids: ["g2", "x", "g1"] }, all).map((g) => g.id)).toEqual(["g2", "g1"]);
    expect(groupsFor({ modifier_group_ids: ["g1"] }, [{ ...spice, is_active: false }])).toEqual([]);
  });
  it("defaults, min / max and toggling", () => {
    const sel = defaultSelection([spice, extras]);
    expect(sel).toEqual({ g1: ["med"], g2: [] });
    expect(toggleOption(spice, ["med"], "hot")).toEqual(["hot"]);
    expect(toggleOption(spice, ["hot"], "hot")).toEqual(["hot"]); // required single choice cannot be emptied
    expect(toggleOption(extras, ["cheese", "egg"], "butter")).toEqual(["cheese", "egg"]); // max 2
    expect(toggleOption(extras, ["cheese"], "cheese")).toEqual([]);
    expect(groupProblem(sauce, [])).toBe("Choose Sauce");
    expect(groupProblem(extras, ["a", "b", "c"])).toBe("Choose at most 2 for Extras");
  });
  it("chosen ids, names and price in group order; price never below zero", () => {
    const c = chosenOf([spice, extras], { g1: ["hot"], g2: ["egg", "cheese"] });
    expect(c).toEqual({ ids: ["hot", "cheese", "egg"], names: ["Hot", "Cheese", "Egg"], deltaPaise: 3500 });
    expect(unitWithModifiers("120.00", c.deltaPaise)).toBe("155.00");
    expect(unitWithModifiers("10.00", -5000)).toBe("0.00");
    expect(deltaLabel({ price_delta_paise: 2000 })).toBe("+₹20.00");
    expect(deltaLabel({ price_delta_paise: -550 })).toBe("−₹5.50");
    expect(deltaLabel({ price_delta_paise: 0 })).toBe("");
  });
});

const offer = (o: Partial<Offer>): Offer => ({ id: o.name ?? "o", name: "Lunch 10%", label: `Offer: ${o.name ?? "Lunch 10%"}`, kind: "percent", value: "10", scope: "bill", target_ids: null, min_order_value: "0", max_discount: null,
  days_of_week: null, start_time: null, end_time: null, valid_from: null, valid_to: null, order_types: null, stackable: false, priority: 0, outlet_id: null, is_active: true, ...o });
const lines = [{ itemId: "karahi", categoryId: "mains", unit: "100.00", qty: 1 }, { itemId: "lassi", categoryId: "drinks", unit: "40.00", qty: 2 }];

describe("offer estimate", () => {
  it("bill percent offer", () => {
    expect(estimateOffers(lines, [offer({})], "takeaway")).toEqual({ applied: [{ offer_id: "o", name: "Lunch 10%", label: "Offer: Lunch 10%", amount: "18.00" }], total: "18.00" });
  });
  it("only the largest non-stackable offer applies; stackable ones add on what is left", () => {
    const r = estimateOffers(lines, [offer({ name: "Ten" }), offer({ name: "Flat 50", kind: "amount", value: "50" }), offer({ name: "Lassi 20", kind: "amount", value: "20", scope: "item", target_ids: ["lassi"], stackable: true })], "indoor");
    expect(r.applied.map((a) => [a.name, a.amount])).toEqual([["Flat 50", "50.00"], ["Lassi 20", "40.00"]]);
    expect(r.total).toBe("90.00");
  });
  it("min order, order types, cap and category scope", () => {
    expect(estimateOffers(lines, [offer({ min_order_value: "500" })], "takeaway").applied).toEqual([]);
    expect(estimateOffers(lines, [offer({ order_types: ["indoor"] })], "takeaway").applied).toEqual([]);
    expect(estimateOffers(lines, [offer({ value: "50", max_discount: "25" })], "takeaway").total).toBe("25.00");
    expect(estimateOffers(lines, [offer({ scope: "category", target_ids: ["drinks"] })], "takeaway").total).toBe("8.00");
  });
  it("offers + manual discount become one amount for the estimate (manual on what the offers left)", () => {
    expect(combinedDiscount("180.00", "18.00", ["Offer: Lunch 10%"], { type: "percent", value: "10", reason: "Regular" })).toEqual({ type: "amount", value: "34.20", reason: "Offer: Lunch 10%; Regular" });
    expect(combinedDiscount("180.00", "0.00", [], null)).toBeNull();
  });
});
