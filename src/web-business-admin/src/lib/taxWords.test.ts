import { describe, expect, it } from "vitest";
import { taxPhrases, taxWord } from "./taxWords";

describe("tax wording", () => {
  it("says GST, with or without a known country", () => {
    expect(taxWord("IN")).toBe("GST");
    expect(taxWord("")).toBe("GST");
    expect(taxWord(null)).toBe("GST");
    const p = taxPhrases("IN");
    expect(p.incl).toBe("incl. GST");
    expect(p.pricesInclude).toBe("Prices include GST");
    expect(p.none).toBe("Exempt");
    expect(taxPhrases(undefined).incl).toBe("incl. GST");
  });
});
