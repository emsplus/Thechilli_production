import type { QueuedOp } from "./types";

export interface OpStore {
  list(): Promise<QueuedOp[]>; // ordered by seq
  put(op: QueuedOp): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemoryStore implements OpStore {
  private m = new Map<string, QueuedOp>();
  async list() { return [...this.m.values()].map((o) => structuredClone(o)).sort((a, b) => a.seq - b.seq); }
  async put(op: QueuedOp) { this.m.set(op.op_id, structuredClone(op)); }
  async delete(id: string) { this.m.delete(id); }
}
