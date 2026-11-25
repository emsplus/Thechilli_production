"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, auth } from "./api";

/** Auth-gated loader with a shared error state and action runner. */
export function useLoader<T>(fetcher: () => Promise<T>) {
  const router = useRouter();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try { setData(await fetcher()); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Failed to load"); }
    finally { setLoading(false); }
  }, [fetcher]);

  useEffect(() => {
    if (!auth.token) { router.replace("/login"); return; }
    void Promise.resolve().then(reload);
  }, [reload, router]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try { await fn(); await reload(); } catch (e) { setError(e instanceof ApiError ? e.message : "Something went wrong"); }
  }
  return { data, error, setError, loading, reload, run };
}
