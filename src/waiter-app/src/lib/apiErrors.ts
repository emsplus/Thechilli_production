/** What the waiter reads when an API call fails. Pure (tested in apiErrors.test.ts); lib/api.ts builds ApiError messages with it. */
export const SESSION_EXPIRED_MSG = "Session expired, sign in again";
export const INVALID_DETAILS_MSG = "Some details are not valid. Check them and try again.";

/**
 * Plain text for a failed response. `body` is the parsed JSON body (or undefined).
 *  - 401 (after the app already tried to refresh the session): the server's bare "Not authenticated" means the session is gone;
 *    say that, in words the waiter knows from the sign-in screen (D25 of docs/testing/BREAK_UI_REPORT.md);
 *  - a plain-text `detail` is shown as the server wrote it;
 *  - a validation list (422, pydantic) or any other structure is never printed as JSON: a short fixed sentence instead.
 */
export function apiErrorMessage(status: number, body: unknown, statusText = ""): string {
  if (status === 401) return SESSION_EXPIRED_MSG;
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) return INVALID_DETAILS_MSG;
  if (detail && typeof detail === "object") {
    const m = (detail as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  if (body && typeof body === "object") {
    const m = (body as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  return statusText || (status >= 500 ? "The server had a problem. Try again in a moment." : "Something went wrong. Try again.");
}

export const isSessionExpiredMessage = (m: string | null | undefined): boolean => m === SESSION_EXPIRED_MSG;
