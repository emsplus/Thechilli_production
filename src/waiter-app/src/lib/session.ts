/**
 * Outlet and shift.
 *
 * A shift belongs to ONE waiter at ONE outlet. The shift marker lives on this device (so the app works offline and the chosen
 * outlet is sent as X-Outlet-Id, see api.ts) and every open/close is also queued (`shift_open` / `shift_close`, idempotent op ids)
 * so the server learns about it when it can. What the UI may say is derived from the queue: see `shiftSyncState`.
 * Outlets come from GET /auth/me (`outlets` = the ones THIS user may reach, owner or not); the last answer is cached for offline.
 */
import { api, auth, ME_KEY } from "./api";
import { submit } from "./sync";
import type { Me, OutletInfo } from "./types";
import { uuid } from "./uuid";

export interface Outlet { id: string; name: string }
export interface Shift { id: string; outlet_id: string; outlet_name?: string; user_id?: string | null; restaurant_id?: string | null; started_at: string; source: "local" | "server" }

const KEY = "waiter.shift";
import { OUTLET_EVENT } from "./outletEvent";
export { OUTLET_EVENT };

export { shiftSyncState, type ShiftSyncState } from "./shiftState";

export function cachedMe(): Me | null {
  try { return JSON.parse(localStorage.getItem(ME_KEY) ?? "null") as Me | null; } catch { return null; }
}
const toOutlet = (o: OutletInfo): Outlet => ({ id: o.id, name: o.name });

export interface SessionGateway {
  /** Outlets this waiter may work in. Falls back to the last known list when offline. */
  listOutlets(): Promise<{ outlets: Outlet[]; fromCache: boolean }>;
  currentShift(): Shift | null;
  openShift(outletId: string, outletName?: string): Promise<Shift>;
  closeShift(): Promise<void>;
  /** Close the current shift and start one at another outlet (the old shift is closed only if the new outlet is reachable). */
  switchOutlet(outletId: string, outletName?: string): Promise<Shift>;
}

let rawCache: string | null = null, parsedCache: Shift | null = null;
function readShift(): Shift | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch { return null; }
  if (raw !== rawCache) { rawCache = raw; try { parsedCache = raw ? (JSON.parse(raw) as Shift) : null; } catch { parsedCache = null; } }
  const s = parsedCache;
  if (!s) return null;
  // Another waiter signed in on this device (or another restaurant): that shift is not theirs.
  const uid = auth.userId, rid = auth.restaurantId;
  if ((s.user_id && uid && s.user_id !== uid) || (s.restaurant_id && rid && s.restaurant_id !== rid)) return null;
  return s;
}
const writeShift = (s: Shift | null) => {
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* ignore */ }
  window.dispatchEvent(new Event(OUTLET_EVENT));
};

async function verifyOutlet(outletId: string): Promise<void> {
  try { await api.me(outletId); }
  catch (e) {
    const status = (e as { status?: number }).status;
    if (status !== 0) throw e; // 403: not allowed in that outlet
    // Offline: only outlets this waiter was already known to reach.
    if (!cachedMe()?.outlets?.some((o) => o.id === outletId)) throw new Error("offline-unknown-outlet");
  }
}

/** The server has no open shift for this waiter here any more (closed on another device or by a manager): forget the local marker. */
export function forgetShift() { writeShift(null); }

export const defaultSessionGateway: SessionGateway = {
  async listOutlets() {
    try { const m = await api.me(); return { outlets: (m.outlets ?? []).filter((o) => o.is_active !== false).map(toOutlet), fromCache: false }; }
    catch (e) {
      const c = cachedMe();
      if ((e as { status?: number }).status === 0 && c?.outlets) return { outlets: c.outlets.map(toOutlet), fromCache: true };
      throw e;
    }
  },
  currentShift: readShift,
  async openShift(outletId, outletName) {
    await verifyOutlet(outletId);
    const s: Shift = { id: uuid(), outlet_id: outletId, outlet_name: outletName, user_id: auth.userId, restaurant_id: auth.restaurantId, started_at: new Date().toISOString(), source: "local" };
    writeShift(s); // first: the queue stamps ops with the outlet of the current shift
    await submit([{ op: { type: "shift_open", shift_uuid: s.id, outlet_id: outletId, opened_at: s.started_at }, order_ref: `shift:${s.id}`, label: `Open shift${outletName ? ` · ${outletName}` : ""}`, dedupe_key: `shift_open:${s.id}` }]);
    return s;
  },
  async closeShift() {
    const s = readShift();
    if (s) await submit([{ op: { type: "shift_close", shift_uuid: s.id, outlet_id: s.outlet_id, closed_at: new Date().toISOString() }, order_ref: `shift:${s.id}`, label: `Close shift${s.outlet_name ? ` · ${s.outlet_name}` : ""}`, dedupe_key: `shift_close:${s.id}` }]);
    writeShift(null);
  },
  async switchOutlet(outletId, outletName) {
    if (readShift()?.outlet_id === outletId) return readShift()!;
    await verifyOutlet(outletId);
    await this.closeShift();
    return this.openShift(outletId, outletName);
  },
};
