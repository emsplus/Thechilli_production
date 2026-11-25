"use client";

import { ViewHeader } from "@/components/ui/view-header";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Clock, Download, Pencil, Plus } from "lucide-react";
import { Badge, Button, Checkbox, Dialog, IconButton, Input, Notice, Select, Skeleton, Textarea } from "@chilli/ui";
import { Card, EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { addDays, formatDate, todayIn } from "@/lib/datetime";
import { extras, type AttendanceRecord, type AttendanceReport, type Schedule, type ScheduleDay } from "@/lib/extras";
import { hoursText, localInputValue, reasonOk, sortRecords, timeIn } from "@/lib/frontdesk";
import { WEEKDAYS } from "@/lib/menuAdmin";
import { downloadBlob } from "@/lib/printing";
import { useTaxConfig } from "@/lib/taxConfig";
import { useNotify } from "@/lib/useNotify";
import { useCan } from "@/lib/useRole";
import type { StaffMember } from "@/lib/types";

const msg = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);
const STATUS_TONE = { present: "success", late: "warning", absent: "danger", pending: "neutral", off: "neutral" } as const;

/**
 * Settings > Attendance (owner / manager): who is clocked in now, the records with edit (reason required, audited) and void,
 * expected start times per person (drive Late / Absent), and the hours report with a CSV download. Everyone clocks themselves
 * in and out from the header ("Clock in/out").
 */
export function AttendanceView({ embedded = false }: { embedded?: boolean }) {
  const { can, ready } = useCan();
  const tz = useTaxConfig()?.timezone ?? "Asia/Kolkata";
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const allowed = ready && can("attendance.manage");
  useEffect(() => { if (allowed) api.staff().then((s) => setStaff(s.filter((x) => x.is_active))).catch(() => setStaff([])); }, [allowed]);

  if (ready && !allowed) return <><ViewHeader embedded={embedded} title="Attendance" /><Card><EmptyState icon={<Clock />} title="Attendance is managed by the owner or a manager" hint="Use Clock in/out at the top of the screen to record your own hours." /></Card></>;
  return (
    <>
      <ViewHeader embedded={embedded} title="Attendance" description="Staff clock in and out from the top bar. Here you see who is in, fix mistakes (with a reason) and download the hours." />
      <Tabs defaultValue="now">
        <TabsList>
          <TabsTrigger value="now">In now</TabsTrigger>
          <TabsTrigger value="records">Records</TabsTrigger>
          <TabsTrigger value="schedules">Shifts</TabsTrigger>
          <TabsTrigger value="report">Report</TabsTrigger>
        </TabsList>
        <TabsContent value="now"><NowTab tz={tz} /></TabsContent>
        <TabsContent value="records"><RecordsTab tz={tz} staff={staff} /></TabsContent>
        <TabsContent value="schedules"><SchedulesTab staff={staff} /></TabsContent>
        <TabsContent value="report"><ReportTab tz={tz} /></TabsContent>
      </Tabs>
    </>
  );
}

function NowTab({ tz }: { tz: string }) {
  const [list, setList] = useState<AttendanceRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => extras.attendanceCurrent().then((l) => { setList(l); setErr(null); }).catch((e) => { setErr(msg(e, "Could not load")); setList([]); }), []);
  useEffect(() => { void Promise.resolve().then(load); const t = setInterval(() => { if (!document.hidden) void load(); }, 60_000); return () => clearInterval(t); }, [load]);
  if (!list) return <Skeleton className="h-32 rounded-2xl" />;
  return (
    <Card data-testid="clocked-in">
      {err && <Notice tone="danger" className="mb-3">{err}</Notice>}
      {list.length === 0 ? <EmptyState icon={<Clock />} title="Nobody is clocked in" hint="Staff use Clock in/out at the top of the screen when their shift starts." /> : (
        <ul className="divide-y divide-border">
          {list.map((r) => (
            <li key={r.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
              <span className="font-semibold text-fg">{r.user_name}</span>
              <span className="tnum text-sm text-fg-muted">since {timeIn(r.clock_in_at, tz)} · {hoursText(r.worked_minutes)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecordsTab({ tz, staff }: { tz: string; staff: StaffMember[] }) {
  const toast = useNotify();
  const [to, setTo] = useState("");
  const [from, setFrom] = useState("");
  const [list, setList] = useState<AttendanceRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ rec: AttendanceRecord | null } | null>(null);
  const [voidFor, setVoidFor] = useState<AttendanceRecord | null>(null);
  useEffect(() => { if (!to) { const t = todayIn(tz); void Promise.resolve().then(() => { setTo(t); setFrom(addDays(t, -6)); }); } }, [to, tz]);
  const load = useCallback(() => { if (!from || !to) return; extras.attendanceRecords({ from_date: from, to_date: to }).then((l) => { setList(sortRecords(l)); setErr(null); }).catch((e) => { setErr(msg(e, "Could not load the records")); setList([]); }); }, [from, to]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="w-44"><Input label="From" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></div>
        <div className="w-44"><Input label="To" type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></div>
        <Button className="ml-auto" variant="primary" iconStart={<Plus />} onClick={() => setEdit({ rec: null })}>Add record</Button>
      </div>
      {err && <Notice tone="danger" className="mb-3">{err}</Notice>}
      {!list ? <Skeleton className="h-40 rounded-2xl" /> : list.length === 0 ? <Card><EmptyState icon={<Clock />} title="No records in these dates" /></Card> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[36rem] text-sm" data-testid="attendance-records">
            <caption className="sr-only">Attendance records</caption>
            <thead><tr className="border-b border-border text-left text-fg-muted"><th className="px-4 py-2 font-medium">Staff</th><th className="px-2 py-2 font-medium">Date</th><th className="px-2 py-2 font-medium">In</th><th className="px-2 py-2 font-medium">Out</th><th className="px-2 py-2 text-right font-medium">Hours</th><th className="px-4 py-2 text-right font-medium">Actions</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-b border-border/70 last:border-0">
                  <td className="px-4 py-1.5 font-semibold text-fg">{r.user_name}{r.source === "manager" && <span className="ml-1.5"><Badge>Added by manager</Badge></span>}{r.edited_at && <span className="block text-xs font-normal text-fg-subtle" title={r.edit_reason ?? ""}>Edited: {r.edit_reason}</span>}</td>
                  <td className="tnum px-2 py-1.5">{formatDate(r.work_date)}</td>
                  <td className="tnum px-2 py-1.5">{timeIn(r.clock_in_at, tz)}</td>
                  <td className="tnum px-2 py-1.5">{r.open ? <Badge tone="success">In now</Badge> : timeIn(r.clock_out_at, tz)}</td>
                  <td className="tnum px-2 py-1.5 text-right">{hoursText(r.worked_minutes)}</td>
                  <td className="px-4 py-1.5"><div className="flex justify-end gap-1"><IconButton label={`Edit ${r.user_name} ${formatDate(r.work_date)}`} icon={<Pencil />} onClick={() => setEdit({ rec: r })} /><IconButton label={`Void ${r.user_name} ${formatDate(r.work_date)}`} icon={<Ban />} onClick={() => setVoidFor(r)} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <RecordDialog state={edit} staff={staff} tz={tz} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); toast.success("Attendance saved"); }} />
      <VoidDialog rec={voidFor} onClose={() => setVoidFor(null)} onDone={() => { setVoidFor(null); load(); toast.success("Record voided"); }} />
    </>
  );
}

function RecordDialog({ state, staff, tz, onClose, onSaved }: { state: { rec: AttendanceRecord | null } | null; staff: StaffMember[]; tz: string; onClose: () => void; onSaved: () => void }) {
  const rec = state?.rec ?? null;
  const [user, setUser] = useState("");
  const [inAt, setIn] = useState("");
  const [outAt, setOut] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<typeof state>(null);
  if (state !== seen) { setSeen(state); if (state) { setUser(rec?.user_id ?? ""); setIn(localInputValue(rec?.clock_in_at ?? null, tz)); setOut(localInputValue(rec?.clock_out_at ?? null, tz)); setReason(""); setErr(null); } }
  async function save() {
    if (!rec && !user) { setErr("Choose the staff member"); return; }
    if (!inAt) { setErr("Enter the clock-in time"); return; }
    if (outAt && outAt <= inAt) { setErr("Clock-out must be after clock-in"); return; }
    if (!reasonOk(reason)) { setErr("Write a reason (at least 3 characters): it is kept in the audit log"); return; }
    setBusy(true); setErr(null);
    try {
      const body = { clock_in_at: `${inAt}:00`, clock_out_at: outAt ? `${outAt}:00` : null, reason: reason.trim() };
      if (rec) await extras.editAttendance(rec.id, body); else await extras.createAttendance({ user_id: user, ...body });
      onSaved();
    } catch (e) { setErr(e instanceof ApiError && e.code === "attendance_overlap" ? "This overlaps another record of the same person." : msg(e, "Could not save")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={state !== null} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title={rec ? `Edit ${rec.user_name}, ${formatDate(rec.work_date)}` : "Add attendance record"} description="Times are in the restaurant's time zone. Every change needs a reason."
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-3 pb-3">
        {err && <Notice tone="danger">{err}</Notice>}
        {!rec && <Select label="Staff member" value={user} onChange={(e) => setUser(e.target.value)}><option value="">Choose</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</Select>}
        <Input label="Clock in" type="datetime-local" value={inAt} onChange={(e) => setIn(e.target.value)} />
        <Input label="Clock out" type="datetime-local" hint="Empty = still clocked in" value={outAt} onChange={(e) => setOut(e.target.value)} />
        <Textarea label="Reason" rows={2} maxLength={300} placeholder="Forgot to clock out" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}

function VoidDialog({ rec, onClose, onDone }: { rec: AttendanceRecord | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!rec) return;
    if (!reasonOk(reason)) { setErr("Write a reason (at least 3 characters)"); return; }
    setBusy(true); setErr(null);
    try { await extras.voidAttendance(rec.id, reason.trim()); setReason(""); onDone(); } catch (e) { setErr(msg(e, "Could not void")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={rec !== null} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title={rec ? `Void ${rec.user_name}'s record?` : "Void record"} description="A voided record leaves the hours and the report. It stays in the audit log."
      footer={<><Button onClick={onClose} disabled={busy}>Keep</Button><Button variant="danger-soft" loading={busy} onClick={() => void go()}>Void record</Button></>}>
      <div className="space-y-3 pb-3">{err && <Notice tone="danger">{err}</Notice>}<Textarea label="Reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Dialog>
  );
}

function SchedulesTab({ staff }: { staff: StaffMember[] }) {
  const toast = useNotify();
  const [list, setList] = useState<Schedule[] | null>(null);
  const [edit, setEdit] = useState<StaffMember | null>(null);
  const load = useCallback(() => extras.schedules().then(setList).catch(() => setList([])), []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  const byUser = useMemo(() => new Map((list ?? []).map((s) => [s.user_id, s])), [list]);
  if (!list) return <Skeleton className="h-40 rounded-2xl" />;
  const text = (s?: Schedule) => {
    if (!s || !s.days.length) return "No shift set: never marked late or absent";
    const first = s.days[0];
    const same = s.days.every((d) => d.start_time === first.start_time && d.end_time === first.end_time);
    return same ? `${s.days.map((d) => WEEKDAYS[d.weekday]).join(", ")} · ${first.start_time.slice(0, 5)}–${first.end_time.slice(0, 5)} · ${first.grace_minutes} min grace` : `${s.days.length} days set`;
  };
  return (
    <Card className="p-0">
      <ul className="divide-y divide-border" data-testid="schedules">
        {staff.map((u) => (
          <li key={u.id} className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
            <span className="min-w-0"><span className="block font-semibold text-fg">{u.full_name}</span><span className="block text-sm text-fg-muted">{text(byUser.get(u.id))}</span></span>
            <Button onClick={() => setEdit(u)} aria-label={`Set shift for ${u.full_name}`}>Set shift</Button>
          </li>
        ))}
      </ul>
      <ScheduleDialog user={edit} current={edit ? byUser.get(edit.id) : undefined} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); toast.success("Shift saved"); }} />
    </Card>
  );
}

function ScheduleDialog({ user, current, onClose, onSaved }: { user: StaffMember | null; current?: Schedule; onClose: () => void; onSaved: () => void }) {
  const [days, setDays] = useState<number[]>([]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");
  const [grace, setGrace] = useState("10");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<StaffMember | null>(null);
  if (user !== seen) {
    setSeen(user);
    if (user) { const d = current?.days ?? []; setDays(d.length ? d.map((x) => x.weekday) : [0, 1, 2, 3, 4, 5]); setStart(d[0]?.start_time.slice(0, 5) ?? "09:00"); setEnd(d[0]?.end_time.slice(0, 5) ?? "17:00"); setGrace(String(d[0]?.grace_minutes ?? 10)); setErr(null); }
  }
  async function save() {
    if (!user) return;
    if (days.length && start === end) { setErr("Start and end cannot be the same"); return; }
    setBusy(true); setErr(null);
    try {
      const out: ScheduleDay[] = [...days].sort().map((w) => ({ weekday: w, start_time: start, end_time: end, grace_minutes: Math.max(0, Number(grace) || 0) }));
      await extras.saveSchedule(user.id, out); onSaved();
    } catch (e) { setErr(msg(e, "Could not save the shift")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={user !== null} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title={user ? `Shift for ${user.full_name}` : "Shift"} description="Expected start and end. Clocking in after start + grace counts as late; no clock-in by the end counts as absent."
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Save shift</Button></>}>
      <div className="space-y-3 pb-3">
        {err && <Notice tone="danger">{err}</Notice>}
        <fieldset><legend className="mb-1 text-sm font-semibold text-fg">Working days</legend>
          <div className="grid grid-cols-4 gap-x-2 sm:grid-cols-7">{WEEKDAYS.map((d, i) => <Checkbox key={d} label={d} checked={days.includes(i)} onChange={() => setDays((x) => (x.includes(i) ? x.filter((y) => y !== i) : [...x, i]))} />)}</div>
        </fieldset>
        <div className="grid grid-cols-3 gap-3">
          <Input label="Start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <Input label="End" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          <Input label="Grace (min)" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value.replace(/\D/g, "").slice(0, 3))} />
        </div>
        <p className="text-xs text-fg-muted">No day ticked = no shift (the person is never late or absent).</p>
      </div>
    </Dialog>
  );
}

function ReportTab({ tz }: { tz: string }) {
  const toast = useNotify();
  const [to, setTo] = useState("");
  const [from, setFrom] = useState("");
  const [r, setR] = useState<AttendanceReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!to) { const t = todayIn(tz); void Promise.resolve().then(() => { setTo(t); setFrom(addDays(t, -6)); }); } }, [to, tz]);
  useEffect(() => { if (from && to) extras.attendanceReport(from, to).then((x) => { setR(x); setErr(null); }).catch((e) => setErr(msg(e, "Could not load the report"))); }, [from, to]);
  async function csv() {
    try { downloadBlob(await extras.attendanceCsv(from, to), `attendance_${from}_${to}.csv`); } catch (e) { toast.error(msg(e, "Could not download")); }
  }
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="w-44"><Input label="From" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></div>
        <div className="w-44"><Input label="To" type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></div>
        <Button className="ml-auto" iconStart={<Download />} disabled={!from} onClick={() => void csv()}>Download CSV</Button>
      </div>
      {err && <Notice tone="danger" className="mb-3">{err}</Notice>}
      {!r ? <Skeleton className="h-40 rounded-2xl" /> : r.users.length === 0 ? <Card><EmptyState icon={<Clock />} title="No hours in these dates" hint="Records and shifts appear here once staff clock in." /></Card> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[34rem] text-sm" data-testid="attendance-report">
            <caption className="sr-only">Hours by staff member</caption>
            <thead><tr className="border-b border-border text-left text-fg-muted"><th className="px-4 py-2 font-medium">Staff</th><th className="px-2 py-2 text-right font-medium">Hours</th><th className="px-2 py-2 text-right font-medium">Present</th><th className="px-2 py-2 text-right font-medium">Late</th><th className="px-4 py-2 text-right font-medium">Absent</th></tr></thead>
            <tbody>
              {r.users.map((u) => (
                <tr key={u.user_id} className="border-b border-border/70 last:border-0">
                  <td className="px-4 py-2 font-semibold text-fg">{u.user_name}</td>
                  <td className="tnum px-2 py-2 text-right">{hoursText(u.worked_minutes)}</td>
                  <td className="tnum px-2 py-2 text-right">{u.days_present}</td>
                  <td className="tnum px-2 py-2 text-right">{u.days_late ? <Badge tone={STATUS_TONE.late}>{u.days_late} · {u.late_minutes} min</Badge> : 0}</td>
                  <td className="tnum px-4 py-2 text-right">{u.days_absent ? <Badge tone={STATUS_TONE.absent}>{u.days_absent}</Badge> : 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
