/** Client-side photo prep for menu items: validate, downscale and re-encode before upload (saves bandwidth on slow links). */

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** Originals above this are refused outright (decoding them could freeze a cheap tablet); smaller ones are shrunk below PHOTO_MAX_BYTES. */
const ORIGINAL_MAX_BYTES = 25 * 1024 * 1024;
const MAX_EDGE = 1600;
const QUALITY = 0.85;

export class PhotoError extends Error {}

export interface PreparedPhoto { blob: Blob; name: string; width: number; height: number; originalBytes: number }

export const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function decode(file: File): Promise<{ src: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { src: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { src: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Validates the file (type, size) and returns an upload-ready blob: the original when it is already small, otherwise a
 * JPEG with the longest edge <= 1600 px at quality 0.85 (transparent PNGs are flattened onto white).
 * Throws PhotoError with a message fit for a toast.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!PHOTO_TYPES.includes(file.type)) throw new PhotoError("Use a JPG, PNG or WebP photo.");
  if (file.size > ORIGINAL_MAX_BYTES) throw new PhotoError(`That photo is ${mb(file.size)}. Choose one under 25 MB.`);
  let img;
  try { img = await decode(file); } catch { throw new PhotoError("We could not read that image. Try another photo."); }
  try {
    const { width, height } = img;
    if (!width || !height) throw new PhotoError("We could not read that image. Try another photo.");
    if (width <= MAX_EDGE && height <= MAX_EDGE && file.size <= 1024 * 1024) return { blob: file, name: file.name || "photo", width, height, originalBytes: file.size };
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoError("Your browser could not process that photo.");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img.src, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", QUALITY));
    if (!blob) throw new PhotoError("Your browser could not process that photo.");
    if (blob.size > PHOTO_MAX_BYTES) throw new PhotoError(`That photo is still ${mb(blob.size)} after shrinking. Choose a simpler one (max 5 MB).`);
    return { blob, name: (file.name || "photo").replace(/\.\w+$/, "") + ".jpg", width: w, height: h, originalBytes: file.size };
  } finally { img.close(); }
}

/** Friendly message for the image endpoint's error codes. */
export function uploadMessage(status: number, fallback: string): string {
  if (status === 413) return "That photo is too large. The limit is 5 MB.";
  if (status === 415) return "That file type is not supported. Use a JPG, PNG or WebP photo.";
  if (status === 422) return "That does not look like a valid photo. Try another one.";
  if (status === 0) return "Could not reach the server. Check the connection and try again; the item itself is saved.";
  return fallback;
}

/* --------------------------------------------------------------------------- invoice scans */
const SCAN_MAX_EDGE = 2000; // matches the server's OCR downscale: small print stays legible
const SCAN_QUALITY = 0.85;

export interface ScanPage { blob: Blob; name: string; /** false when the browser could not decode it (e.g. HEIC on desktop): sent as-is. */ shrunk: boolean }

/** Pixel size and EXIF orientation from a JPEG header (first 256 KB), without decoding the image. null if not a JPEG. */
export async function jpegInfo(file: Blob): Promise<{ width: number; height: number; orientation: number } | null> {
  const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let orientation = 1, off = 2;
  while (off + 4 <= v.byteLength) {
    if (v.getUint8(off) !== 0xff) { off++; continue; }
    const marker = v.getUint8(off + 1);
    if (marker === 0xff) { off++; continue; }
    const len = v.getUint16(off + 2);
    if (marker === 0xe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966) { // "Exif"
      const t = off + 10, le = v.getUint16(t) === 0x4949;
      if (t + 8 <= v.byteLength) {
        const ifd = t + v.getUint32(t + 4, le);
        const n = ifd + 2 <= v.byteLength ? v.getUint16(ifd, le) : 0;
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 10 > v.byteLength) break;
          if (v.getUint16(e, le) === 0x0112) { orientation = v.getUint16(e + 8, le); break; }
        }
      }
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (off + 9 > v.byteLength) return null;
      return { height: v.getUint16(off + 5), width: v.getUint16(off + 7), orientation };
    }
    off += 2 + len;
  }
  return null;
}

/**
 * Decodes straight to the target size when the browser supports it, so a 12-50 MP phone photo never sits in memory at
 * full resolution (that is what crashes / reloads the tab on low-memory phones). Falls back to a full decode.
 */
async function decodeScaled(file: File, maxEdge: number) {
  const info = file.type === "image/jpeg" || !file.type ? await jpegInfo(file).catch(() => null) : null;
  if (info && typeof createImageBitmap === "function") {
    const turned = info.orientation >= 5 && info.orientation <= 8;
    const w = turned ? info.height : info.width, h = turned ? info.width : info.height;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    if (scale < 1) {
      const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: "from-image", resizeWidth: tw, resizeHeight: th, resizeQuality: "high" });
        // Only trust it when it came out exactly as asked (a browser that resizes before rotating would squash the page).
        if (bmp.width === tw && bmp.height === th) return { src: bmp as CanvasImageSource, width: bmp.width, height: bmp.height, close: () => bmp.close(), downscaled: true };
        bmp.close();
      } catch { /* resize options unsupported: full decode below */ }
    }
  }
  return { ...(await decode(file)), downscaled: false };
}

/**
 * One photographed invoice page -> an upload-ready JPEG (longest edge <= 2000 px, quality 0.85, EXIF-uprighted), so a
 * 12 MP phone photo (4-6 MB) goes up as ~0.5 MB on mobile data. Never throws: if the browser cannot decode the file
 * (HEIC on a desktop browser, a damaged file) the original is returned and the server explains what is wrong.
 */
export async function prepareScanPage(file: File): Promise<ScanPage> {
  const original: ScanPage = { blob: file, name: file.name || "page.jpg", shrunk: false };
  if (file.size > ORIGINAL_MAX_BYTES) return original;
  let img;
  try { img = await decodeScaled(file, SCAN_MAX_EDGE); } catch { return original; }
  try {
    const { width, height } = img;
    if (!width || !height) return original;
    const scale = Math.min(1, SCAN_MAX_EDGE / Math.max(width, height));
    if (scale === 1 && !img.downscaled && file.type === "image/jpeg" && file.size <= 1024 * 1024) return { ...original, shrunk: true };
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img.src, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", SCAN_QUALITY));
    if (!blob) return original;
    if (scale === 1 && !img.downscaled && blob.size >= file.size && file.type === "image/jpeg") return { ...original, shrunk: true }; // already compact
    return { blob, name: (file.name || "page").replace(/\.\w+$/, "") + ".jpg", shrunk: true };
  } catch { return original; }
  finally { img.close(); }
}
