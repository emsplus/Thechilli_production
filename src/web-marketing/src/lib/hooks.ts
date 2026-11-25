"use client";
import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { ApiError } from "./api";

export interface QueryResult<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  /** Refetch without clearing the current data. */
  reload: () => void;
}

/** Minimal data hook: `key` identifies the request (change it to refetch). No cache, no tokens in URLs. */
export function useQuery<T>(key: string, fn: () => Promise<T>): QueryResult<T> {
  const [state, setState] = useState<{ key: string; data?: T; error?: ApiError } | null>(null);
  const [tick, setTick] = useState(0);
  const run = useEffectEvent(fn);

  useEffect(() => {
    let alive = true;
    run().then(
      (data) => alive && setState({ key, data }),
      (e) => alive && setState({ key, error: e instanceof ApiError ? e : new ApiError(0, "Something went wrong") }),
    );
    return () => { alive = false; };
  }, [key, tick]);

  const settled = state?.key === key;
  return { data: settled ? state.data : undefined, error: settled ? state.error : undefined, loading: !settled, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** Wraps an async action: busy flag + error message, never throws. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "Something went wrong"));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}

export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** True while the media query matches (client only; false during the server render). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
