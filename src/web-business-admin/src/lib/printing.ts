import { formatDateTime } from "./datetime";
import { api } from "./api";

/** Browser-side helpers for printing / downloading / sharing receipt PDFs. All best-effort and try/catch-safe. */

export function openBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (!w) throw new Error("Pop-up blocked. Allow pop-ups for this site to open the PDF.");
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

/** Print a PDF blob via a hidden iframe; falls back to opening it in a new tab (viewer's own print button). */
export function printBlob(blob: Blob): Promise<void> {
  const nav = navigator as Navigator & { pdfViewerEnabled?: boolean };
  if (nav.pdfViewerEnabled === false) { openBlob(blob); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    const cleanup = () => setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60_000);
    frame.onload = () => {
      try { frame.contentWindow?.focus(); frame.contentWindow?.print(); resolve(); cleanup(); }
      catch { cleanup(); try { openBlob(blob); resolve(); } catch (e) { reject(e); } }
    };
    frame.src = url;
    document.body.appendChild(frame);
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Light client-side phone check: returns digits-only international number (no +) or null. Indian mobile 98765 43210 / 098765 43210 -> 91 98765 43210. */
export function waDigits(input: string): string | null {
  let d = input.replace(/[\s\-().]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (/^0?[6-9]\d{9}$/.test(d)) d = `91${d.slice(-10)}`;
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

export const waUrl = (digits: string, text: string) => `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;

/** Share the actual PDF through the OS share sheet when the platform supports sharing files. */
export async function shareFile(blob: Blob, filename: string, text: string): Promise<"shared" | "cancelled" | "unsupported"> {
  try {
    const file = new File([blob], filename, { type: "application/pdf" });
    if (typeof navigator.canShare !== "function" || typeof navigator.share !== "function" || !navigator.canShare({ files: [file] })) return "unsupported";
    await navigator.share({ files: [file], text, title: filename });
    return "shared";
  } catch (e) {
    return e instanceof DOMException && e.name === "AbortError" ? "cancelled" : "unsupported";
  }
}

/** Per-device "auto-print KOT when sent" preference (default off). */
export const autoPrintKot = {
  get(): boolean { try { return localStorage.getItem("pos.autoPrintKot") === "1"; } catch { return false; } },
  set(on: boolean) { try { localStorage.setItem("pos.autoPrintKot", on ? "1" : "0"); } catch { /* storage unavailable */ } },
};

/** Per-device "print the Z slip straight after closing the day" preference (default off). */
export const autoPrintZ = {
  get(): boolean { try { return localStorage.getItem("pos.autoPrintZ") === "1"; } catch { return false; } },
  set(on: boolean) { try { localStorage.setItem("pos.autoPrintZ", on ? "1" : "0"); } catch { /* storage unavailable */ } },
};

export async function printKotSlip(kotId: string) { await printBlob(await api.kotSlipBlob(kotId)); }

export interface OfflineKot { ref: string; where: string; at: string; lines: { qty: number; label: string; note?: string | null }[] }

/** Offline fallback: a simple client-rendered KOT slip printed through the same `.print-area` mechanism. */
export function printOfflineKot(k: OfflineKot) {
  const root = document.createElement("div");
  root.className = "print-area hidden print:block";
  root.style.cssText = "background:#fff;color:#000;font:12px/1.35 ui-monospace,Menlo,Consolas,monospace;padding:6px;width:80mm";
  const add = (text: string, css = "") => { const d = document.createElement("div"); d.textContent = text; d.style.cssText = css; root.appendChild(d); return d; };
  const rule = () => add("", "border-top:1px dashed #000;margin:4px 0");
  add("KOT", "text-align:center;font:700 26px/1.1 system-ui,sans-serif");
  add(k.ref, "text-align:center;font-weight:700");
  add("OFFLINE COPY - not yet synced", "text-align:center;font-size:10px");
  rule();
  add(`${k.where}   ${formatDateTime(k.at)}`);
  rule();
  const head = add("ITEM", "display:flex;justify-content:space-between;font-weight:700");
  head.appendChild(Object.assign(document.createElement("span"), { textContent: "QTY" }));
  k.lines.forEach((l, i) => {
    const row = add(`${i + 1}. ${l.label}`, "display:flex;justify-content:space-between;gap:8px;font-weight:700;margin-top:3px");
    row.appendChild(Object.assign(document.createElement("span"), { textContent: String(l.qty) }));
    if (l.note) add(`  - ${l.note}`, "font-size:10px");
  });
  rule();
  add(`Total: ${k.lines.length} item${k.lines.length === 1 ? "" : "s"}`, "text-align:right;font-weight:700");
  rule();
  document.body.appendChild(root);
  const done = () => { root.remove(); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(done, 60_000);
}
