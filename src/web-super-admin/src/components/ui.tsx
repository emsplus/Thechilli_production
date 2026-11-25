"use client";
import { useId, useState, type ReactNode } from "react";
import { Badge, Button, Dialog, EmptyState, ErrorState, Skeleton, SkeletonGroup, type BadgeTone } from "@chilli/ui";
import { ApiError } from "@/lib/api";
import type { Resource } from "@/lib/useResource";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="hq-pagehead">
      <div>
        <h1 className="hq-h1">{title}</h1>
        {subtitle ? <p className="hq-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="hq-actions">{actions}</div> : null}
    </header>
  );
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <SkeletonGroup>
      <div className="hq-skel">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} height={36} />)}</div>
    </SkeletonGroup>
  );
}

/** 503s that mean "this source is not connected yet", not "something broke": say so instead of "try again". */
const UNAVAILABLE: Record<string, string> = {
  marketing_unavailable: "Marketing data is not connected yet: platform-core needs MARKETING_SERVICE_URL and its read token before this page can show the team, referrals and commissions.",
};
export const errText = (e: ApiError) =>
  e.code === "insecure_transport" || e.code === "step_up_required" || e.code === "step_up_cancelled" ? e.message : e.isForbidden ? "Your role does not include this area." : e.status === 0 ? "Cannot reach the server. Check your connection."
    : UNAVAILABLE[e.code] ?? (e.status >= 500 ? "The server had a problem. Try again in a moment." : e.message);

/** One place that renders the loading, error and empty states of a page (P14: every state offers a next action). */
export function ResourceView<T>({ res, isEmpty, empty, children }: {
  res: Resource<T>; isEmpty?: (d: T) => boolean;
  empty: { title: string; description?: string; actionLabel?: string; onAction?: () => void };
  children: (d: T) => ReactNode;
}) {
  if (res.error && res.data === undefined) return <ErrorState title="Could not load this page" description={errText(res.error)} onAction={res.reload} />;
  if (res.data === undefined) return <LoadingRows />;
  if (isEmpty?.(res.data)) return <EmptyState {...empty} />;
  return (
    <>
      {res.error ? <InlineError error={res.error} /> : null}
      {children(res.data)}
    </>
  );
}

export function InlineError({ error }: { error: ApiError | undefined }) {
  if (!error) return null;
  const detail = error.details?.length ? ` (${error.details.map((d) => `${d.loc[d.loc.length - 1]}: ${d.msg}`).join("; ")})` : "";
  const wait = error.retryAfterSeconds ? ` Try again in ${Math.ceil(error.retryAfterSeconds / 60)} min.` : "";
  return <p className="hq-inline-error" role="alert">{errText(error)}{detail}{wait}</p>;
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warning"; title?: string; children: ReactNode }) {
  return (
    <div className={`hq-notice hq-notice--${tone}`} role="note">
      {title ? <strong>{title}</strong> : null} <span>{children}</span>
    </div>
  );
}

export function Pager({ page, onOffset }: { page: { total: number; limit: number; offset: number }; onOffset: (o: number) => void }) {
  if (page.total <= page.limit) return <p className="hq-count">{page.total} {page.total === 1 ? "result" : "results"}</p>;
  const from = page.offset + 1, to = Math.min(page.offset + page.limit, page.total);
  return (
    <nav className="hq-pager" aria-label="Pagination">
      <span className="hq-count">{from}-{to} of {page.total}</span>
      <Button size="sm" disabled={page.offset === 0} onClick={() => onOffset(Math.max(0, page.offset - page.limit))}>Previous</Button>
      <Button size="sm" disabled={to >= page.total} onClick={() => onOffset(page.offset + page.limit)}>Next</Button>
    </nav>
  );
}

const TONES: Record<string, BadgeTone> = {
  active: "success", paid: "success", succeeded: "success", provisioned: "success", resolved: "success", ok: "success", healthy: "success", info: "info", trialing: "info", issued: "info", received: "info", open: "info", initiated: "info", approved: "info", provisioning: "info",
  pending: "warning", under_review: "warning", past_due: "warning", in_progress: "warning", waiting: "warning", draft: "neutral", warn: "warning", degraded: "warning", high: "warning", diagnostics: "warning",
  suspended: "danger", failed: "danger", rejected: "danger", critical: "danger", urgent: "danger", error: "danger", stale: "danger",
  closed: "neutral", cancelled: "neutral", expired: "neutral", void: "neutral", refunded: "neutral", low: "neutral", normal: "neutral", inactive: "neutral", read_only: "neutral",
};
export const StatusBadge = ({ value }: { value: string }) => <Badge tone={TONES[value] ?? "neutral"}>{statusLabel(value)}</Badge>;
/** "past_due" -> "Past due": status codes shown as words. */
export function statusLabel(v: string): string { const t = v.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); }

export function DefList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="hq-deflist">
      {items.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v ?? "–"}</dd></div>
      ))}
    </dl>
  );
}

export function TextArea({ label, value, onChange, hint, error, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; hint?: string; error?: string; rows?: number }) {
  const id = useId();
  return (
    <div className="ch-field">
      <label className="ch-label" htmlFor={id}>{label}</label>
      <textarea id={id} className="ch-input hq-textarea" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : hint ? `${id}-h` : undefined} />
      {hint && !error ? <p className="ch-hint" id={`${id}-h`}>{hint}</p> : null}
      {error ? <p className="ch-error" id={`${id}-e`} role="alert">{error}</p> : null}
    </div>
  );
}

/**
 * Confirmation that always asks for a reason (suspend, close, void, reject...). The destructive button is never the primary
 * style. `onConfirm` returns an error message to keep the dialog open, or undefined on success.
 */
export function ReasonDialog({ open, onOpenChange, title, description, confirmLabel, minLength = 3, onConfirm, extra, safe, askReason = true }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; confirmLabel: string; minLength?: number; safe?: boolean;
  /** false: plain confirmation, for platform-core routes that take no reason (asking for one we cannot record would mislead). */
  askReason?: boolean;
  onConfirm: (reason: string) => Promise<ApiError | undefined | void>; extra?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [touched, setTouched] = useState(false);
  const short = askReason && reason.trim().length < minLength;
  const close = (o: boolean) => { if (!o) { setReason(""); setError(undefined); setTouched(false); } onOpenChange(o); };
  const submit = async () => {
    setTouched(true);
    if (short) return;
    setBusy(true); setError(undefined);
    const e = await onConfirm(reason.trim());
    setBusy(false);
    if (e) setError(e); else close(false);
  };
  return (
    <Dialog open={open} onOpenChange={close} title={title} description={description}
      footer={<><Button onClick={() => close(false)}>Cancel</Button><Button variant={safe ? "primary" : "danger-soft"} loading={busy} onClick={submit}>{confirmLabel}</Button></>}>
      {extra}
      {askReason ? <TextArea label="Reason" value={reason} onChange={setReason} hint="Recorded in the audit log." error={touched && short ? `Give a reason of at least ${minLength} characters.` : undefined} /> : null}
      <InlineError error={error} />
    </Dialog>
  );
}
