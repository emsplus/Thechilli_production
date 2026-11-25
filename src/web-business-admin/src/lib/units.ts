export type BaseUnit = "g" | "ml" | "pcs";
export const UNITS_BY_BASE: Record<BaseUnit, string[]> = { g: ["g", "kg"], ml: ["ml", "l"], pcs: ["pcs", "dozen"] };
const TO_BASE: Record<string, [BaseUnit, number]> = {
  g: ["g", 1], kg: ["g", 1000], mg: ["g", 0.001], oz: ["g", 28.3495], lb: ["g", 453.592], ml: ["ml", 1], l: ["ml", 1000], cl: ["ml", 10], dl: ["ml", 100], gallon: ["ml", 4546.09], pint: ["ml", 568.261], pcs: ["pcs", 1], dozen: ["pcs", 12], portion: ["pcs", 1],
};
const ALIAS: Record<string, string> = { gms: "g", kilos: "kg", kilogram: "kg", kilograms: "kg", litres: "l", liters: "l", ltrs: "l", millilitre: "ml", millilitres: "ml", centilitre: "cl", centilitres: "cl", decilitre: "dl", gal: "gallon", gallons: "gallon", pints: "pint", pt: "pint", ounce: "oz", ounces: "oz", lbs: "lb", pound: "lb", pounds: "lb", doz: "dozen", dozens: "dozen", portions: "portion", prtn: "portion", prtns: "portion", prt: "portion", port: "portion", gm: "g", gram: "g", grams: "g", kgs: "kg", kilo: "kg", litre: "l", liter: "l", ltr: "l", lt: "l", piece: "pcs", pieces: "pcs", pc: "pcs", nos: "pcs", each: "pcs", unit: "pcs", units: "pcs" };
export const normalizeUnit = (u: string) => { const c = u.trim().toLowerCase().replace(/\.$/, ""); return ALIAS[c] ?? c; };
export function unitsFor(base: string | undefined): string[] { return UNITS_BY_BASE[(base as BaseUnit) ?? "g"] ?? UNITS_BY_BASE.g; }
/** Base unit a unit converts to, or null when unknown. */
export function baseOf(unit: string): BaseUnit | null { return TO_BASE[normalizeUnit(unit)]?.[0] ?? null; }
/** Factor to the base unit (display estimates only, e.g. recipe previews; the server does the real conversion). */
export function factorToBase(unit: string): number { return TO_BASE[normalizeUnit(unit)]?.[1] ?? 1; }
export const BASE_LABEL: Record<BaseUnit, string> = { g: "Grams", ml: "Millilitres", pcs: "Pieces" };
/** Shows 1500 g as "1.5 kg", etc. Pure display. */
export function prettyQty(value: string | number, base: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `0 ${base}`;
  const a = Math.abs(n);
  if (base === "g" && a >= 1000) return `${+(n / 1000).toFixed(2)} kg`;
  if (base === "ml" && a >= 1000) return `${+(n / 1000).toFixed(2)} l`;
  return `${+n.toFixed(3)} ${base}`;
}
export const DECIMAL_RE = /^\d+(\.\d{1,3})?$/;
