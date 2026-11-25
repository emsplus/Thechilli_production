import { ApiError, apiRequest } from "./api";

/**
 * End of day report email (pos-service docs/EMAIL.md, Manage > Restaurant > "Daily report email").
 * Read: reports.view. Change settings and "Send now": settings.owner (owner). Opt in / out: reports.view (the caller only;
 * owners always receive it while the switch is on).
 */
export interface DailyReportSettings {
  daily_report_email: boolean;
  daily_report_time: string; // "HH:MM", each outlet's local time
  daily_report_on_close: boolean;
  email_available: boolean; // mail is set up on the server
  subscribed: boolean; // the caller receives it
  recipients: string[];
}
export type DailyReportStatus = "queued" | "sent" | "failed" | "skipped" | string;
export interface DailyReportRow {
  id: string; outlet_id: string; business_date: string; trigger: "schedule" | "z_close" | "manual" | string; status: DailyReportStatus;
  attempts: number; recipients: number; error?: string | null; sent_at?: string | null; created_at?: string;
}
export type DailyReportPatch = Partial<Pick<DailyReportSettings, "daily_report_email" | "daily_report_time" | "daily_report_on_close">>;

const BASE = "/restaurant/daily-report";
export const dailyReportApi = {
  get: () => apiRequest<DailyReportSettings>(BASE),
  save: (b: DailyReportPatch) => apiRequest<DailyReportSettings>(BASE, { method: "PUT", body: JSON.stringify(b) }),
  subscribe: (subscribed: boolean) => apiRequest<DailyReportSettings>(`${BASE}/subscription`, { method: "PUT", body: JSON.stringify({ subscribed }) }),
  history: (limit = 30) => apiRequest<DailyReportRow[]>(`${BASE}/history?limit=${limit}`),
  send: (b: { outlet_id?: string; date?: string; resend?: boolean } = {}) => apiRequest<DailyReportRow>(`${BASE}/send`, { method: "POST", body: JSON.stringify(b) }),
};

/** "23:00" style, 24 h (the server's rule). */
export const isHHMM = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
/** "23:00" -> "11:00 pm" for the hint next to the time field. */
export function timeLabel(hhmm: string): string {
  if (!isHHMM(hhmm)) return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

export const TRIGGER_LABEL: Record<string, string> = { schedule: "Scheduled", z_close: "Day closed", manual: "Sent by hand" };
export const triggerLabel = (t: string) => TRIGGER_LABEL[t] ?? t;

export const STATUS_LABEL: Record<string, string> = { queued: "Sending", sent: "Sent", failed: "Failed", skipped: "Skipped" };
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;
export const statusTone = (s: string): "success" | "danger" | "warning" | "neutral" => (s === "sent" ? "success" : s === "failed" ? "danger" : s === "queued" ? "warning" : "neutral");

/** Why a day was skipped, in plain words (the server stores short reasons). */
export function skipReason(err: string | null | undefined): string | null {
  if (!err) return null;
  if (/no activity/i.test(err)) return "No sales that day";
  if (/no recipients/i.test(err)) return "Nobody to send it to";
  if (/switched off/i.test(err)) return "The email was switched off";
  return err;
}

/**
 * "Send now" answers with the day's row. It is idempotent per outlet and day: when the day was already sent the old row comes back
 * unchanged, which we recognise by a `sent_at` before the click. Then the screen offers "Send again" (resend: true).
 */
export function alreadySent(row: DailyReportRow, clickedAtMs: number): boolean {
  if (row.status !== "sent" || !row.sent_at) return false;
  const t = Date.parse(row.sent_at);
  return Number.isFinite(t) && t < clickedAtMs - 2000;
}

/** A server without these routes (pos-service before phase4/mail): hide the section instead of showing an error. */
export const dailyReportMissing = (e: unknown) => e instanceof ApiError && (e.status === 405 || e.status === 501 || (e.status === 404 && /^not found\.?$/i.test(e.message.trim())));
