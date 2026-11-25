import { z } from "zod";
import { ApiError } from "./api";

export const MIN_PASSWORD = 10;
export const newPasswordSchema = z.string().min(MIN_PASSWORD, `At least ${MIN_PASSWORD} characters`);

/** Own password change: current + new twice. */
export const pwSchema = z.object({
  current: z.string().min(1, "Enter your current password"),
  next: newPasswordSchema,
  again: z.string(),
}).refine((v) => v.next === v.again, { path: ["again"], message: "The two passwords do not match" });

/** Reset by emailed link: new twice. */
export const resetSchema = z.object({ next: newPasswordSchema, again: z.string() }).refine((v) => v.next === v.again, { path: ["again"], message: "The two passwords do not match" });

export const emailSchema = z.object({ email: z.string().trim().email("Enter a valid email address") });

/** A server without the email reset routes (phase2/comms not deployed) answers 404 / 405 / 501. */
export const resetUnsupported = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);

/** `hi` when the browser prefers Hindi, so the emailed message is in the user's language (the server falls back to English). */
export const preferredLocale = (): string | undefined => {
  try { return /^hi\b/i.test(navigator.language) ? "hi" : undefined; } catch { return undefined; }
};

/** Reads the reset link: restaurant id from `?r=`, token from the fragment `#t=` (kept out of server logs). */
export function readResetLink(search: string, hash: string): { restaurantId: string | null; token: string | null } {
  const r = new URLSearchParams(search).get("r");
  const t = new URLSearchParams(hash.replace(/^#/, "")).get("t");
  return { restaurantId: r && r.trim() ? r.trim() : null, token: t && t.trim() ? t.trim() : null };
}
