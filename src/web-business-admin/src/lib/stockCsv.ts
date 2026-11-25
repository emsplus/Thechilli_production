/**
 * Spreadsheet -> stock items. Pure (no React): parse CSV / tab-separated text pasted from Excel, detect an optional
 * header, validate each row. Columns: name, unit, opening_quantity, reorder_level, unit_cost. Every numeric column is
 * in the row's own unit (20 kg, reorder at 5 kg, 1.80 per kg); the server converts to the item's base unit.
 */
import { mulDecimal } from "./decimal";
import { baseOf, factorToBase, normalizeUnit, type BaseUnit } from "./units";

export const CSV_HEADER = ["name", "unit", "opening_quantity", "reorder_level", "unit_cost"] as const;
export const CSV_TEMPLATE: string[][] = [
  [...CSV_HEADER],
  ["Basmati Rice", "kg", "40", "10", "1.85"],
  ["Whole Milk", "l", "24", "12", "1.10"],
  ["Eggs", "dozen", "10", "5", "2.40"],
  ["Fresh Coriander", "pcs", "", "10", ""],
];

/** RFC 4180-ish: quoted fields, "" escapes, CRLF/LF/CR, BOM, tab / semicolon / comma delimiters (auto-detected). */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r\n|\n|\r/).find((l) => l.trim()) ?? "";
  const unq = firstLine.replace(/"[^"]*"/g, "");
  const count = (c: string) => unq.split(c).length - 1;
  const delim = count("\t") > 0 ? "\t" : count(";") > count(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, i = 0;
  const endCell = () => { row.push(cell); cell = ""; };
  const endRow = () => { endCell(); if (row.some((c) => c.trim() !== "")) rows.push(row.map((c) => c.trim())); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) endCell();
    else if (ch === "\r") { if (text[i + 1] === "\n") i++; endRow(); }
    else if (ch === "\n") endRow();
    else cell += ch;
    i++;
  }
  if (cell !== "" || row.length) endRow();
  return rows;
}

/** True when a cell carries a currency sign other than ₹ (U+00A3, U+0024, U+20AC, U+00A5): never converted, the row is flagged. */
export const foreignCurrency = (raw: string) => /[\u00A3$\u20AC\u00A5]/.test(raw);

/**
 * Money / quantity formats: "1,250.50", "1,25,000" (lakh grouping), "₹180" (or an Rs, Rs. or INR prefix), "₹180/-", " 12 ", "2,5" (decimal comma)
 * -> "1250.50". null when not a number, or when it carries another currency's sign (see foreignCurrency).
 */
export function parseNumber(raw: string): string | null {
  if (foreignCurrency(raw)) return null;
  const s = raw.replace(/^\s*'?\s*(₹|rs\.?|inr)/i, "").replace(/\s/g, "").replace(/^'/, "").replace(/\/-$/, ""); // "₹180/-" is 180
  if (/^\d+(\.\d+)?$/.test(s)) return s;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return s.replace(/,/g, "");
  if (/^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/.test(s)) return s.replace(/,/g, "");
  if (/^\d+,\d{1,2}$/.test(s)) return s.replace(",", ".");
  if (/^\.\d+$/.test(s)) return `0${s}`;
  return null;
}

const HEADER_WORDS: Record<(typeof CSV_HEADER)[number], string[]> = {
  name: ["name", "item", "itemname", "product", "description", "ingredient", "stockitem"],
  unit: ["unit", "uom", "units", "measure"],
  opening_quantity: ["openingquantity", "openingqty", "opening", "quantity", "qty", "stock", "onhand", "currentstock", "balance", "openingstock"],
  reorder_level: ["reorderlevel", "reorder", "reorderat", "minimum", "min", "minstock", "parlevel", "par"],
  unit_cost: ["unitcost", "cost", "price", "unitprice", "costperunit", "costprice"],
};
const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

export interface StockRow {
  /** 1-based spreadsheet row (the header is row 1 when there is one). */
  row: number;
  name: string; unit: string; opening: string; reorder: string; cost: string;
  base: BaseUnit | null;
  errors: string[];
  /** "ok" rows are imported; "duplicate" and "existing" rows are skipped; "error" rows need fixing. */
  status: "ok" | "error" | "duplicate" | "existing";
  note?: string;
}

export interface ParsedSheet { rows: StockRow[]; hasHeader: boolean; columns: Record<(typeof CSV_HEADER)[number], number> }

export function parseStockSheet(text: string, existingNames: string[] = []): ParsedSheet {
  const table = parseCsv(text);
  const first = table[0]?.map(squash) ?? [];
  const hits = first.filter((c) => Object.values(HEADER_WORDS).some((w) => w.includes(c))).length;
  const hasHeader = table.length > 0 && hits >= 1 && !table[0].slice(1).some((c) => parseNumber(c) !== null && c.trim() !== "");
  const columns = { name: 0, unit: 1, opening_quantity: 2, reorder_level: 3, unit_cost: 4 };
  if (hasHeader) {
    const used = new Set<number>();
    (Object.keys(HEADER_WORDS) as (keyof typeof HEADER_WORDS)[]).forEach((k) => {
      const idx = first.findIndex((c, i) => !used.has(i) && HEADER_WORDS[k].includes(c));
      columns[k] = idx;
      if (idx >= 0) used.add(idx);
    });
    if (columns.name < 0) columns.name = 0;
  }
  const existing = new Set(existingNames.map((n) => n.trim().replace(/\s+/g, " ").toLowerCase()));
  const seen = new Map<string, number>();
  const body = hasHeader ? table.slice(1) : table;
  const rows: StockRow[] = body.map((cells, n) => {
    const get = (k: keyof typeof columns) => (columns[k] >= 0 ? (cells[columns[k]] ?? "").trim() : "");
    const name = get("name").replace(/\s+/g, " ");
    const r: StockRow = { row: n + 1 + (hasHeader ? 1 : 0), name, unit: get("unit"), opening: get("opening_quantity"), reorder: get("reorder_level"), cost: get("unit_cost"), base: null, errors: [], status: "ok" };
    if (!name) r.errors.push("Name is empty");
    else if (name.length > 200) r.errors.push("Name is too long");
    if (!r.unit) r.errors.push("Add a unit (kg, g, l, ml, pcs or dozen)");
    else if ((r.base = baseOf(r.unit)) === null) r.errors.push(`Unit "${r.unit}" cannot be counted. Use kg, g, l, ml, pcs or dozen`);
    for (const [label, v] of [["Opening quantity", r.opening], ["Reorder level", r.reorder], ["Unit cost", r.cost]] as const) {
      if (v && foreignCurrency(v)) r.errors.push(`${label} "${v}" is not in rupees: enter the amount in ₹`);
      else if (v && parseNumber(v) === null) r.errors.push(`${label} "${v}" is not a number`);
    }
    if (r.errors.length) { r.status = "error"; return r; }
    const key = name.toLowerCase();
    if (seen.has(key)) { r.status = "duplicate"; r.note = `Same as row ${seen.get(key)}; skipped`; return r; }
    seen.set(key, r.row);
    if (existing.has(key)) { r.status = "existing"; r.note = "Already in your stock list; skipped"; }
    return r;
  });
  return { rows, hasHeader, columns };
}

export interface BulkItemPayload { name: string; base_unit: BaseUnit; reorder_level: string; opening_quantity?: string; opening_unit?: string; unit_cost?: string }

/** Rows that will be created, in the shape POST /inventory/items/bulk wants (reorder level in base units). */
export function toBulkItems(rows: StockRow[]): BulkItemPayload[] {
  return rows.filter((r) => r.status === "ok" && r.base).map((r) => {
    const unit = normalizeUnit(r.unit);
    const o = r.opening ? parseNumber(r.opening) : null, c = r.cost ? parseNumber(r.cost) : null, re = r.reorder ? parseNumber(r.reorder) : null;
    const p: BulkItemPayload = { name: r.name, base_unit: r.base!, reorder_level: re ? mulDecimal(re, String(factorToBase(unit)), 3) : "0" };
    if (o && Number(o) > 0) { p.opening_quantity = o; p.opening_unit = unit; if (c) p.unit_cost = c; }
    return p;
  });
}
