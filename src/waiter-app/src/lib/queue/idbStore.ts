import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { OpStore } from "./store";
import type { QueuedOp } from "./types";

interface WaiterDB extends DBSchema {
  queue: { key: string; value: QueuedOp; indexes: { seq: number } };
  cache: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<WaiterDB>> | null = null;

export function getDb() {
  dbp ??= openDB<WaiterDB>("waiter-offline", 1, {
    upgrade(db) {
      db.createObjectStore("queue", { keyPath: "op_id" }).createIndex("seq", "seq");
      db.createObjectStore("cache");
    },
    blocking() { void dbp?.then((d) => d.close()).catch(() => {}); dbp = null; },
  });
  return dbp;
}

/** Durable queue: every put is committed to IndexedDB before enqueue() resolves. */
export const idbStore: OpStore = {
  async list() { return (await getDb()).getAllFromIndex("queue", "seq"); },
  async put(op) { await (await getDb()).put("queue", op); },
  async delete(id) { await (await getDb()).delete("queue", id); },
};

export async function cacheGet<T>(key: string): Promise<T | null> {
  try { return ((await (await getDb()).get("cache", key)) as T | undefined) ?? null; } catch { return null; }
}
export async function cachePut(key: string, value: unknown) {
  try { await (await getDb()).put("cache", value, key); } catch { /* storage unavailable */ }
}
export async function wipeLocalData() {
  const db = await getDb();
  await Promise.all([db.clear("queue"), db.clear("cache")]);
  try { localStorage.removeItem("waiter.idb.marker"); localStorage.setItem("waiter.queue.pending", "0"); } catch { /* ignore */ }
}
