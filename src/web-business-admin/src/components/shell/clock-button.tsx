"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, CloudOff } from "lucide-react";
import { Badge, Button, Dialog, IconButton, Notice } from "@chilli/ui";
import { ApiError, auth } from "@/lib/api";
import { extras, type MyAttendance } from "@/lib/extras";
import { hoursText, timeIn } from "@/lib/frontdesk";
import { formatDate } from "@/lib/datetime";
import { setShared, useSharedQuery } from "@/lib/query";
import { useTaxConfig } from "@/lib/taxConfig";
import { useCan } from "@/lib/useRole";
import { useNotify } from "@/lib/useNotify";
import { cn } from "@/lib/cn";
import { effectiveState, flushOps, nextOp, readQueue, useClockQueue, writeQueue, type ClockOp, type SendResult } from "@/lib/clockQueue";
import { uuid } from "@/lib/uuid";

const key = () => `attendance:me:${(auth.token ?? "").slice(-12)}`;

/** One queued tap to the server. 409 / 404 / 422 are final (already done elsewhere, too old): drop; no connection: keep. */
async function sendOp(op: ClockOp): Promise<{ r: SendResult; err?: ApiError }> {
  try {
    const body = { ...(op.client_uuid ? { client_uuid: op.client_uuid } : {}), at: op.at, ...(op.device ? { device: op.device } : {}) };
    await (op.kind === "in" ? extras.clockIn(body) : extras.clockOut(body));
    return { r: "ok" };
  } catch (e) {
    if (!(e instanceof ApiError)) return { r: "retry" };
    if (e.status === 0) return { r: "offline" };
    if (e.status === 409 || e.status === 404 || e.status === 422) return { r: "final", err: e };
    return { r: "retry" };
  }
}

/**
 * Header item "Clock in/out" for every role holding attendance.clock: one request per session (shared, 5 min refresh), a dot
 * while clocked in, and a small dialog with the one button that matters. Never on the counter's order path.
 * Works offline: the tap is queued with its own client_uuid and the device time ("will sync"), and sent when the connection is back.
 */
export function ClockButton() {
  const { can, ready } = useCan();
  const allowed = ready && can("attendance.clock");
  const q = useSharedQuery<MyAttendance | null>(allowed ? key() : null, () => extras.myAttendance().catch((e) => { if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null; throw e; }), { staleMs: 60_000, refetchMs: 300_000 });
  const tz = useTaxConfig()?.timezone ?? "Asia/Kolkata";
  const toast = useNotify();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const user = auth.userId;
  const queue = useClockQueue(user);
  const flushing = useRef(false);
  const { refetch } = q;

  /** Sends what is queued (on load, when the connection returns, after a tap). */
  const flush = useCallback(async () => {
    if (!user || flushing.current || readQueue(user).length === 0) return;
    flushing.current = true;
    try {
      const fails: ApiError[] = [];
      const res = await flushOps(readQueue(user), async (op) => { const x = await sendOp(op); if (x.err) fails.push(x.err); return x.r; });
      // Ops queued while this flush ran stay after the ones still waiting.
      const now = readQueue(user);
      const done = res.sent.length + res.dropped.length;
      writeQueue(user, [...res.remaining, ...now.slice(done + res.remaining.length)]);
      if (res.sent.length) toast.success(res.sent.length === 1 ? "Clock time synced" : `${res.sent.length} clock times synced`);
      if (fails.length) toast.error(`A clock time from this device was not accepted: ${fails[0].message} Ask a manager to correct attendance if needed.`);
      if (done) void refetch().catch(() => {});
    } finally { flushing.current = false; }
  }, [user, toast, refetch]);

  useEffect(() => {
    if (!allowed) return;
    void Promise.resolve().then(flush);
    const on = () => void flush();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [allowed, flush]);

  if (!allowed || q.data === null) return null;
  const state = effectiveState(q.data?.open ?? null, queue);
  const server = q.data?.open ?? null;
  // While a tap waits to sync, the clock-in time is the device's; hours worked are shown once the server has the record.
  const cur: { clock_in_at: string; worked_minutes: number | null } | null = state.open ? (state.pending && state.since ? { clock_in_at: state.since, worked_minutes: null } : server) : null;

  function queueTap(op: ClockOp) {
    if (!user) return;
    writeQueue(user, [...readQueue(user), op]);
    toast.success(op.kind === "in" ? `Clocked in at ${timeIn(op.at, tz)}. Will sync when online.` : `Clocked out at ${timeIn(op.at, tz)}. Will sync when online.`);
    setOpen(false);
  }

  async function go() {
    setBusy(true); setErr(null);
    const device = typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 100) : undefined;
    const op = nextOp(state, new Date().toISOString(), uuid, device);
    try {
      // Something is already waiting, or no connection: queue behind it so the order of taps is kept.
      if (state.pending || (typeof navigator !== "undefined" && navigator.onLine === false)) { queueTap(op); return; }
      const body = { ...(op.client_uuid ? { client_uuid: op.client_uuid } : {}), ...(device ? { device } : {}) };
      const rec = op.kind === "out" ? await extras.clockOut(body) : await extras.clockIn(body);
      setShared(key(), { open: rec.open ? rec : null, records: q.data?.records ?? [] });
      toast.success(rec.open ? `Clocked in at ${timeIn(rec.clock_in_at, tz)}` : `Clocked out. Worked ${hoursText(rec.worked_minutes)}`);
      setOpen(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) queueTap(op); // lost the connection mid-tap: the server dedupes on client_uuid
      else if (e instanceof ApiError && (e.code === "already_clocked_in" || e.code === "not_clocked_in")) {
        void q.refetch().catch(() => {});
        setErr(e.code === "already_clocked_in" ? "You are already clocked in (maybe on another device). Updated: try Clock out." : "You were already clocked out. Updated.");
      } else setErr(e instanceof ApiError ? e.message : "Could not reach the server. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <>
      <span className="relative">
        <IconButton label="Clock in/out" icon={<Clock aria-hidden className="size-5" />} onClick={() => { setErr(null); setOpen(true); void q.refetch().catch(() => {}); void flush(); }} className={cn(cur && "text-success-fg")}
          aria-describedby={state.pending ? "clock-pending" : undefined} />
        {cur && <span aria-hidden className={cn("pointer-events-none absolute right-1.5 top-1.5 size-2.5 rounded-full ring-2 ring-surface", state.pending ? "bg-warning" : "bg-success")} />}
        {state.pending && <span id="clock-pending" className="sr-only">Clock time waiting to sync</span>}
      </span>
      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }} title="Clock in/out"
        description={cur ? `Clocked in since ${timeIn(cur.clock_in_at, tz)}${cur.worked_minutes === null ? "." : ` (${hoursText(cur.worked_minutes)} so far).`}` : "You are not clocked in."}
        footer={<><Button onClick={() => setOpen(false)} disabled={busy}>Close</Button><Button variant="primary" loading={busy} disabled={q.data === undefined && !q.error && !state.pending} onClick={() => void go()} data-testid="clock-action">{cur ? "Clock out" : "Clock in"}</Button></>}>
        <div className="space-y-2 pb-3">
          {state.pending && (
            <p data-testid="clock-will-sync" className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
              <Badge tone="warning"><CloudOff aria-hidden className="size-3.5" />Will sync</Badge>
              {queue.length === 1 ? "1 clock time" : `${queue.length} clock times`} saved on this device, sent when the connection is back.
            </p>
          )}
          {err && <Notice tone="danger">{err}</Notice>}
          {(q.data?.records ?? []).filter((r) => !r.open).slice(0, 3).map((r) => (
            <p key={r.id} className="flex justify-between text-sm text-fg-muted"><span>{formatDate(r.work_date)}</span><span className="tnum">{timeIn(r.clock_in_at, tz)} to {timeIn(r.clock_out_at, tz)} · {hoursText(r.worked_minutes)}</span></p>
          ))}
        </div>
      </Dialog>
    </>
  );
}
