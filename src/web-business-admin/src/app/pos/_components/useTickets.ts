"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { auth } from "@/lib/api";
import { deleteDraft, listDrafts, putDraft } from "@/lib/offlineDb";
import { DONE_TTL_MS, lowestFreeNo, newTicket, stageOf } from "./tickets";
import { MAX_OPEN_TICKETS, type Ticket } from "./types";

const activeKey = () => `pos.activeTicket:${auth.restaurantId ?? ""}`;
const readActive = () => { try { return localStorage.getItem(activeKey()); } catch { return null; } };
const writeActive = (id: string) => { try { localStorage.setItem(activeKey(), id); } catch { /* ignore */ } };

/**
 * All open tickets of this device/restaurant. Source of truth is `ref` (updated synchronously by every commit, so two
 * async flows finishing together can never overwrite each other's change); React state mirrors it for rendering.
 * Each ticket object is replaced immutably, and only changed tickets are written to IndexedDB "drafts"
 * (serialised through one promise chain so writes land in order).
 */
export function useTickets() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [activeId, setActiveState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusyState] = useState<Record<string, boolean>>({});
  const ref = useRef<Ticket[]>([]);
  const activeRef = useRef<string | null>(null);
  const saved = useRef(new Map<string, Ticket>());
  const chain = useRef<Promise<void>>(Promise.resolve());

  const commit = useCallback((fn: (t: Ticket[]) => Ticket[]) => {
    const next = fn(ref.current);
    if (next === ref.current) return;
    ref.current = next;
    setTickets(next);
  }, []);

  const setActive = useCallback((id: string) => {
    activeRef.current = id; setActiveState(id); writeActive(id);
  }, []);

  // Restore every open ticket of this restaurant (reload / app restart), then start persisting.
  useEffect(() => {
    let live = true;
    void (async () => {
      let list: Ticket[] = [];
      try {
        const rid = auth.restaurantId;
        const recs = (await listDrafts()).filter((d) => !d.restaurant_id || !rid || d.restaurant_id === rid);
        const now = Date.now();
        for (const r of recs) {
          const t = r.data as Ticket;
          const stale = t.paidAt && now - Date.parse(t.paidAt) > DONE_TTL_MS;
          if (stale) void deleteDraft(r.id).catch(() => {});
          else { list.push(t); saved.current.set(t.id, t); }
        }
      } catch { list = []; }
      if (!live) return;
      list.sort((a, b) => a.no - b.no);
      if (list.length === 0) list = [newTicket(1)];
      ref.current = list; setTickets(list);
      const want = readActive();
      const id = list.some((t) => t.id === want) ? want! : list[list.length - 1].id;
      activeRef.current = id; setActiveState(id);
      setReady(true);
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const rid = auth.restaurantId ?? undefined;
    const cur = new Map(tickets.map((t) => [t.id, t]));
    const writes: (() => Promise<void>)[] = [];
    for (const t of tickets) {
      if (saved.current.get(t.id) !== t) writes.push(() => putDraft({ id: t.id, restaurant_id: rid, no: t.no, updated_at: new Date().toISOString(), data: t }));
    }
    for (const id of saved.current.keys()) if (!cur.has(id)) writes.push(() => deleteDraft(id));
    saved.current = cur;
    if (writes.length) chain.current = chain.current.then(async () => { for (const w of writes) { try { await w(); } catch { /* storage unavailable: tickets stay in memory */ } } });
  }, [tickets, ready]);

  const patch = useCallback((id: string, fn: (t: Ticket) => Ticket) => {
    commit((all) => all.map((t) => (t.id === id ? fn(t) : t)));
  }, [commit]);

  const get = useCallback((id: string) => ref.current.find((t) => t.id === id), []);

  /** Starts another ticket (`no` = a specific bill number, e.g. spoken). Returns its id, or null when too many bills are open or the number is taken. */
  const create = useCallback((no?: number): string | null => {
    const open = ref.current.filter((t) => stageOf(t) !== "paid").length;
    if (open >= MAX_OPEN_TICKETS) return null;
    if (no !== undefined && ref.current.some((t) => t.no === no)) return null; // a bill number is unique on the screen
    const t = newTicket(no ?? lowestFreeNo(ref.current));
    commit((all) => [...all, t]);
    setActive(t.id);
    return t.id;
  }, [commit, setActive]);

  /** Removes a ticket (closed / discarded / paid-and-dismissed). Never leaves zero tickets. */
  const remove = useCallback((id: string) => {
    const all = ref.current;
    const idx = all.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const rest = all.filter((t) => t.id !== id);
    if (rest.length === 0) {
      const t = newTicket(lowestFreeNo(rest));
      commit(() => [t]); setActive(t.id);
    } else {
      commit(() => rest);
      if (activeRef.current === id) setActive(rest[Math.min(idx, rest.length - 1)].id);
    }
  }, [commit, setActive]);

  const busyIds = useRef(new Set<string>());
  const isBusy = useCallback((id: string) => busyIds.current.has(id), []);
  const all = useCallback(() => ref.current, []);
  const setBusy = useCallback((id: string, on: boolean) => {
    if (on) busyIds.current.add(id); else busyIds.current.delete(id);
    setBusyState((b) => { if (!!b[id] === on) return b; const n = { ...b }; if (on) n[id] = true; else delete n[id]; return n; });
  }, []);

  return { tickets, activeId, activeRef, ready, busy, setActive, create, remove, patch, get, all, isBusy, setBusy };
}
