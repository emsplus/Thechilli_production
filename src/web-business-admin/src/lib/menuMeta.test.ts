import { describe, expect, it } from "vitest";
import { cleanDescription, DESCRIPTION_MAX, FOOD_LABEL, foodTypeOf, isVegOnlyMatch, vegOf } from "./menuAdmin";

describe("menu metadata (food mark, description)", () => {
  it("reads the three FSSAI kinds and treats anything else as not marked", () => {
    expect(vegOf({ food_type: "veg" })).toBe("veg");
    expect(vegOf({ food_type: "non_veg" })).toBe("nonveg");
    expect(vegOf({ food_type: "egg" })).toBe("egg"); // egg is its own mark, never folded into non-veg
    expect(vegOf({ food_type: "EGG" })).toBe("egg");
    expect(vegOf({ food_type: null })).toBeNull();
    expect(vegOf({ food_type: "jain" })).toBeNull();
    expect(vegOf({})).toBeNull();
    expect(vegOf({ is_veg: false })).toBe("nonveg"); // legacy flag only when food_type is absent
    expect(vegOf({ food_type: "egg", is_veg: true })).toBe("egg");
  });
  it("maps back to the API value", () => {
    expect(foodTypeOf("nonveg")).toBe("non_veg");
    expect(foodTypeOf("veg")).toBe("veg");
    expect(foodTypeOf("egg")).toBe("egg");
    expect(foodTypeOf(null)).toBeNull();
    expect(Object.values(FOOD_LABEL)).toEqual(["Veg", "Non-veg", "Egg"]);
  });
  it("Veg only keeps veg dishes: egg and unmarked are left out", () => {
    const menu = [{ food_type: "veg" }, { food_type: "egg" }, { food_type: "non_veg" }, { food_type: null }];
    expect(menu.filter(isVegOnlyMatch)).toEqual([{ food_type: "veg" }]);
  });
  it("descriptions are one trimmed line, counted like the server", () => {
    expect(cleanDescription("  Paneer in\n tomato   gravy ")).toBe("Paneer in tomato gravy");
    expect(cleanDescription("   ")).toBe("");
    expect(DESCRIPTION_MAX).toBe(280);
    expect(cleanDescription(`${"a".repeat(280)}\n\n`).length).toBe(280);
  });
});
