"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Mail, RotateCcw } from "lucide-react";
import { Badge, Button, Notice, Select, Switch } from "@chilli/ui";
import { Card, CardHeader, EmptyState, Skeleton, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import type { EmailSettings, SupplierEmail } from "@/lib/types";
import { useLoader } from "@/lib/useLoader";

const WINDOWS = [0, 1, 3, 6, 12, 24, 48, 72];
const windowLabel = (h: number) => (h === 0 ? "No gap" : h === 1 ? "1 hour" : h === 24 ? "1 day" : h === 48 ? "2 days" : h === 72 ? "3 days" : `${h} hours`);

/** The restaurant-wide switch for automatic re-order emails, and how long to wait before emailing the same supplier again. */
export function EmailSettingsCard({ onLoaded }: { onLoaded?: (s: EmailSettings) => void }) {
  const [s, setS] = useState<EmailSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.emailSettings().then((x) => { setS(x); onLoaded?.(x); }).catch((e) => setErr(e instanceof ApiError ? e.message : "Could not load the email settings")); }, [onLoaded]);
  async function save(b: { auto_reorder_emails?: boolean; reorder_email_window_hours?: number }) {
    setSaving(true); setErr(null);
    try { const x = await api.saveEmailSettings(b); setS(x); onLoaded?.(x); toast.success("Email settings saved"); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not save"); } finally { setSaving(false); }
  }
  if (!s && !err) return <Skeleton className="mb-4 h-28 rounded-xl" />;
  return (
    <Card className="mb-4">
      <CardHeader title="Re-order emails" description="When an item runs low, its usual supplier gets one short email asking to re-order." />
      {err && <div className="mb-3"><Notice tone="danger">{err}</Notice></div>}
      {s && !s.configured && <div className="mb-3"><Notice tone="warning" title="Email is not set up">Nothing is sent until the mailbox is configured on the server (see the runbook). You can still prepare supplier emails and settings.</Notice></div>}
      {s && (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-end">
          <Switch label="Email suppliers automatically when stock is low" hint="Needs a usual supplier with an email on the item. Each supplier can also be switched off." checked={s.auto_enabled} disabled={saving}
            onChange={(e) => void save({ auto_reorder_emails: e.target.checked })} />
          <Select label="At most one email per supplier every" value={String(s.window_hours)} disabled={saving} onChange={(e) => void save({ reorder_email_window_hours: Number(e.target.value) })}>
            {[...new Set([...WINDOWS, s.window_hours])].sort((a, b) => a - b).map((h) => <option key={h} value={h}>{windowLabel(h)}</option>)}
          </Select>
        </div>
      )}
    </Card>
  );
}

const statusBadge = (e: SupplierEmail) => e.status === "sent" ? <Badge tone="success">{<CheckCircle2 />}Sent</Badge>
  : e.status === "failed" ? <Badge tone="danger">{<AlertTriangle />}Failed</Badge> : <Badge tone="warning">{<Clock />}Sending</Badge>;

/** History of every re-order email (automatic and manual) with its outcome; failed ones can be sent again. */
export function SentEmails({ supplierId, refreshKey = 0 }: { supplierId?: string; refreshKey?: number }) {
  const fetcher = useCallback(() => api.supplierEmails(supplierId), [supplierId]);
  const { data, error, loading, reload } = useLoader(fetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const waiting = !!data?.some((e) => e.status === "queued");
  useEffect(() => { if (refreshKey) void reload(); }, [refreshKey, reload]);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void reload(), 3000); // a queued email is being sent right now: show the result
    return () => clearInterval(t);
  }, [waiting, reload]);

  async function resend(e: SupplierEmail) {
    setBusy(e.id);
    try { await api.resendSupplierEmail(e.id); toast.success("Sending again"); await reload(); }
    catch (x) { toast.error(x instanceof ApiError ? x.message : "Could not resend"); } finally { setBusy(null); }
  }

  return (
    <section aria-label="Sent emails" className="mt-6">
      <h3 className="mb-2 font-display text-base font-semibold text-fg">Sent emails</h3>
      {error && <div className="mb-3"><Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void reload()}>Retry</Button>}>{error}</Notice></div>}
      {loading ? <Skeleton className="h-20 rounded-xl" /> : !data?.length ? (
        <Card><EmptyState compact icon={<Mail />} title="No emails yet" hint="Automatic and manual re-order emails to your suppliers are listed here." /></Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {data.map((e) => (
              <li key={e.id} className="px-4 py-3" data-testid="sent-email">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-fg">{e.subject}</p>
                    <p className="truncate text-xs text-fg-subtle">{e.supplier_name ?? "Supplier"} · {e.to_email} · {formatDateTime(e.sent_at ?? e.created_at)}</p>
                  </div>
                  <Badge tone="neutral">{e.kind === "auto" ? "Automatic" : "Manual"}</Badge>
                  {statusBadge(e)}
                  {e.status === "failed" && <Button size="sm" variant="secondary" iconStart={<RotateCcw />} loading={busy === e.id} onClick={() => void resend(e)}>Resend</Button>}
                </div>
                {e.status === "failed" && e.error && <p className="mt-1 text-xs text-danger-fg">{e.error} (tried {e.attempts} time{e.attempts === 1 ? "" : "s"})</p>}
                <details className="mt-1">
                  <summary className="inline-flex min-h-8 cursor-pointer items-center text-xs font-medium text-primary-soft-fg">{e.items.length} item{e.items.length === 1 ? "" : "s"} · show email</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2/60 p-3 font-sans text-xs leading-relaxed text-fg-muted">{e.body_text}</pre>
                </details>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
