import type { AppOut, EntryOut, LeadOut, UserOut } from "./api/types";

export interface PerfRow {
  user: UserOut;
  leads: number; won: number; lost: number; open: number;
  /** basis points, integer */
  conversionBps: number;
  applications: number; provisioned: number;
  /** paise, keyed "INR" (INR only: an old record with another code still counts as rupees) */
  pending: Record<string, number>; approved: Record<string, number>; paid: Record<string, number>;
}

/** Per-person performance from the lists the API already exposes (no dedicated endpoint exists). */
export function buildPerformance(users: UserOut[], leads: LeadOut[], apps: AppOut[], entries: EntryOut[]): PerfRow[] {
  return users.filter((u) => u.is_active).map((user) => {
    const mine = leads.filter((l) => l.owner_id === user.id);
    const won = mine.filter((l) => l.stage === "won").length;
    const lost = mine.filter((l) => l.stage === "lost").length;
    const myApps = apps.filter((a) => a.agent_id === user.id);
    const sum = (status: string) => {
      const out: Record<string, number> = {};
      for (const e of entries) if (e.user_id === user.id && e.status === status) out.INR = (out.INR ?? 0) + e.amount_minor;
      return out;
    };
    return {
      user, leads: mine.length, won, lost, open: mine.length - won - lost,
      conversionBps: mine.length ? Math.floor((won * 10000) / mine.length) : 0,
      applications: myApps.length, provisioned: myApps.filter((a) => a.status === "provisioned").length,
      pending: sum("pending"), approved: sum("approved"), paid: sum("paid"),
    };
  });
}
