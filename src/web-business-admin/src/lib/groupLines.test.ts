import { describe, expect, it } from "vitest";
import { groupBillLines, groupCartLines, type BillLineLike } from "./groupLines";
import { mulMoney, sumMoney } from "./money";

const line = (d: string, q: number, unit: string, over: Partial<BillLineLike> = {}): BillLineLike => ({ description: d, quantity: q, unit_price: unit, line_total: mulMoney(unit, q), ...over });

describe("identical bill lines are shown once", () => {
  it("INV/000004: 2x + 1x Chicken 65 [Mild] is 3x, the same money", () => {
    const lines = [line("Chicken 65 [Mild]", 2, "180.00"), line("Dal Fry", 1, "150.00"), line("Chicken 65 [Mild]", 1, "180.00")];
    const g = groupBillLines(lines);
    expect(g.map((l) => [l.description, l.quantity, l.line_total])).toEqual([["Chicken 65 [Mild]", 3, "540.00"], ["Dal Fry", 1, "150.00"]]);
  });
  it("different option, modifier, price or tax code stays apart", () => {
    expect(groupBillLines([line("Chicken 65 [Mild]", 1, "180.00"), line("Chicken 65 [Hot]", 1, "180.00"), line("Chicken 65 [Mild]", 1, "190.00"), line("Chicken 65 [Mild]", 1, "180.00", { tax_code: "gst_12" })])).toHaveLength(4);
  });
  it("property: quantity and money are preserved to the paisa for random lines; no two output lines are identical", () => {
    let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const names = ["Chicken 65 [Mild]", "Chicken 65 [Hot]", "Paneer Tikka", "Naan", "Lassi [Large]"]; const units = ["180.00", "180.50", "99.99", "0.01", "1250.35"];
    for (let run = 0; run < 300; run++) {
      const n = 1 + Math.floor(rnd() * 12);
      const lines = Array.from({ length: n }, () => { const q = 1 + Math.floor(rnd() * 9); const u = units[Math.floor(rnd() * units.length)]; return line(names[Math.floor(rnd() * names.length)], q, u,
        rnd() < 0.5 ? { net_amount: mulMoney(u, q), vat_amount: "0.07", gross_amount: mulMoney(u, q) } : {}); });
      const g = groupBillLines(lines);
      expect(sumMoney(g.map((l) => l.line_total))).toBe(sumMoney(lines.map((l) => l.line_total)));
      expect(g.reduce((a, l) => a + l.quantity, 0)).toBe(lines.reduce((a, l) => a + l.quantity, 0));
      expect(new Set(g.map((l) => `${l.description}|${l.unit_price}|${l.tax_code ?? ""}`)).size).toBe(g.length);
      expect(g.length).toBeLessThanOrEqual(lines.length);
      for (const x of g) expect(x.line_total).toBe(mulMoney(x.unit_price, x.quantity)); // unit x quantity still equals the line total
    }
  });
});

describe("identical cart lines (order panel, receipt)", () => {
  const cl = (key: string, qty: number, over: Record<string, unknown> = {}) => ({ key, item: { id: "i1" }, variantId: null, unit: "180.00", qty, ...over });
  it("groups dish + option + modifiers + note + price; totals equal", () => {
    const lines = [cl("srv:1", 2, { mods: { ids: ["m1"] } }), cl("srv:2", 1, { mods: { ids: ["m1"] } }), cl("srv:3", 1, { note: "no onion" }), cl("srv:4", 1, { unit: "190.00", mods: { ids: ["m1"] } })];
    const g = groupCartLines(lines);
    expect(g.map((l) => [l.keys.join(","), l.qty])).toEqual([["srv:1,srv:2", 3], ["srv:3", 1], ["srv:4", 1]]);
    expect(sumMoney(g.map((l) => mulMoney(l.unit, l.qty)))).toBe(sumMoney(lines.map((l) => mulMoney(l.unit, l.qty))));
  });
});
