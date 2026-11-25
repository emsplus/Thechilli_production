import { describe, expect, it } from "vitest";
import { formatCompactMoney, formatCurrency, formatMoney } from "./money";

describe("formatMoney", () => {
  it("groups Indian style (lakh / crore) and keeps small amounts unchanged", () => {
    expect(formatMoney("1234.5")).toBe("1,234.50");
    expect(formatMoney("123456.5")).toBe("1,23,456.50");
    expect(formatMoney("12345678")).toBe("1,23,45,678.00");
  });
  it("keeps the sign and handles invalid input", () => {
    expect(formatMoney("-123456")).toBe("-1,23,456.00");
    expect(formatMoney("abc")).toBe("0.00");
  });
});

describe("formatCompactMoney", () => {
  it("abbreviates to lakh and crore without rounding up", () => {
    expect(formatCompactMoney("99999", "INR")).toBe("₹99,999.00");
    expect(formatCompactMoney("123456", "INR")).toBe("₹1.2 L");
    expect(formatCompactMoney("999999", "INR")).toBe("₹9.9 L");
    expect(formatCompactMoney("12345678", "INR")).toBe("₹1.2 Cr");
    expect(formatCompactMoney("-12345678", "INR")).toBe("-₹1.2 Cr");
  });
  it("speaks the chosen language", () => {
    expect(formatCompactMoney("250000", "INR", "hi")).toBe("₹2.5 लाख");
    expect(formatCompactMoney("20000000", "INR", "hi")).toBe("₹2 करोड़");
    expect(formatCompactMoney("250000", "INR", "hinglish")).toBe("₹2.5 lakh");
  });
});

describe("one money format (no space after ₹, Indian grouping)", () => {
  it("formatCurrency glues the rupee sign to the figure", () => {
    expect(formatCurrency("18625", "INR")).toBe("₹18,625.00");
    expect(formatCurrency("1234567", "INR")).toBe("₹12,34,567.00");
    expect(formatCurrency("-50", "INR")).toBe("-₹50.00");
    expect(formatCurrency("550", "INR", 0)).toBe("₹550");
    expect(formatCurrency("18625", "INR")).not.toMatch(/₹\s/);
  });
  it("compact tiles: full figure under one lakh, lakh / crore above, same symbol rule", () => {
    expect(formatCompactMoney("18625", "INR")).toBe("₹18,625.00");
    expect(formatCompactMoney("1234567", "INR")).toBe("₹12.3 L");
    expect(formatCompactMoney("123456789", "INR")).toBe("₹12.3 Cr");
    for (const v of ["5", "99999.99", "100000", "25000000"]) expect(formatCompactMoney(v, "INR")).toMatch(/^₹\d/);
  });
});

import { compact } from "@/components/charts/use-width";
describe("chart axis figures use lakh / crore too", () => {
  it("never shows millions", () => {
    expect(compact(2500)).toBe("2.5K");
    expect(compact(250000)).toBe("2.5 L");
    expect(compact(25000000)).toBe("2.5 Cr");
    expect(compact(1500000)).toBe("15 L");
  });
});

import { currencyPrefix, formatCurrency as fc, formatInrAscii, RUPEE_ASCII } from "./money";
describe("INR only", () => {
  it("shows ₹ for INR and for a missing code", () => {
    for (const c of ["INR", "", null, undefined]) expect(currencyPrefix(c)).toBe("₹");
    expect(fc("123456.5", "INR")).toBe("₹1,23,456.50");
    expect(fc("-5", "INR")).toBe("-₹5.00");
  });
  it("still shows ₹ when a foreign code comes in (never another currency)", () => {
    for (const c of ["AED", "GBP", "USD"]) expect(currencyPrefix(c)).toBe("₹");
    expect(fc("123456.5", "GBP")).toBe("₹1,23,456.50");
  });
  it("prints the ASCII rupee for fonts without the ₹ glyph", () => {
    expect(RUPEE_ASCII).toMatch(/^[ -~]+$/); // ASCII only
    expect(formatInrAscii("123456.5")).toBe(`${RUPEE_ASCII} 1,23,456.50`);
    expect(formatInrAscii("-5")).toBe(`-${RUPEE_ASCII} 5.00`);
  });
});
