"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Armchair, CalendarClock, ChevronLeft, ChevronRight, MessageCircle, Phone, Plus, Users } from "lucide-react";
import { Badge, Button, Dialog, IconButton, Input, Notice, PageHeader, Select, Sheet, Skeleton, Textarea } from "@chilli/ui";
import { Card, EmptyState } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { addDays, todayIn } from "@/lib/datetime";
import { extras, type Availability, type CommsSettings, type Reservation } from "@/lib/extras";
import { availabilityText, bookingProblem, dayLabel, daySummary, localStart, partyProblem, STATUS_TEXT, timeIn } from "@/lib/frontdesk";
import { useCurrency, useTaxConfig } from "@/lib/taxConfig";
import { useNotify } from "@/lib/useNotify";
import { usePoll } from "@/lib/usePoll";
import { formatCurrency } from "@/lib/money";
import type { TableStatus } from "@/lib/extras";
import { useCan } from "@/lib/useRole";
import { uuid } from "@/lib/uuid";
import type { DiningTable } from "@/lib/types";

const TONE: Record<Reservation["status"], "info" | "success" | "neutral" | "warning"> = { booked: "info", seated: "success", cancelled: "neutral", no_show: "warning" };
const msg = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

/**
 * Manage > Operations > Reservations (its own URL, drawn inside the Manage frame): the day's bookings (earliest first), new booking with a live availability hint, and the front-desk
 * actions: Seat (creates or attaches the table's order and opens it at the counter), Cancel, No-show and a WhatsApp reminder.
 * Nothing here touches the counter flow unless a booking is seated.
 */
export default function ReservationsPage() {
  const router = useRouter();
  const { can, has, ready } = useCan();
  const toast = useNotify();
  const tz = useTaxConfig()?.timezone ?? "Asia/Kolkata";
  const [date, setDate] = useState("");
  const [list, setList] = useState<Reservation[] | null>(null);
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [comms, setComms] = useState<CommsSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [seatFor, setSeatFor] = useState<Reservation | null>(null);
  const [cancelFor, setCancelFor] = useState<Reservation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const offered = has("reservations"); // business type (a cloud kitchen has no reservations)
  const allowed = ready && offered && can("reservations.manage");

  useEffect(() => { if (!date) void Promise.resolve().then(() => setDate(todayIn(tz))); }, [date, tz]);
  const load = useCallback(async () => {
    if (!date) return;
    try { setList(await extras.reservations(date)); setError(null); }
    catch (e) { setError(msg(e, "Could not load the reservations")); setList([]); }
  }, [date]);
  useEffect(() => { if (allowed) void Promise.resolve().then(load); }, [allowed, load]);
  useEffect(() => {
    if (!allowed) return;
    api.tables().then(setTables).catch(() => setTables([]));
    extras.comms().then(setComms).catch(() => setComms(null));
  }, [allowed]);

  // Tables in use right now. A waiter "booking" a table in the waiter app opens an order on it (it is not a reservation), so the
  // front desk sees those here, next to the bookings; refreshed every 10 s while the tab is visible, like the bookings themselves.
  const floorOn = allowed && has("tables");
  const floor = usePoll(useCallback(() => (floorOn ? extras.tableStatus() : Promise.resolve([] as TableStatus[])), [floorOn]), floorOn ? 10_000 : 0);
  useEffect(() => {
    if (!allowed) return;
    const t = setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    return () => clearInterval(t);
  }, [allowed, load]);
  const inUse = (floor.data ?? []).filter((t) => (t.orders ?? []).length > 0);
  const inUseById = new Map(inUse.map((t) => [t.table_id, t]));
  const isToday = !!date && date === todayIn(tz);

  const waReady = !!comms?.whatsapp_enabled && !!comms?.whatsapp_available;
  const waWhy = !comms ? "WhatsApp settings could not be read." : !comms.whatsapp_available ? "WhatsApp is not set up on this server yet." : "WhatsApp messages are switched off for this restaurant (Settings > Business).";

  async function act(r: Reservation, what: "no_show" | "remind") {
    setBusy(r.id + what);
    try {
      if (what === "no_show") { await extras.noShowReservation(r.id); toast.success(`${r.guest_name} marked as no-show`); }
      else { await extras.remindReservation(r.id); toast.success(`Reminder queued on WhatsApp for ${r.guest_name}`); }
      void load();
    } catch (e) { toast.error(msg(e, "Could not update the booking")); } finally { setBusy(null); }
  }

  async function seat(r: Reservation, tableId: string | null) {
    setBusy(r.id + "seat");
    try {
      const done = await extras.seatReservation(r.id, tableId ? { table_id: tableId } : {});
      toast.success(`${r.guest_name} seated${done.table_label ? ` at ${done.table_label}` : ""}`);
      setSeatFor(null);
      if (done.order_id) router.push(`/pos?order=${done.order_id}`); else void load();
    } catch (e) { toast.error(msg(e, "Could not seat the guest")); } finally { setBusy(null); }
  }

  if (ready && !offered) return <><PageHeader title="Reservations" /><Card><EmptyState icon={<CalendarClock />} title="Reservations are not part of your business type" hint="They come with Restaurant. The owner can change the business type in Manage > Restaurant." /></Card></>;
  if (ready && !allowed) return <><PageHeader title="Reservations" /><Card><EmptyState icon={<CalendarClock />} title="Reservations are not available for your role" hint="Ask the owner to give your role the reservations permission." /></Card></>;

  const sorted = (list ?? []).slice().sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return (
    <>
      <PageHeader title="Reservations" description="Table bookings for the day. Seat a guest to open their table at the counter."
        actions={<Button variant="primary" iconStart={<Plus />} onClick={() => setCreating(true)} disabled={!date}>New reservation</Button>} />
      <div className="mb-4 flex flex-wrap items-end gap-2 [&_.ch-field]:mb-0">
        <IconButton label="Previous day" icon={<ChevronLeft />} onClick={() => setDate((d) => addDays(d, -1))} />
        <div className="w-44"><Input label="Date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></div>
        <IconButton label="Next day" icon={<ChevronRight />} onClick={() => setDate((d) => addDays(d, 1))} />
        {date && date !== todayIn(tz) && <Button variant="ghost" onClick={() => setDate(todayIn(tz))}>Today</Button>}
      </div>
      {list && <p role="status" className="-mt-2 mb-4 text-sm font-medium text-fg-muted" data-testid="day-summary">{dayLabel(date)} · {daySummary(list)}</p>}
      {error && <Notice tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Notice>}
      {isToday && floorOn && <TablesInUse rows={inUse} onOpen={(id) => router.push(`/pos?order=${id}`)} />}
      {!list ? (
        <div role="status" aria-label="Loading reservations" className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      ) : sorted.length === 0 ? (
        <Card><EmptyState icon={<CalendarClock />} title="No bookings for this day" hint="Add a reservation when a guest calls. Tables held for a booking show as Reserved an hour before."
          action={<Button variant="secondary" iconStart={<Plus />} onClick={() => setCreating(true)}>New reservation</Button>} /></Card>
      ) : (
        <ul className="space-y-3" data-testid="reservations">
          {sorted.map((r) => {
            // Owner approval 2026-11-03 (BREAK_UI_REPORT D22): a no-show / cancelled booking reads as inactive through explicit muted colours (grey card, grey time chip
            // and name, muted phone link), not opacity-75, which dropped the time chip, the badge and the phone link to 3.8:1.
            const off = r.status === "cancelled" || r.status === "no_show";
            return (
            <li key={r.id}>
              <Card className={off ? "bg-surface-2 shadow-none" : ""} data-inactive={off ? "" : undefined}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className={cn("tnum grid min-w-16 shrink-0 place-items-center whitespace-nowrap rounded-xl px-2 py-2 font-display text-base font-bold", off ? "bg-surface-3 text-fg-muted" : "bg-primary-soft text-primary-soft-fg")}>{timeIn(r.starts_at, tz)}</span>
                    <div className="min-w-0">
                      <h2 className={cn("flex flex-wrap items-center gap-2 font-display text-lg font-bold [overflow-wrap:anywhere]", off ? "text-fg-muted" : "text-fg")}><span className="min-w-0 [overflow-wrap:anywhere]">{r.guest_name}</span><Badge tone={TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge></h2>
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
                        <span className="inline-flex items-center gap-1"><Users aria-hidden className="size-4" />{r.party_size} {r.party_size === 1 ? "guest" : "guests"}</span>
                        <span className="inline-flex items-center gap-1"><Armchair aria-hidden className="size-4" />{r.table_label ? `Table ${r.table_label}` : "No table yet"}</span>
                        <a href={`tel:${r.phone}`} className={cn("inline-flex min-h-11 items-center gap-1 font-medium underline-offset-2 hover:underline", off ? "text-fg-muted underline" : "text-primary")}><Phone aria-hidden className="size-4" />{r.phone}</a>
                      </p>
                      {r.notes && <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{r.notes}</p>}
                      {r.status === "booked" && r.table_id && inUseById.has(r.table_id) && <p className="text-xs font-medium text-warning-fg" data-testid="table-in-use">Table {r.table_label} is in use now{whoOf(inUseById.get(r.table_id)!) ? ` (taken by ${whoOf(inUseById.get(r.table_id)!)})` : ""}. Seat adds the guests to that order.</p>}
                      {r.reminder_queued_at && <p className="text-xs text-fg-subtle">Reminder sent {timeIn(r.reminder_queued_at, tz)}</p>}
                      {r.cancel_reason && <p className="text-xs text-fg-subtle">Reason: {r.cancel_reason}</p>}
                    </div>
                  </div>
                  {r.status === "booked" && (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="primary" loading={busy === r.id + "seat"} onClick={() => (r.table_id ? void seat(r, null) : setSeatFor(r))}>Seat</Button>
                      <Button disabled={!waReady || busy === r.id + "remind"} title={waReady ? "Send a WhatsApp reminder" : waWhy} iconStart={<MessageCircle />} onClick={() => void act(r, "remind")}>Remind</Button>
                      <Button disabled={busy === r.id + "no_show"} onClick={() => void act(r, "no_show")}>No-show</Button>
                      <Button variant="danger-soft" onClick={() => setCancelFor(r)}>Cancel</Button>
                    </div>
                  )}
                  {r.status === "seated" && r.order_id && <Button onClick={() => router.push(`/pos?order=${r.order_id}`)}>Open at counter</Button>}
                </div>
                {r.status === "booked" && !waReady && <p className="mt-2 text-xs text-fg-subtle" data-testid="remind-why">Remind is off: {waWhy}</p>}
              </Card>
            </li>
            );
          })}
        </ul>
      )}
      <NewReservation open={creating} date={date} tables={tables} onClose={() => setCreating(false)} onSaved={(d) => { setCreating(false); if (d !== date) setDate(d); else void load(); }} />
      <SeatDialog r={seatFor} tables={tables} busy={!!busy} onClose={() => setSeatFor(null)} onSeat={(t) => seatFor && void seat(seatFor, t)} />
      <CancelDialog r={cancelFor} onClose={() => setCancelFor(null)} onDone={() => { setCancelFor(null); void load(); }} />
    </>
  );
}

const whoOf = (t: TableStatus) => [...new Set((t.orders ?? []).map((o) => o.waiter_name).filter(Boolean))].join(", ");

/** "Tables in use now": every table with an open order (taken at the counter or in the waiter app), who took it, and its bill state. */
function TablesInUse({ rows, onOpen }: { rows: TableStatus[]; onOpen: (orderId: string) => void }) {
  const currency = useCurrency();
  return (
    <section aria-labelledby="in-use-h" className="mb-5" data-testid="tables-in-use">
      <h2 id="in-use-h" className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-fg-muted"><Armchair aria-hidden className="size-4" />Tables in use now<span className="tnum normal-case tracking-normal">({rows.length})</span></h2>
      {rows.length === 0 ? <p className="text-sm text-fg-muted">No table has an open order. Tables taken in the waiter app show here.</p> : (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((t) => {
            const os = t.orders ?? [];
            const items = os.reduce((n, o) => n + (o.item_count ?? 0), 0);
            const total = os.reduce((n, o) => n + Number(o.total ?? o.subtotal ?? 0), 0);
            const asked = t.status === "bill_requested" || os.some((o) => !!o.bill_requested_at);
            const made = t.status === "bill_printed" || os.some((o) => !!o.bill_id);
            const who = whoOf(t);
            return (
              <li key={t.table_id}>
                <Card className={`flex items-center justify-between gap-3 ${asked && !made ? "ring-2 ring-warning" : ""}`} data-testid="table-in-use-row">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-fg">Table {t.label}
                      {made ? <Badge tone="neutral">Bill made</Badge> : asked ? <Badge tone="warning">Bill asked</Badge> : <Badge tone="info">Order open</Badge>}</p>
                    <p className="text-sm text-fg-muted">{[who ? `Taken by ${who}` : "", `${items} ${items === 1 ? "item" : "items"}`].filter(Boolean).join(" · ")} · <span className="ch-money" translate="no">{formatCurrency(total.toFixed(2), currency)}</span></p>
                  </div>
                  {!made && os[0] && <Button size="sm" onClick={() => onOpen(os[0].order_id)}>Open</Button>}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function NewReservation({ open, date, tables, onClose, onSaved }: { open: boolean; date: string; tables: DiningTable[]; onClose: () => void; onSaved: (date: string) => void }) {
  const toast = useNotify();
  const [f, setF] = useState({ guest: "", phone: "", party: "2", day: date, time: "19:30", duration: "90", table: "", notes: "" });
  const [avail, setAvail] = useState<Availability | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null); // one idempotency key per opened form (a retried save never books twice)
  const [seen, setSeen] = useState(false);
  if (open !== seen) { setSeen(open); if (open) { setKey(null); setF((x) => ({ ...x, guest: "", phone: "", party: "2", day: date, table: "", notes: "" })); setErr(null); setAvail(null); } }
  const up = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  // Live availability for the chosen time and party size (debounced).
  useEffect(() => {
    if (!open || !/^\d{2}:\d{2}$/.test(f.time) || partyProblem(f.party)) return;
    const t = setTimeout(() => {
      extras.availability({ starts_at: localStart(f.day, f.time), party_size: Number(f.party), duration_minutes: Number(f.duration) || 90 }).then(setAvail).catch(() => setAvail(null));
    }, 300);
    return () => clearTimeout(t);
  }, [open, f.day, f.time, f.party, f.duration]);
  const choices = useMemo(() => (avail?.tables ?? tables.map((t) => ({ id: t.id, label: t.label, seats: t.seats, fits: true, available: true }))), [avail, tables]);

  async function save() {
    const p = bookingProblem({ guest: f.guest, phone: f.phone, party: f.party, time: f.time });
    if (p) { setErr(p); return; }
    setBusy(true); setErr(null);
    const k = key ?? uuid();
    setKey(k);
    try {
      await extras.createReservation({ client_uuid: k, guest_name: f.guest.trim(), phone: f.phone.trim(), party_size: Number(f.party), starts_at: localStart(f.day, f.time),
        duration_minutes: Number(f.duration) || 90, table_id: f.table || null, notes: f.notes.trim() || null });
      toast.success(`Booked ${f.guest.trim()} for ${f.party} at ${f.time}`);
      onSaved(f.day);
    } catch (e) { setErr(e instanceof ApiError && e.code === "table_already_reserved" ? "That table is already booked at this time. Pick another table or no table." : msg(e, "Could not save the booking")); }
    finally { setBusy(false); }
  }

  return (
    <Sheet side="right" open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title="New reservation" description="The table is held from an hour before the booking. Leave the table empty to assign it on arrival."
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Book table</Button></>}>
      <form className="space-y-4 pb-3" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label="Guest name" autoComplete="off" maxLength={120} value={f.guest} onChange={(e) => up({ guest: e.target.value })} />
        <Input label="Mobile number" type="tel" inputMode="tel" placeholder="98765 43210" autoComplete="off" maxLength={30} value={f.phone} onChange={(e) => up({ phone: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Guests" inputMode="numeric" maxLength={6} value={f.party} error={f.party !== "" ? partyProblem(f.party) ?? undefined : undefined} onChange={(e) => up({ party: e.target.value })} />
          <Input label="Time" type="time" value={f.time} onChange={(e) => up({ time: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Date" type="date" value={f.day} onChange={(e) => e.target.value && up({ day: e.target.value })} />
          <Select label="Stay" value={f.duration} onChange={(e) => up({ duration: e.target.value })}>
            {["60", "90", "120", "150", "180"].map((m) => <option key={m} value={m}>{Number(m) / 60} h</option>)}
          </Select>
        </div>
        {avail && <p role="status" data-testid="availability" className={`rounded-xl px-3 py-2 text-sm font-medium ${avail.available_count > 0 ? "bg-success-soft text-success-fg" : "bg-warning-soft text-warning-fg"}`}>{availabilityText(avail)}</p>}
        <Select label="Table (optional)" value={f.table} onChange={(e) => up({ table: e.target.value })}>
          <option value="">Assign on arrival</option>
          {choices.map((t) => <option key={t.id} value={t.id} disabled={!t.available}>{t.label} · {t.seats} seats{!t.fits ? " (too small)" : !t.available ? " (booked)" : ""}</option>)}
        </Select>
        <Textarea label="Notes (optional)" rows={2} maxLength={500} placeholder="Birthday, window seat, high chair" value={f.notes} onChange={(e) => up({ notes: e.target.value })} />
      </form>
    </Sheet>
  );
}

function SeatDialog({ r, tables, busy, onClose, onSeat }: { r: Reservation | null; tables: DiningTable[]; busy: boolean; onClose: () => void; onSeat: (tableId: string) => void }) {
  const [t, setT] = useState("");
  const fits = tables.filter((x) => !r || x.seats >= r.party_size);
  return (
    <Dialog open={r !== null} onOpenChange={(o) => { if (!o) onClose(); }} title={r ? `Seat ${r.guest_name}` : "Seat guest"} description="Choose the table. Their order opens at the counter."
      footer={<><Button onClick={onClose}>Back</Button><Button variant="primary" loading={busy} disabled={!t} onClick={() => onSeat(t)}>Seat and open order</Button></>}>
      <div className="pb-3">
        <Select label="Table" value={t} onChange={(e) => setT(e.target.value)}>
          <option value="">Choose a table</option>
          {(fits.length ? fits : tables).map((x) => <option key={x.id} value={x.id}>{x.label} · {x.seats} seats</option>)}
        </Select>
      </div>
    </Dialog>
  );
}

function CancelDialog({ r, onClose, onDone }: { r: Reservation | null; onClose: () => void; onDone: () => void }) {
  const toast = useNotify();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!r) return;
    setBusy(true);
    try { await extras.cancelReservation(r.id, reason.trim() || null); toast.success(`Booking for ${r.guest_name} cancelled`); setReason(""); onDone(); }
    catch (e) { toast.error(msg(e, "Could not cancel the booking")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={r !== null} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title={r ? `Cancel ${r.guest_name}'s booking?` : "Cancel booking"} description="The table is freed straight away."
      footer={<><Button onClick={onClose} disabled={busy}>Keep booking</Button><Button variant="danger-soft" loading={busy} onClick={() => void go()}>Cancel booking</Button></>}>
      <div className="pb-3"><Textarea label="Reason (optional)" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Dialog>
  );
}
