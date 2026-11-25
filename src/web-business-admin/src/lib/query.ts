"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * A tiny shared query cache (no dependency): one entry per key, shared by every component that reads it.
 * - Dedup: callers asking while a request is in flight get the same promise (never a second request).
 * - Cache: a value younger than `staleMs` is served without a request.
 * - One refetch timer per key (not per component), only while someone is subscribed and the tab is visible.
 * - No retries: a failed request stays failed until the next interval / explicit refetch (a 404 "no drawer open"
 *   is a normal answer that the fetcher maps to null, never an error to retry).
 */
export interface QueryState<T> { data: T | undefined; error: unknown; loading: boolean; updatedAt: number }

interface Entry<T> {
  state: QueryState<T>;
  inflight: Promise<T> | null;
  subs: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  refetchMs: number;
  fetcher: () => Promise<T>;
}

const store = new Map<string, Entry<unknown>>();
const EMPTY: QueryState<never> = { data: undefined, error: null, loading: true, updatedAt: 0 };

function entry<T>(key: string, fetcher: () => Promise<T>): Entry<T> {
  let e = store.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { state: EMPTY, inflight: null, subs: new Set(), timer: null, refetchMs: 0, fetcher };
    store.set(key, e as Entry<unknown>);
  }
  e.fetcher = fetcher; // newest closure wins (same request, fresher captured values)
  return e;
}

const emit = (e: Entry<unknown>) => { for (const s of e.subs) s(); };

/** Fetch through the cache: in-flight requests are shared and a fresh value (younger than `staleMs`) is returned as is. */
export function fetchShared<T>(key: string, fetcher: () => Promise<T>, staleMs = 0, now = Date.now()): Promise<T> {
  const e = entry(key, fetcher);
  if (e.inflight) return e.inflight;
  if (e.state.updatedAt && !e.state.error && now - e.state.updatedAt < staleMs) return Promise.resolve(e.state.data as T);
  const p = e.fetcher().then(
    (data) => { e.state = { data, error: null, loading: false, updatedAt: Date.now() }; return data; },
    (error: unknown) => { e.state = { ...e.state, error, loading: false, updatedAt: Date.now() }; throw error; },
  ).finally(() => { e.inflight = null; emit(e as Entry<unknown>); });
  e.inflight = p;
  return p;
}

/** Replace the cached value (after a mutation that returned the new value), notifying every reader. */
export function setShared<T>(key: string, data: T) {
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) { store.set(key, { state: { data, error: null, loading: false, updatedAt: Date.now() }, inflight: null, subs: new Set(), timer: null, refetchMs: 0, fetcher: () => Promise.resolve(data) } as Entry<unknown>); return; }
  e.state = { data, error: null, loading: false, updatedAt: Date.now() };
  emit(e as Entry<unknown>);
}

/** Forget a key (sign-out, account switch) or every key. */
export function clearShared(key?: string) {
  if (key === undefined) { for (const e of store.values()) if (e.timer) clearInterval(e.timer); store.clear(); return; }
  const e = store.get(key);
  if (e?.timer) clearInterval(e.timer);
  store.delete(key);
}

function startTimer(key: string, e: Entry<unknown>) {
  if (e.timer || !e.refetchMs) return;
  e.timer = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    void fetchShared(key, e.fetcher, 0).catch(() => { /* readers see `error` */ });
  }, e.refetchMs);
}

/**
 * Read a shared query. `key` null = disabled (no request). Every reader of the same key shares one request and one timer.
 * `refetchMs` (default 60 s) refreshes while mounted and visible; `staleMs` (default 15 s) lets a remount reuse the value.
 */
export function useSharedQuery<T>(key: string | null, fetcher: () => Promise<T>, opts: { staleMs?: number; refetchMs?: number } = {}) {
  const staleMs = opts.staleMs ?? 15_000;
  const refetchMs = opts.refetchMs ?? 60_000;
  const subscribe = useCallback((cb: () => void) => {
    if (!key) return () => {};
    const e = entry(key, fetcher) as Entry<unknown>;
    e.subs.add(cb);
    e.refetchMs = e.refetchMs ? Math.min(e.refetchMs, refetchMs) : refetchMs;
    startTimer(key, e);
    return () => {
      e.subs.delete(cb);
      if (e.subs.size === 0 && e.timer) { clearInterval(e.timer); e.timer = null; e.refetchMs = 0; }
    };
    // `fetcher` is read through the entry (latest wins); re-subscribing on every render would restart timers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refetchMs]);
  const state = useSyncExternalStore(subscribe, () => (key ? (store.get(key)?.state as QueryState<T> | undefined) ?? EMPTY : EMPTY), () => EMPTY) as QueryState<T>;

  useEffect(() => {
    if (!key) return;
    void fetchShared(key, fetcher, staleMs).catch(() => { /* readers see `error` */ });
    // Only when the key changes (or on mount): not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refetch = useCallback(() => (key ? fetchShared(key, fetcher, 0) : Promise.reject(new Error("disabled"))) as Promise<T>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]);
  return { ...state, loading: key ? state.loading : false, refetch };
}

/** Test hook: how many keys / subscribers exist. */
export const _queryDebug = () => ({ keys: store.size, subs: [...store.values()].reduce((n, e) => n + e.subs.size, 0) });
