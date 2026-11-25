/**
 * How long a kitchen ticket has waited, and how worried to be about it. One policy for every screen that colours a waiting
 * ticket (kitchen board, Today), so "late" means the same thing everywhere (UI_REVIEW BA-13):
 *   ok   below the target                 neutral, no colour
 *   warn from the target ("getting late") amber chip, thin amber accent
 *   late from twice the target            red chip, thin red accent
 * Only tickets still being worked (new / preparing) can be late; ready, served and cancelled ones never are.
 * KOT-only kitchen (the default, lib/kitchenStatusMode): nobody in the kitchen clicks anything, so there is no "being worked" state and
 * no late warning at all (tickets clear themselves by age, lib/kitchenStatusMode splitTickets).
 */

/** Default ticket target. The live value is a setting (Manage > Restaurant > Kitchen): lib/kitchenTarget.ts, docs/KITCHEN_TARGET.md. */
export const KITCHEN_TARGET_MIN = 15;

export type WaitState = "ok" | "warn" | "late";

/** Badge / tile tone for each state. */
export const WAIT_TONE: Record<WaitState, "neutral" | "warning" | "danger"> = { ok: "neutral", warn: "warning", late: "danger" };

/** Whole minutes since `since` (epoch ms or ISO text); null when the time is missing or unreadable. Never negative. */
export function minutesSince(since: number | string | null | undefined, now: number): number | null {
  if (since === null || since === undefined || since === "") return null;
  const t = typeof since === "number" ? since : Date.parse(since);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 60_000));
}

/** ok below the target, warn from the target, late from twice the target. */
export function waitState(minutes: number, targetMin = KITCHEN_TARGET_MIN): WaitState {
  return minutes >= 2 * targetMin ? "late" : minutes >= targetMin ? "warn" : "ok";
}

/** Is a ticket in this status still being worked (so it can run late)? Never in KOT-only mode. */
export const isWorking = (status: string, mode: "kot_only" | "track" = "track") =>
  mode === "track" && (status === "pending" || status === "preparing");

/** State of one ticket: its wait, or "ok" when it is no longer being worked or has no usable time. */
export function ticketWaitState(status: string, since: number | string | null | undefined, now: number, targetMin = KITCHEN_TARGET_MIN, mode: "kot_only" | "track" = "track"): WaitState {
  if (!isWorking(status, mode)) return "ok";
  const m = minutesSince(since, now);
  return m === null ? "ok" : waitState(m, targetMin);
}

/** Human wait: "0 min", "12 min", "1 h", "4 h 25 min". */
export function formatWait(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Tickets being worked that are getting late (warn) or late, for summary tiles. */
export function waitCounts(kots: { status: string; created_at?: string | null; done_at?: string | null }[], now: number, targetMin = KITCHEN_TARGET_MIN, mode: "kot_only" | "track" = "track"): { warn: number; late: number } {
  const out = { warn: 0, late: 0 };
  for (const k of kots) {
    const s = ticketWaitState(k.status, k.created_at, now, targetMin, mode);
    if (s !== "ok") out[s] += 1;
  }
  return out;
}
