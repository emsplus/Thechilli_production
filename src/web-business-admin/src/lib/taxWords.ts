import { useTaxConfig } from "./taxConfig";

/**
 * The word for the sales tax on every screen. Always "GST": the product is India only.
 * Never hard-code another tax word in UI text; scripts/check-inr-only.sh fails the build on one.
 */
export type TaxWord = "GST";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function taxWord(country?: string | null): TaxWord {
  return "GST";
}

/** Form for the middle of a sentence ("GST" is an acronym, so it stays upper case). */
export const taxWordLower = (w: TaxWord) => w;

/** Phrases built from the word, so every screen says the same thing. */
export function taxPhrases(country?: string | null) {
  const w = taxWord(country);
  const l = taxWordLower(w);
  return {
    word: w,
    lower: l,
    incl: `incl. ${l}`,
    excl: `excl. ${l}`,
    pricesInclude: `Prices include ${l}`,
    /** A zero / exempt line. */
    none: "Exempt",
    notRegistered: "Not registered for GST",
    collected: `${w} collected`,
  };
}

/** The tax word for the signed-in restaurant. */
export function useTaxWord(): TaxWord { return taxWord(useTaxConfig()?.country); }
export function useTaxPhrases() { return taxPhrases(useTaxConfig()?.country); }
