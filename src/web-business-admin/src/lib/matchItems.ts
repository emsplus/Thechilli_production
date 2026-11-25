/**
 * Pure helpers that turn an OCR invoice description into stock-item decisions. No React, no network: unit-tested by
 * e2e/match-items.spec.ts (Playwright, no browser).
 *
 *  - cleanItemName: "BASMATI RICE 20kg bag" -> "Basmati Rice"
 *  - suggestItem:   best existing item for a description (exact normalised match wins, else Jaccard >= MATCH_THRESHOLD)
 *  - parsePack:     "Cooking Oil 20L", "12 x 1L", "6x330ml", "Eggs tray 30" -> how much one pack holds
 *  - inferBaseUnit: g | ml | pcs for a new item
 */
import { mulDecimal, trimDecimal } from "./decimal";
import { baseOf, factorToBase, normalizeUnit, type BaseUnit } from "./units";

/** Similarity (Jaccard of normalised name tokens) needed before an item is suggested. */
export const MATCH_THRESHOLD = 0.6;

const UNIT_WORDS = new Set(["kg", "kgs", "g", "gm", "gms", "gram", "grams", "mg", "l", "lt", "ltr", "ltrs", "litre", "litres", "liter", "liters", "ml", "cl",
  "pint", "pints", "oz", "lb", "lbs", "pcs", "pc", "piece", "pieces", "dozen", "doz", "each", "ea", "x", "per", "of"]);
const PACK_WORDS = new Set(["bag", "bags", "sack", "sacks", "tray", "trays", "box", "boxes", "carton", "cartons", "pack", "packs", "packet", "packets", "case", "cases",
  "tin", "tins", "can", "cans", "bottle", "bottles", "jar", "jars", "bunch", "bunches", "tub", "tubs", "crate", "crates", "drum", "drums", "pot", "pots", "btl", "ctn", "pkt"]);
/** Words that say nothing about WHICH ingredient it is. */
const NOISE = new Set(["fresh", "pure", "premium", "best", "quality", "grade", "natural", "the", "and", "a", "an", "with", "in", "whole", "large", "medium", "small", "extra", "fine", "finest", "select", "choice", "standard"]);

/** Packaging words that also say what the product IS ("Beer Bottles" vs "Beer 11 Gallons"): kept in the name. */
const FORM_WORDS = new Set(["bottle", "bottles", "can", "cans", "btl"]);
const SIZE_TOKEN = /^\d+(?:[.,]\d+)?(?:kg|kgs|g|gm|mg|l|lt|ltr|litre|litres|liter|ml|cl|pint|pints|oz|lb|lbs|pcs|pc|s)?$/;

function singular(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(ches|shes|sses|xes|zes|oes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

/** Lower-case words with sizes, numbers, units, packaging and filler removed, plural folded to singular. */
export function nameTokens(s: string): string[] {
  const words = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ")
    .replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2").split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (/^\d+$/.test(w) || UNIT_WORDS.has(w) || PACK_WORDS.has(w) || NOISE.has(w)) continue;
    out.push(singular(w));
  }
  return out;
}

export const normalizedName = (s: string) => [...new Set(nameTokens(s))].sort().join(" ");

export function similarity(a: string, b: string): number {
  const A = new Set(nameTokens(a)), B = new Set(nameTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  // "Chicken Breast Fillet" vs "Chicken Breast": the shorter name sits inside the longer one (two or more words).
  const contain = Math.min(A.size, B.size) >= 2 ? (0.85 * inter) / Math.min(A.size, B.size) : 0;
  return Math.max(jaccard, contain);
}

export interface Suggestion<T> { item: T; score: number; exact: boolean }

/** Best existing item for an invoice description, or null. Deterministic: ties go to the shorter, then alphabetical, name. */
export function suggestItem<T extends { name: string }>(description: string, items: T[], threshold = MATCH_THRESHOLD): Suggestion<T> | null {
  const key = normalizedName(description);
  if (!key) return null;
  let best: Suggestion<T> | null = null;
  const order = [...items].sort((x, y) => x.name.length - y.name.length || x.name.localeCompare(y.name));
  for (const item of order) {
    const exact = normalizedName(item.name) === key;
    const score = exact ? 1 : similarity(description, item.name);
    if (score < threshold && !exact) continue;
    if (!best || (exact && !best.exact) || (exact === best.exact && score > best.score)) best = { item, score, exact };
  }
  return best;
}

const titleCase = (w: string) => (/\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

/** Cleans an OCR description into a stock-item name: no sizes, no trailing quantities or packaging words, Title Case. */
export function cleanItemName(description: string): string {
  let words = description.replace(/\s+/g, " ").trim().replace(/\([^)]*\)/g, " ").split(/\s+/).filter(Boolean);
  const br = words.findIndex((w, i) => i > 0 && /^br\.?$/i.test(w)); // "... GRADE 1 Br LORDS CHOICE": the brand line some invoices print under the product
  if (br > 0) words = words.slice(0, br);
  const kept = words.filter((w) => !(SIZE_TOKEN.test(w.toLowerCase()) && /\d/.test(w) && /[a-z]/i.test(w)) && !/^\d{1,3}p$/i.test(w) && !/^\d+(?:[.,]\d+)?[x*]\d+(?:[.,]\d+)?[a-z]*$/i.test(w));
  const tail = (w: string) => /^\d+(?:[.,]\d+)?$/.test(w) || UNIT_WORDS.has(w.toLowerCase()) || (PACK_WORDS.has(w.toLowerCase()) && !FORM_WORDS.has(w.toLowerCase())) || /^x\d+$/i.test(w) || /^[-,/]+$/.test(w);
  const dangling = (w: string) => /^(plastic|glass|tin|paper)$/i.test(w); // "RAPESEED OIL PLASTIC BOTTLES" -> bottles dropped, "plastic" would dangle
  while (kept.length > 1 && (tail(kept[kept.length - 1]) || (kept.length > 2 && dangling(kept[kept.length - 1])))) kept.pop();
  const cleaned = kept.join(" ").replace(/[\s,\-/]+$/, "").trim();
  const out = /[a-z]{2}/i.test(cleaned) ? cleaned : description.trim(); // nothing but sizes left: keep the text rather than invent a name
  return out.split(" ").map(titleCase).join(" ").slice(0, 200);
}

export interface Pack {
  /** Decimal string: how much ONE pack of the line holds. */
  quantity: string;
  /** kg | g | l | ml | pcs */
  unit: string;
  /** For "N x size" packs: the size of each of the N pieces. */
  each?: { count: number; quantity: string; unit: string };
}

const U = "(kg|kgs|g|gm|mg|litres?|liters?|ltr|lt|l|ml|cl|pints?|pt|oz|lb|lbs)";
const NUM = "(\\d+(?:[.,]\\d+)?)";
const num = (s: string) => s.replace(",", ".");
/** pint -> ml (UK pint 568 ml), cl -> ml; everything else is already a supported unit. */
function toSupported(q: string, unit: string): { quantity: string; unit: string } | null {
  const u = unit.toLowerCase();
  if (/^pints?$|^pt$/.test(u)) return { quantity: trimDecimal(mulDecimal(q, "568", 3)), unit: "ml" };
  if (u === "cl") return { quantity: trimDecimal(mulDecimal(q, "10", 3)), unit: "ml" };
  if (u === "oz") return { quantity: trimDecimal(mulDecimal(q, "28.35", 3)), unit: "g" };
  if (u === "lb" || u === "lbs") return { quantity: trimDecimal(mulDecimal(q, "453.6", 3)), unit: "g" };
  const n = normalizeUnit(u);
  return baseOf(n) ? { quantity: trimDecimal(q), unit: n } : null;
}

/** Reads a pack size out of a description. `lineQty` helps choose between "1kg x 5" read as 5 pieces of 1 kg or one 5 kg case. */
export function parsePack(description: string, lineQty?: string): Pack | null {
  const d = description.toLowerCase().replace(/[×*]/g, "x");
  // 12 x 1L, 6x330ml, 4 pint x 6 (count first or last)
  let m = new RegExp(`${NUM}\\s*x\\s*${NUM}\\s*${U}\\b`).exec(d);
  let count: number | null = null, size: string | null = null, unit = "";
  if (m) { count = Number(num(m[1])); size = num(m[2]); unit = m[3]; }
  else if ((m = new RegExp(`${NUM}\\s*${U}\\s*x\\s*(\\d+)\\b`).exec(d))) { size = num(m[1]); unit = m[2]; count = Number(m[3]); }
  if (m && count && size) {
    const each = toSupported(size, unit);
    if (each) {
      const asEach = lineQty != null && Number(lineQty) === count; // "Paneer 1kg x 5" with quantity 5: each one is 1 kg
      const total = toSupported(trimDecimal(mulDecimal(size, String(count), 3)), unit)!;
      return { quantity: asEach ? each.quantity : total.quantity, unit: asEach ? each.unit : total.unit, each: { count, quantity: each.quantity, unit: each.unit } };
    }
  }
  if ((m = new RegExp(`${NUM}\\s*${U}\\b`).exec(d))) {
    const s = toSupported(num(m[1]), m[2]);
    if (s) return s;
  }
  if ((m = /(\d+)\s*(?:pcs|pc|pieces|eggs|nos|ct)\b/.exec(d)) || (m = /\b(?:tray|pack|box|case|carton|bag|crate)\s*(?:of\s*)?(\d+)\b/.exec(d)) || (m = /\b(?:of|x)\s*(\d+)\s*(?:pcs|pc|pieces|eggs)?\b/.exec(d))) {
    return { quantity: m[1], unit: "pcs" };
  }
  if (/\bdozen\b|\bdoz\b/.test(d)) return { quantity: "12", unit: "pcs" };
  return null;
}

/** Drinks that arrive as a case of bottles / cans are counted in bottles, not litres. */
const DRINK = /\b(beer|lager|cider|ale|stout|wine|cola|coke|pepsi|fanta|sprite|lemonade|soda|juice|water|drink|shandy|kingfisher|cobra|corona|budweiser|bottles?|cans?)\b/i;

export interface PackHint { count_total?: string | null; measure?: { quantity: string; unit: string } | null; unit_size?: string | null; unit_size_unit?: string | null }

/**
 * Base unit for a new stock item, with the reason (shown in the dialog so the choice is explicit and editable).
 * The invoice unit wins when it is a weight or volume. A case of bottles/cans of a drink is counted in pieces (bottles);
 * other liquids and goods follow their weight/volume; a count unit ("each", "pcs") or a packaging unit ("bag") defers to a
 * weight/volume pack size in the text ("Cooking Oil 20L" -> ml), else pcs.
 */
export function proposeBaseUnit(unit: string, description = "", pack?: PackHint | null): { unit: BaseUnit; reason: string } {
  const own = baseOf(unit);
  const sizeMl = pack?.unit_size && pack.unit_size_unit && baseOf(pack.unit_size_unit) === "ml" ? Number(pack.unit_size) * factorToBase(pack.unit_size_unit) : null;
  const each = parsePack(description)?.each;
  const bottles = pack?.count_total && Number(pack.count_total) > 1 ? Number(pack.count_total) : each && each.count > 1 ? each.count : 0;
  const bottleMl = sizeMl ?? (each && baseOf(each.unit) === "ml" ? Number(each.quantity) * factorToBase(each.unit) : null);
  if (bottles > 1 && (own === "ml" || (own === null && bottleMl !== null) || (pack?.measure && baseOf(pack.measure.unit) === "ml")) && DRINK.test(description) && (bottleMl === null || bottleMl <= 2000)) {
    return { unit: "pcs", reason: `Sold as ${bottles} bottles or cans per case, so it is counted in pieces. Choose ml to track it by volume.` };
  }
  if (own === "g" || own === "ml") return { unit: own, reason: own === "g" ? "Counted by weight." : "Counted by volume." };
  const p = parsePack(description);
  const fromPack = p ? baseOf(p.unit) : null;
  if (fromPack === "g" || fromPack === "ml") return { unit: fromPack, reason: `Taken from the size in the description (${p!.quantity} ${p!.unit}).` };
  return { unit: "pcs", reason: "Counted in pieces." };
}

export function inferBaseUnit(unit: string, description = "", pack?: PackHint | null): BaseUnit { return proposeBaseUnit(unit, description, pack).unit; }
