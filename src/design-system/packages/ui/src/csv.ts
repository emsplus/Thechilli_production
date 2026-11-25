/**
 * CSV helpers. Cells that a spreadsheet could run as a formula ("=", "+", "-", "@" or a control
 * character first) are prefixed with an apostrophe, so exporting customer-entered names, notes or
 * item titles cannot inject formulas (OWASP "CSV injection"). Real numbers are written as-is.
 */
export type CsvValue = string | number | bigint | boolean | Date | null | undefined;

// eslint-disable-next-line no-control-regex -- control characters are exactly what we are guarding against
const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  let s = value instanceof Date ? value.toISOString() : value;
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180: CRLF between records, quotes doubled. Headers go through the same safe path. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Saves CSV text as a file. Adds a UTF-8 BOM so Excel reads Devanagari correctly. */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
