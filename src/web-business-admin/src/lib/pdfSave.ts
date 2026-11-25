import { ApiError } from "./api";
import { downloadBlob, openBlob } from "./printing";

/** Phones and tablets (iPadOS reports itself as a Mac with a touch screen): a file download is awkward there, a PDF tab is not. */
const isTouchDevice = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Saves a report PDF: a download on desktop, a new tab on phones / iOS (falls back to a download if the tab is blocked). */
export function savePdf(blob: Blob, filename: string) {
  if (isTouchDevice()) { try { openBlob(blob); return; } catch { /* pop-up blocked: download instead */ } }
  downloadBlob(blob, filename);
}

/** Friendly text for a failed PDF request. */
export const pdfError = (e: unknown) => !navigator.onLine || (e instanceof ApiError && e.status === 0) ? "You are offline. Reports need an internet connection."
  : e instanceof ApiError && e.status === 403 ? "Only the owner or a manager can download reports."
  : e instanceof ApiError && e.status === 422 ? "That date range is too long for a PDF (up to 366 days)."
  : "Could not create the PDF. Please try again.";
