import { describe, expect, it } from "vitest";
import { dishScore, searchDishes } from "./dishSearch";

const menu = ["Paneer Tikka", "Palak Paneer", "Chicken Biryani", "Mutton Biryani", "Masala Chai", "Butter Chicken", "Garlic Naan", "Butter Naan", "Filter Coffee", "Dal Makhani"].map((name) => ({ name }));
const names = (q: string) => searchDishes(menu, q).map((x) => x.name);

describe("dish search (C-15)", () => {
  it("finds Hinglish spellings", () => {
    expect(names("panir")).toEqual(expect.arrayContaining(["Paneer Tikka", "Palak Paneer"]));
    expect(names("biriyani")).toEqual(expect.arrayContaining(["Chicken Biryani", "Mutton Biryani"]));
    expect(names("butter chiken")).toContain("Butter Chicken");
    expect(names("nan")).toEqual(expect.arrayContaining(["Garlic Naan", "Butter Naan"]));
  });
  it("finds Devanagari and English words", () => {
    expect(names("पनीर")).toEqual(expect.arrayContaining(["Paneer Tikka", "Palak Paneer"]));
    expect(names("tea")).toEqual(["Masala Chai"]);
    expect(names("बिरयानी")).toContain("Chicken Biryani");
  });
  it("finds initials", () => {
    expect(names("bc")[0]).toBe("Butter Chicken");
    expect(names("gn")[0]).toBe("Garlic Naan");
  });
  it("keeps plain substring matches and rejects nonsense", () => {
    expect(names("tikka")).toEqual(["Paneer Tikka"]);
    expect(names("pizza")).toEqual([]);
    expect(dishScore("Masala Chai", "")).toBe(0);
  });
});
