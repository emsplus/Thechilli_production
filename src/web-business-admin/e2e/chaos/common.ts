import { expect, type Page, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
export * from "../helpers";
export const SHOTS = process.env.CHAOS_SHOTS ?? "/Users/saurabh/Downloads/thechilli/docs/testing/break-chaos-shots";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function shot(page: Page, name: string) { fs.mkdirSync(SHOTS, { recursive: true }); return page.screenshot({ path: path.join(SHOTS, name + ".png") }).catch(() => {}); }
export function log(file: string, line: string) { fs.mkdirSync(SHOTS, { recursive: true }); fs.appendFileSync(path.join(SHOTS, file), `${new Date().toISOString()} ${line}\n`); console.log(line); }
/** Test infra only: the sign-up throttle lives in abuse_counters of the throwaway DB. */
export function resetAbuse() { try { execFileSync("/opt/homebrew/opt/postgresql@16/bin/psql", ["-h", "127.0.0.1", "-p", process.env.CHAOS_PG_PORT ?? "17931", "-U", "pos", "pos", "-qc", "truncate abuse_counters"], { env: { ...process.env, PGPASSWORD: "pos" } }); } catch { /* ignore */ } }
export const dumpQueue = (page: Page) => page.evaluate(async () => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("pos-offline"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all: any[] = await new Promise((res, rej) => { const r = db.transaction("queue").objectStore("queue").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  db.close();
  return all.sort((a, b) => a.seq - b.seq).map((o) => ({ type: o.op.type, status: o.status, attempts: o.attempts, error: o.error, seq: o.seq, ref: o.order_ref, label: o.label }));
});
export const unsynced = async (page: Page) => (await dumpQueue(page)).filter((o) => o.status !== "synced");
export async function serverState(request: APIRequestContext, auth: Record<string, string>, API: string) {
  const orders = await (await request.get(`${API}/orders`, { headers: auth })).json();
  const bills = await (await request.get(`${API}/bills`, { headers: auth })).json();
  return { orders, bills };
}
export const apiBase = process.env.E2E_API_BASE ?? "http://127.0.0.1:18931/api/v1";
export { expect };

/** A device whose clock is wrong by `offsetMs`: Date / Date.now() shifted, timers keep running (page.clock.install would freeze them). */
export const skewDeviceClock = (page: Page, offsetMs: number) => page.addInitScript((off: number) => {
  const D = Date;
  class Skewed extends D { constructor(...a: unknown[]) { if (a.length === 0) super(D.now() + off); else super(...(a as [number])); } static now() { return D.now() + off; } }
  (window as unknown as { Date: unknown }).Date = Skewed;
}, offsetMs);
