"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";

/** Loads one insight report for the page's range (re-runs on a new range, the Refresh button or `retry`); never cached offline. */
export function useInsight<T>(fetcher: (from: string, to: string) => Promise<T>, from: string, to: string, tick: number) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: "" });
  const [retries, setRetries] = useState(0);
  const key = `${from}|${to}|${tick}|${retries}`;
  useEffect(() => {
    let off = false;
    void Promise.resolve().then(async () => {
      try { const data = await fetcher(from, to); if (!off) setState({ key, data }); }
      catch (e) { if (!off) setState({ key, error: e instanceof ApiError ? e.message : "Could not load this report" }); }
    });
    return () => { off = true; };
  }, [fetcher, from, to, tick, key]);
  const fresh = state.key === key;
  return { data: state.data, error: fresh ? state.error : undefined, loading: !state.data && !state.error, stale: !!state.data && !fresh, retry: () => { setState({ key: "" }); setRetries((n) => n + 1); } };
}
