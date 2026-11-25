"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface Resource<T> { data: T | undefined; error: ApiError | undefined; loading: boolean; reload: () => void }

interface Settled<T> { key: string; token: string; data?: T; error?: ApiError }

/**
 * Loads on mount and whenever `key` changes (data is cleared so filters never show stale rows). `reload()` refetches and
 * keeps the current data on screen. Stale responses are ignored. State is only set from promise callbacks.
 */
export function useResource<T>(fetcher: () => Promise<T>, key: string, enabled = true): Resource<T> {
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>();
  const fetchRef = useRef(fetcher);
  useEffect(() => { fetchRef.current = fetcher; });
  const token = `${key}#${tick}`;

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetchRef.current().then(
      (data) => { if (live) setSettled({ key, token, data }); },
      (e) => { if (live) setSettled({ key, token, error: e instanceof ApiError ? e : new ApiError(0, "unknown", "Something went wrong") }); },
    );
    return () => { live = false; };
  }, [key, token, enabled]);

  const sameKey = settled?.key === key;
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return {
    data: sameKey ? settled?.data : undefined,
    error: sameKey ? settled?.error : undefined,
    loading: enabled && settled?.token !== token,
    reload,
  };
}

/** Runs a write: returns { run, busy, error }. Error text comes from the server's envelope. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();
  const run = useCallback(async (...a: A): Promise<R | undefined> => {
    setBusy(true); setError(undefined);
    try { return await fn(...a); } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, "unknown", "Something went wrong")); return undefined; } finally { setBusy(false); }
  }, [fn]);
  return { run, busy, error, clear: () => setError(undefined) };
}
