import type { CountryCode } from "./types";

/** India's wording and tax-number rules (the server is the authority). The product is INR / India only. */
export interface CountryInfo { code: CountryCode; name: string; currency: string; currencySymbol: string; timezone: string; taxName: string; taxNumberLabel: string; example: string; regex: RegExp; message: string; help: string }

export const INDIA: CountryInfo = {
  code: "IN", name: "India", currency: "INR", currencySymbol: "₹", timezone: "Asia/Kolkata", taxName: "GST", taxNumberLabel: "GSTIN", example: "27AAPFU0939F1ZV",
  regex: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
  message: "A GSTIN has 15 characters, like 27AAPFU0939F1ZV (or leave it empty)",
  help: "15 characters from your GST registration. Shown on tax invoices with CGST / SGST.",
};

/** The only country a restaurant can register in (/register sends country IN; the server refuses any other). */
export const SIGNUP_COUNTRY = "IN" satisfies CountryCode;

/** India for every account. `code` is accepted so callers can pass the restaurant's country as the server sends it. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const countryInfo = (code?: string | null): CountryInfo => INDIA;

/** Strips spaces and dashes, upper-cases (what the server stores). */
export const normaliseTaxNumber = (v: string) => v.replace(/[\s-]/g, "").toUpperCase();

/** Error message for a GSTIN, or null when empty or valid. */
export function taxNumberError(country: string | null | undefined, value: string): string | null {
  const v = normaliseTaxNumber(value);
  if (!v) return null;
  return INDIA.regex.test(v) ? null : INDIA.message;
}

/** Title of the document a finalized bill is: a Bill of supply when the seller is not GST registered. */
export function billTitle(country: string | null | undefined, vatRegistered: boolean | undefined): string {
  if (vatRegistered === false) return "Bill of supply";
  return "Tax invoice";
}
