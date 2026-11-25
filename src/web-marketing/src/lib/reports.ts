import type { AppOut, DemoOut, EntryOut, LeadOut, LeadStage, UserOut } from "./api/types";
import { BOARD_STAGES, PIPELINE_STAGES } from "./pipeline";

/** Reports are computed from the lists the API already exposes (rows are already scoped to the caller by the server). */
export type PeriodKey = "all" | "30" | "90" | "365";
export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "all", label: "All time" }, { key: "30", label: "Last 30 days" }, { key: "90", label: "Last 90 days" }, { key: "365", label: "Last 12 months" },
];

export function inPeriod<T>(rows: T[], at: (r: T) => string, period: PeriodKey, now = Date.now()): T[] {
  if (period === "all") return rows;
  const from = now - Number(period) * 86_400_000;
  return rows.filter((r) => new Date(at(r)).getTime() >= from);
}

const bps = (num: number, den: number) => (den ? Math.floor((num * 10000) / den) : 0);

export interface FunnelRow { stage: LeadStage; atStage: number; reached: number; reachedBps: number }
/**
 * `reached` = leads now at this stage or further along (stage history is not stored). Lost leads are not counted as
 * reaching a stage because their furthest stage is unknown; they are returned separately.
 */
export function leadsFunnel(leads: LeadOut[]): { rows: FunnelRow[]; lost: number; total: number } {
  const order = [...PIPELINE_STAGES, "won" as LeadStage];
  const open = leads.filter((l) => l.stage !== "lost");
  const rows = order.map((stage, i) => ({
    stage,
    atStage: leads.filter((l) => l.stage === stage).length,
    reached: open.filter((l) => order.indexOf(l.stage) >= i).length,
    reachedBps: bps(open.filter((l) => order.indexOf(l.stage) >= i).length, leads.length),
  }));
  return { rows, lost: leads.length - open.length, total: leads.length };
}

export interface SourceRow { key: string; label: string; leads: number; won: number; lost: number; conversionBps: number }
function group(leads: LeadOut[], keyOf: (l: LeadOut) => string, label: (k: string) => string): SourceRow[] {
  const m = new Map<string, LeadOut[]>();
  for (const l of leads) { const k = keyOf(l); m.set(k, [...(m.get(k) ?? []), l]); }
  return [...m.entries()].map(([key, ls]) => {
    const won = ls.filter((l) => l.stage === "won").length;
    return { key, label: label(key), leads: ls.length, won, lost: ls.filter((l) => l.stage === "lost").length, conversionBps: bps(won, ls.length) };
  }).sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));
}
export const sourceLabel = (s: string) => (s ? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Unknown");
export const conversionBySource = (leads: LeadOut[]) => group(leads, (l) => l.source || "unknown", sourceLabel);
export function conversionBySalesperson(leads: LeadOut[], users: UserOut[]): SourceRow[] {
  const name = (id: string) => (id === "none" ? "Unassigned" : users.find((u) => u.id === id)?.name ?? "Former member");
  return group(leads, (l) => l.owner_id ?? "none", name);
}

export interface DemoSummary { scheduled: number; held: number; noShow: number; cancelled: number; total: number; heldBps: number }
/** Held = completed. Show rate = held / (held + no-show); cancelled and still-scheduled demos are not counted against it. */
export function demosSummary(demos: DemoOut[]): DemoSummary {
  const n = (s: DemoOut["status"]) => demos.filter((d) => d.status === s).length;
  const held = n("completed"), noShow = n("no_show");
  return { scheduled: n("scheduled"), held, noShow, cancelled: n("cancelled"), total: demos.length, heldBps: bps(held, held + noShow) };
}

export interface CycleRow { key: string; label: string; provisioned: number; open: number; avgDays: number | null; medianDays: number | null; fastestDays: number | null; slowestDays: number | null }
const DAY = 86_400_000;
const round1 = (x: number) => Math.round(x * 10) / 10;
/** Days from application created to provisioned, for provisioned applications only. */
export function onboardingCycle(apps: AppOut[]): CycleRow[] {
  const rows = (label: string, key: string, list: AppOut[]): CycleRow => {
    const days = list.filter((a) => a.status === "provisioned" && a.provisioned_at)
      .map((a) => Math.max(0, (new Date(a.provisioned_at!).getTime() - new Date(a.created_at).getTime()) / DAY)).sort((x, y) => x - y);
    const mid = Math.floor(days.length / 2);
    return {
      key, label, provisioned: days.length, open: list.filter((a) => a.status === "draft" || a.status === "in_progress" || a.status === "ready").length,
      avgDays: days.length ? round1(days.reduce((s, d) => s + d, 0) / days.length) : null,
      medianDays: days.length ? round1(days.length % 2 ? days[mid]! : (days[mid - 1]! + days[mid]!) / 2) : null,
      fastestDays: days.length ? round1(days[0]!) : null, slowestDays: days.length ? round1(days[days.length - 1]!) : null,
    };
  };
  return [rows("All applications", "all", apps), rows("Assisted", "assisted", apps.filter((a) => a.source === "assisted")), rows("Self-signup", "self_signup", apps.filter((a) => a.source === "self_signup"))];
}

export interface CommissionRow { currency: string; pending: number; earned: number; paid: number; owed: number }
/**
 * Earned = approved + paid, net of reversal rows (a reversal is a negative approved row). Pending is awaiting a decision and
 * rejected entries never count. Owed = earned - paid.
 */
export function commissionEarnedVsPaid(entries: EntryOut[]): CommissionRow[] {
  const m = new Map<string, CommissionRow>();
  for (const e of entries) {
    // INR only (docs/INR_ONLY.md): every amount is rupees, whatever code an old record carries, so there is one INR row.
    const r = m.get("INR") ?? { currency: "INR", pending: 0, earned: 0, paid: 0, owed: 0 };
    if (e.status === "pending") r.pending += e.amount_minor;
    if (e.status === "approved" || e.status === "paid") r.earned += e.amount_minor;
    if (e.status === "paid") r.paid += e.amount_minor;
    m.set("INR", r);
  }
  return [...m.values()].map((r) => ({ ...r, owed: r.earned - r.paid })).sort((a, b) => a.currency.localeCompare(b.currency));
}

export { BOARD_STAGES };
