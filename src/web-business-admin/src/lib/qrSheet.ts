import { QR_DARK, QR_LIGHT } from "./orderLink";
import { qrMatrix } from "./qr";

/**
 * Printable table QR cards: one card as a PNG, or every table on A4 sheets as a PDF (4 cards per page, cut guides). Drawn on a
 * canvas in the browser (any script in the table label or restaurant name renders, Devanagari included), so no PDF or QR
 * library is needed: `pdfFromImages` writes a minimal PDF 1.4 with one lossless (Flate) RGB image per page.
 */
export type CardKind = "menu" | "review";
export interface CardSpec { restaurant: string; label: string | null; kind: CardKind; url: string }

export const CAPTION: Record<CardKind, string> = { menu: "Scan to see our menu", review: "Scan to rate your visit" };
const INK = "#111820", MUTED = "#4b5563", LINE = "#d1d5db", ACCENT = "#e50914";
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", sans-serif';

/** A4 in PDF points (1/72 inch) and the raster size of one page at `dpi`. */
export const A4_PT = { w: 595.28, h: 841.89 };
export const a4Pixels = (dpi = 200) => ({ w: Math.round((210 / 25.4) * dpi), h: Math.round((297 / 25.4) * dpi) });

export interface Rect { x: number; y: number; w: number; h: number }
/** Card rectangles of one page: `cols` x `rows` with an outer margin and gaps (pixels). */
export function cardRects(pageW: number, pageH: number, cols = 2, rows = 2, margin = Math.round(pageW * 0.035), gap = Math.round(pageW * 0.025)): Rect[] {
  const w = Math.floor((pageW - 2 * margin - (cols - 1) * gap) / cols);
  const h = Math.floor((pageH - 2 * margin - (rows - 1) * gap) / rows);
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: margin + c * (w + gap), y: margin + r * (h + gap), w, h });
  return out;
}

/** Splits cards into pages of `per` (the last page may be partly empty). */
export const paginate = <T,>(items: T[], per = 4): T[][] => Array.from({ length: Math.ceil(items.length / per) }, (_, i) => items.slice(i * per, i * per + per));

/** Font size that makes `text` fit `maxW` (never above `size`). */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, maxW: number): number {
  let s = size;
  for (; s > 8; s -= Math.max(1, Math.round(s * 0.06))) { ctx.font = `${weight} ${s}px ${FONT}`; if (ctx.measureText(text).width <= maxW) break; }
  return s;
}

/** Draws one card: restaurant name, the table label (large), the QR, the caption and a small "Chilli Agent" footer. */
export function drawCard(ctx: CanvasRenderingContext2D, r: Rect, spec: CardSpec, opts: { guide?: boolean } = {}) {
  const pad = Math.round(Math.min(r.w, r.h) * 0.06);
  const cx = r.x + r.w / 2, inner = r.w - 2 * pad;
  ctx.save();
  ctx.fillStyle = "#ffffff"; ctx.fillRect(r.x, r.y, r.w, r.h);
  if (opts.guide) { ctx.strokeStyle = LINE; ctx.lineWidth = Math.max(1, r.w / 400); ctx.setLineDash([r.w / 60, r.w / 80]); ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.setLineDash([]); }
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  let y = r.y + pad;
  // Restaurant name
  const rs = fit(ctx, spec.restaurant, 700, Math.round(r.h * 0.055), inner);
  ctx.fillStyle = INK; ctx.font = `700 ${rs}px ${FONT}`; y += rs; ctx.fillText(spec.restaurant, cx, y);
  y += Math.round(r.h * 0.018);
  ctx.fillStyle = ACCENT; ctx.fillRect(cx - r.w * 0.08, y, r.w * 0.16, Math.max(2, r.h * 0.006));
  y += Math.round(r.h * 0.02);
  // Table label (large)
  const label = spec.label ? `Table ${spec.label}` : spec.kind === "menu" ? "Our menu" : "Rate your visit";
  const ls = fit(ctx, label, 800, Math.round(r.h * 0.1), inner);
  ctx.fillStyle = INK; ctx.font = `800 ${ls}px ${FONT}`; y += ls; ctx.fillText(label, cx, y);
  // Footer and caption take the bottom; the QR fills what is left (whole pixels per module, quiet zone of 4).
  const fs = Math.round(r.h * 0.03), capS = fit(ctx, CAPTION[spec.kind], 600, Math.round(r.h * 0.052), inner);
  const bottom = r.y + r.h - pad;
  const capY = bottom - fs - Math.round(r.h * 0.03);
  const top = y + Math.round(r.h * 0.025), avail = Math.min(inner, capY - capS - Math.round(r.h * 0.03) - top);
  const m = qrMatrix(spec.url), n = m.length + 8, mod = Math.max(1, Math.floor(avail / n)), size = mod * n;
  const qx = Math.round(cx - size / 2), qy = Math.round(top + (avail - size) / 2);
  ctx.fillStyle = QR_LIGHT; ctx.fillRect(qx, qy, size, size);
  ctx.fillStyle = QR_DARK;
  m.forEach((row, yy) => row.forEach((on, xx) => { if (on) ctx.fillRect(qx + (xx + 4) * mod, qy + (yy + 4) * mod, mod, mod); }));
  ctx.fillStyle = INK; ctx.font = `600 ${capS}px ${FONT}`; ctx.fillText(CAPTION[spec.kind], cx, capY);
  ctx.fillStyle = MUTED; ctx.font = `500 ${fs}px ${FONT}`; ctx.fillText("Chilli Agent", cx, bottom);
  ctx.restore();
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");
  return [c, ctx];
}

/** One card as a PNG (1200 x 1500 px, 4:5: a table tent or a sticker). */
export function cardPng(spec: CardSpec, w = 1200, h = 1500): Promise<Blob> {
  const [c, ctx] = canvas(w, h);
  drawCard(ctx, { x: 0, y: 0, w, h }, spec);
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("Could not make the image"))), "image/png"));
}

/** zlib (RFC 1950) compression, which is what a PDF FlateDecode stream expects. */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** RGBA pixels -> RGB. */
export function rgbOf(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { out[j] = rgba[i]; out[j + 1] = rgba[i + 1]; out[j + 2] = rgba[i + 2]; }
  return out;
}

export interface PdfImage { width: number; height: number; /** zlib-compressed 8-bit RGB rows */ data: Uint8Array }

/** A PDF 1.4 with one full-page image per page (A4 portrait). Pure: unit tested for structure and cross-reference offsets. */
export function pdfFromImages(pages: PdfImage[], title = "Table QR codes"): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let len = 0;
  const offsets: number[] = [];
  const push = (b: Uint8Array | string) => { const u = typeof b === "string" ? enc.encode(b) : b; chunks.push(u); len += u.length; };
  const obj = (n: number, body: (Uint8Array | string)[]) => { offsets[n] = len; push(`${n} 0 obj\n`); body.forEach(push); push("\nendobj\n"); };
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").replace(/([()\\])/g, "\\$1");
  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment: tells tools the file holds binary data
  const n = pages.length;
  const pageIds = pages.map((_, i) => 4 + i * 3);
  obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  obj(2, [`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${n} >>`]);
  obj(3, [`<< /Title (${ascii(title)}) /Producer (Chilli Agent) >>`]);
  const W = A4_PT.w.toFixed(2), H = A4_PT.h.toFixed(2);
  pages.forEach((img, i) => {
    const p = pageIds[i], content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(p, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`]);
    obj(p + 1, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    obj(p + 2, [`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.data.length} >>\nstream\n`, img.data, "\nendstream"]);
  });
  const total = 4 + n * 3;
  const xref = len;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let k = 1; k < total; k++) push(`${String(offsets[k]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Every card on A4 pages (4 per page, cut guides) as a PDF blob. `onPage` reports progress (1-based). */
export async function sheetPdf(cards: CardSpec[], opts: { dpi?: number; title?: string; onPage?: (page: number, of: number) => void } = {}): Promise<Blob> {
  const { w, h } = a4Pixels(opts.dpi ?? 200);
  const rects = cardRects(w, h);
  const pages = paginate(cards, rects.length);
  const images: PdfImage[] = [];
  const [, ctx] = canvas(w, h);
  for (let i = 0; i < pages.length; i++) {
    opts.onPage?.(i + 1, pages.length);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
    pages[i].forEach((spec, k) => drawCard(ctx, rects[k], spec, { guide: true }));
    images.push({ width: w, height: h, data: await deflate(rgbOf(ctx.getImageData(0, 0, w, h).data)) });
    await new Promise((r) => setTimeout(r, 0)); // keep the page responsive between pages
  }
  return new Blob([pdfFromImages(images, opts.title) as BlobPart], { type: "application/pdf" });
}
