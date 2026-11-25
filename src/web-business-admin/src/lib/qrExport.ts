import { QR_DARK, QR_LIGHT, qrSvgMarkup } from "./orderLink";
import { qrMatrix } from "./qr";

/** Browser-only helpers to hand the QR of the ordering link to the owner as a file (SVG for print shops, PNG for a phone or a document). */

/** A square PNG of about `target` pixels: whole pixels per module, a 4-module quiet zone, no smoothing. Drawn straight on a canvas (no image loading). */
export function qrPngBlob(link: string, target = 1024): Promise<Blob> {
  const m = qrMatrix(link);
  const n = m.length + 8;
  const scale = Math.max(1, Math.floor(target / n));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = n * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Canvas is not available"));
  ctx.fillStyle = QR_LIGHT; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = QR_DARK;
  m.forEach((row, y) => row.forEach((on, x) => { if (on) ctx.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale); }));
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not make the image"))), "image/png"));
}

export const qrSvgBlob = (link: string) => new Blob([qrSvgMarkup(link)], { type: "image/svg+xml" });

/** Saves a blob through a temporary link click. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
