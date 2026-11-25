"use client";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, auth } from "./api";
import { CLOSED, clockFailed, clockPending, clockTap, type ClockState } from "./attendanceCore";
export type { ClockState };
import { submit, useQueue } from "./sync";
import { uuid } from "./uuid";

/**
 * Clock in / out (pos-service docs/RESERVATIONS_ATTENDANCE_SETUP_API.md section 2). One tap, works offline: the tap is
 * recorded on the phone with the phone's time (`at`) and a `client_uuid`, and goes through the same offline queue as orders
 * (op_id idempotency; the server dedupes on client_uuid as well, so a resend never creates a second record).
 * The state shown is the server's when it could be read, else this phone's last tap.
 */
const KEY = "waiter.attendance";

export function readClock(): ClockState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as ClockState | null;
    if (!s || (s.user_id && auth.userId && s.user_id !== auth.userId)) return CLOSED; // another person signed in on this phone
    return s;
  } catch { return CLOSED; }
}
const writeClock = (s: ClockState) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } };

interface MeAttendance { open: { client_uuid: string | null; clock_in_at: string } | null }

export function useClock() {
  const ops = useQueue();
  const pending = clockPending(ops);
  const [state, setState] = useState<ClockState>(CLOSED);
  const [supported, setSupported] = useState(true);
  useEffect(() => { void Promise.resolve().then(() => setState(readClock())); }, []);
  // Server truth when online and nothing of ours is still queued (a queued tap is newer than what the server knows).
  useEffect(() => {
    if (pending) return;
    let live = true;
    api.attendanceMe().then((r: MeAttendance | null) => {
      if (!live) return;
      if (r === null) { setSupported(false); return; }
      const s: ClockState = r.open ? { open: true, since: r.open.clock_in_at, client_uuid: r.open.client_uuid, user_id: auth.userId } : { ...CLOSED, user_id: auth.userId };
      writeClock(s); setState(s);
    }).catch((e) => { if (e instanceof ApiError && e.status === 403) setSupported(false); });
    return () => { live = false; };
  }, [pending]);
  const tap = useCallback(async () => {
    const { state: next, item } = clockTap(readClock(), new Date(), uuid(), auth.userId);
    writeClock(next); setState(next);
    await submit([item]);
  }, []);
  return { state, pending, failed: clockFailed(ops), supported, tap };
}
