"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

/** Loads once, then again every `ms` (0 = no polling) while mounted; a failed refresh keeps the last data and reports the error. */
export function usePoll<T>(fetcher: () => Promise<T>, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef(fetcher);
  useEffect(() => { fetchRef.current = fetcher; });
  const reload = useCallback(async () => {
    try { setData(await fetchRef.current()); setError(null); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Failed to load"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(reload); }, [reload]);
  useEffect(() => {
    if (!ms) return;
    const t = setInterval(() => { if (!document.hidden) void reload(); }, ms);
    return () => clearInterval(t);
  }, [ms, reload]);
  return { data, error, loading, reload };
}
