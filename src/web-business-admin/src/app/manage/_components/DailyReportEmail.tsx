"use client";

import { useCallback, useEffect, useState } from "react";
import { History, Mail, Send } from "lucide-react";
import { Badge, Button, Input, Notice, Switch } from "@chilli/ui";
import { Card, CardHeader, EmptyState, Skeleton, toast } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { alreadySent, dailyReportApi, dailyReportMissing, isHHMM, skipReason, statusLabel, statusTone, timeLabel, triggerLabel, type DailyReportPatch, type DailyReportRow, type DailyReportSettings } from "@/lib/dailyReport";

const msg = (e: unknown, fallback: string) => (e instanceof ApiError && e.status !== 0 ? e.message : e instanceof ApiError ? "Cannot reach the server. Try again when you are online." : fallback);

function HistoryList({ rows, error, onRetry }: { rows: DailyReportRow[] | null; error: string | null; onRetry: () => void }) {
  return (
    <Card padded={false} data-testid="daily-report-history">
      <div className="p-4 pb-0 sm:p-5 sm:pb-0"><CardHeader title="Sent reports" description="The last 30 days, newest first." className="mb-3" /></div>
      {error ? <div className="px-4 pb-4 sm:px-5"><Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>}>{error}</Notice></div>
        : rows === null ? <div className="px-4 pb-4 sm:px-5"><Skeleton className="h-24 rounded-xl" /></div>
        : rows.length === 0 ? <EmptyState compact icon={<History />} title="Nothing sent yet" hint="Each day's report is listed here once it is sent." />
        : (
          <ul className="divide-y divide-border border-t border-border">
            {rows.map((r) => {
              const why = r.status === "skipped" || r.status === "failed" ? skipReason(r.error) : r.error ?? null;
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5" data-testid="daily-report-row">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-fg">{formatDate(`${r.business_date}T12:00:00Z`)}</p>
                    <p className="text-xs text-fg-subtle">{triggerLabel(r.trigger)}{r.sent_at ? ` · ${formatDateTime(r.sent_at)}` : ""}{r.recipients ? ` · ${r.recipients} ${r.recipients === 1 ? "person" : "people"}` : ""}</p>
                    {why && <p className={`text-xs ${r.status === "failed" ? "text-danger-fg" : "text-fg-muted"}`}>{why}{r.status === "failed" ? ` (tried ${r.attempts} time${r.attempts === 1 ? "" : "s"})` : ""}</p>}
                  </div>
                  <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                </li>
              );
            })}
          </ul>
        )}
    </Card>
  );
}

/**
 * Manage > Restaurant > Daily report email (pos-service docs/EMAIL.md "End of day report email"): the switch, the send time (each
 * outlet's local time), "also send when the day is closed", who receives it, "Send now" and the history.
 * Viewing needs reports.view; changing the settings and "Send now" need settings.owner (`canEdit`). Non-owners can opt themselves
 * in or out (owners always receive it while the switch is on).
 */
export function DailyReportEmail({ canEdit }: { canEdit: boolean }) {
  const [s, setS] = useState<DailyReportSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [time, setTime] = useState("");
  const [rows, setRows] = useState<DailyReportRow[] | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [again, setAgain] = useState<DailyReportRow | null>(null);

  const loadHistory = useCallback(async () => {
    setHistErr(null);
    try { setRows(await dailyReportApi.history(30)); } catch (e) { setHistErr(msg(e, "Could not load the history")); }
  }, []);
  const load = useCallback(async () => {
    setErr(null);
    try { const x = await dailyReportApi.get(); setS(x); setTime(x.daily_report_time); void loadHistory(); }
    catch (e) { if (dailyReportMissing(e)) setMissing(true); else setErr(msg(e, "Could not load the daily report settings")); }
  }, [loadHistory]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function save(b: DailyReportPatch) {
    setSaving(true); setErr(null);
    try { const x = await dailyReportApi.save(b); setS(x); setTime(x.daily_report_time); toast.success("Daily report settings saved"); }
    catch (e) { setErr(msg(e, "Could not save")); if (s) setTime(s.daily_report_time); }
    finally { setSaving(false); }
  }
  async function subscribe(on: boolean) {
    setSaving(true); setErr(null);
    try { setS(await dailyReportApi.subscribe(on)); toast.success(on ? "You will get the daily report" : "You will no longer get the daily report"); }
    catch (e) { setErr(msg(e, "Could not save")); } finally { setSaving(false); }
  }
  async function send(resend = false) {
    const clicked = Date.now();
    setSending(true); setAgain(null);
    try {
      const row = await dailyReportApi.send(resend ? { resend: true } : {});
      if (!resend && alreadySent(row, clicked)) setAgain(row);
      else if (row.status === "sent") toast.success("Report sent", { description: `To ${row.recipients} ${row.recipients === 1 ? "person" : "people"}` });
      else if (row.status === "queued") toast.message("Report is being sent");
      else if (row.status === "skipped") toast.message("Nothing to send", { description: skipReason(row.error) ?? undefined });
      else toast.error("The report could not be sent", { description: row.error ?? undefined });
      void loadHistory();
    } catch (e) { toast.error(msg(e, "Could not send the report")); }
    finally { setSending(false); }
  }

  if (missing) return <Card><EmptyState compact icon={<Mail />} title="Not available on this server" hint="The daily report email needs a newer server." /></Card>;
  if (!s) return err ? <Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{err}</Notice> : <Skeleton className="h-48 rounded-2xl" />;

  const off = !s.daily_report_email;
  const timeOk = isHHMM(time);
  return (
    <div className="space-y-4" data-testid="daily-report-email">
      <Card>
        <CardHeader title="Daily report email" description="Each evening the owners (and anyone who opts in) get the day's sales, payments, GST, top items, voids and cash difference, with the report PDF attached." />
        <div className="space-y-4">
          {!s.email_available && <Notice tone="warning" title="Email is not set up">Nothing is sent until the mailbox is configured on the server. You can still choose the settings.</Notice>}
          {err && <Notice tone="danger">{err}</Notice>}
          {!canEdit && <p className="text-sm text-fg-muted">Only the owner can change these settings.</p>}
          <Switch label="Email the end of day report" checked={s.daily_report_email} disabled={!canEdit || saving}
            onChange={(e) => void save({ daily_report_email: e.target.checked })} />
          <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-start">
            <Input label="Send at" type="time" step={60} value={time} disabled={!canEdit || saving || off}
              hint={timeOk ? `${timeLabel(time)}, each outlet's local time` : undefined} error={time && !timeOk ? "Use a time like 23:00" : undefined}
              onChange={(e) => setTime(e.target.value.slice(0, 5))}
              onBlur={() => { if (timeOk && time !== s.daily_report_time) void save({ daily_report_time: time }); }} />
            <div className="sm:pt-7">
              <Switch label="Also send when the day is closed (Z report)" hint="Whichever comes first sends; the day is never sent twice."
                checked={s.daily_report_on_close} disabled={!canEdit || saving || off} onChange={(e) => void save({ daily_report_on_close: e.target.checked })} />
            </div>
          </div>
        </div>
      </Card>

      <Card data-testid="daily-report-recipients">
        <CardHeader title="Who gets it" description="Every active owner, plus staff who opt in." />
        {s.recipients.length ? (
          <ul className="flex flex-wrap gap-2">{s.recipients.map((r) => <li key={r}><Badge tone="neutral"><Mail />{r}</Badge></li>)}</ul>
        ) : <p className="text-sm text-fg-muted">Nobody yet.</p>}
        {!canEdit && (
          <div className="mt-4">
            <Switch label="Send it to me too" checked={s.subscribed} disabled={saving} onChange={(e) => void subscribe(e.target.checked)} />
          </div>
        )}
        {canEdit && (
          <div className="mt-4 space-y-2">
            <Button variant="secondary" iconStart={<Send />} loading={sending} disabled={off || !s.email_available} onClick={() => void send()}>Send today&apos;s report now</Button>
            {(off || !s.email_available) && <p className="text-xs text-fg-subtle">{off ? "Switch the email on to send it." : "Email is not set up on this server."}</p>}
            {again && (
              <Notice tone="info" action={<Button size="sm" variant="secondary" loading={sending} onClick={() => void send(true)}>Send again</Button>}>
                Today&apos;s report was already sent{again.sent_at ? ` at ${formatDateTime(again.sent_at)}` : ""}.
              </Notice>
            )}
          </div>
        )}
      </Card>

      <HistoryList rows={rows} error={histErr} onRetry={() => void loadHistory()} />
    </div>
  );
}
