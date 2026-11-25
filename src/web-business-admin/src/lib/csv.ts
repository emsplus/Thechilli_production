/** Minimal RFC 4180 CSV builder + download trigger (client only). */
const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r\n]/;
function cell(v: string | number): string {
  let s = String(v);
  // Neutralise spreadsheet formulas. A trigger may hide behind leading spaces / control characters (security review 2026-11-02), and a
  // leading tab / CR / LF is a trigger itself. Genuine numbers ("-5", "+3.2": no leading whitespace) stay numbers.
  if (FORMULA_START.test(s) && !(/^[+-]?\d/.test(s) && !Number.isNaN(Number(s)))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows: (string | number)[][]): string { return rows.map((r) => r.map(cell).join(",")).join("\r\n"); }
export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
