"use client";
import { useSyncExternalStore } from "react";
import { getDb } from "../queue/idbStore";
import { checkIntegrity, type IntegrityResult } from "../queue/integrity";
import { uuid } from "../uuid";

let result: IntegrityResult = { status: "ok" };
const subs = new Set<() => void>();
let ran = false;

/** Run once at startup (web and native): asks the browser not to evict storage, then verifies the queue survived. */
export async function runStartupChecks(): Promise<IntegrityResult> {
  if (ran) return result;
  ran = true;
  try { await navigator.storage?.persist?.(); } catch { /* best effort; WebView may deny */ }
  result = await checkIntegrity({
    getMarker: async () => ((await (await getDb()).get("cache", "__integrity")) as string | undefined) ?? null,
    putMarker: async (id) => { await (await getDb()).put("cache", id, "__integrity"); },
    ls: { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) },
    newId: uuid,
  });
  subs.forEach((f) => f());
  return result;
}
export function useIntegrity(): IntegrityResult {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => result, () => ({ status: "ok" }) as IntegrityResult);
}
