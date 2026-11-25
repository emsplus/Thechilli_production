/**
 * Growth maths over platform-core's own figures (GET /analytics/overview per window, application totals per status/source).
 * Pure functions so the page stays thin and the rules are tested. Nothing here invents data: when platform-core has no
 * history (MRR), there is no trend.
 */
import type { OnboardingSource, OnboardingStatus } from "./api/types";

export const SOURCES: OnboardingSource[] = ["self_signup", "marketing", "staff"];
export const SOURCE_LABEL: Record<OnboardingSource, string> = { self_signup: "Self signup", marketing: "Partner (marketing)", staff: "Chilli staff" };

/** Calendar months ending with the month of `now` (UTC dates, as platform-core buckets signups by UTC month). */
export function lastMonths(n: number, now = new Date()): { month: string; since: string; until: string }[] {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const until = last > today ? today : last;
    out.push({ month: first.toISOString().slice(0, 7), since: first.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) });
  }
  return out;
}

/** The window of the last `months` calendar months (inclusive of the current one) and the equally long window before it. */
export function windows(months: number, now = new Date()) {
  const m = lastMonths(months * 2, now);
  return { current: { since: m[months].since, until: m[m.length - 1].until }, previous: { since: m[0].since, until: m[months - 1].until } };
}

/** Change in percent, or undefined when there is no base to compare with (never "+∞%"). */
export function pctChange(cur: number, prev: number): number | undefined {
  if (prev <= 0) return undefined;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

export type StatusCounts = Partial<Record<OnboardingStatus, number>>;
/**
 * Applications to live business: provisioned / decided. Decided = provisioned + rejected + failed; applications still in the
 * queue (received, under review, approved, provisioning) are neither a win nor a loss yet, so they are left out of the rate.
 */
export function conversion(c: StatusCounts): { decided: number; won: number; open: number; rateBps: number | null } {
  const won = c.provisioned ?? 0;
  const decided = won + (c.rejected ?? 0) + (c.failed ?? 0);
  const open = (c.received ?? 0) + (c.under_review ?? 0) + (c.approved ?? 0) + (c.provisioning ?? 0);
  return { decided, won, open, rateBps: decided ? Math.round((won * 10000) / decided) : null };
}

export const FUNNEL: { label: string; statuses: OnboardingStatus[] }[] = [
  { label: "Waiting for review", statuses: ["received"] },
  { label: "Under review", statuses: ["under_review"] },
  { label: "Approved, being set up", statuses: ["approved", "provisioning"] },
  { label: "Live business", statuses: ["provisioned"] },
  { label: "Rejected or failed", statuses: ["rejected", "failed"] },
];
