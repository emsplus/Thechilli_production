import { describe, expect, it } from "vitest";
import { effectiveState, flushOps, nextOp, type ClockOp } from "./clockQueue";

const at = (m: number) => new Date(Date.UTC(2026, 9, 31, 9, m)).toISOString();

describe("offline clock in / out", () => {
  it("a queued clock-in shows as clocked in (pending) and clock-out uses its key", () => {
    let n = 0; const key = () => `k${++n}`;
    const s0 = effectiveState(null, []);
    expect(s0).toMatchObject({ open: false, pending: false });
    const inOp = nextOp(s0, at(0), key, "Tablet");
    expect(inOp).toEqual({ kind: "in", client_uuid: "k1", at: at(0), device: "Tablet" });
    const s1 = effectiveState(null, [inOp]);
    expect(s1).toMatchObject({ open: true, since: at(0), inKey: "k1", pending: true });
    const outOp = nextOp(s1, at(30), key);
    expect(outOp).toMatchObject({ kind: "out", client_uuid: "k1", at: at(30) });
    expect(effectiveState(null, [inOp, outOp])).toMatchObject({ open: false, pending: true });
  });
  it("clock-out of a server record: its client_uuid when it has one, otherwise none (the server closes the open record)", () => {
    expect(nextOp(effectiveState({ clock_in_at: at(0), client_uuid: "srv" }, []), at(5), () => "x")).toMatchObject({ kind: "out", client_uuid: "srv" });
    expect(nextOp(effectiveState({ clock_in_at: at(0), client_uuid: null }, []), at(5), () => "x")).not.toHaveProperty("client_uuid");
  });
  it("flush sends in order, stops while offline, drops final refusals", async () => {
    const q: ClockOp[] = [{ kind: "in", client_uuid: "a", at: at(0) }, { kind: "out", client_uuid: "a", at: at(9) }, { kind: "in", client_uuid: "b", at: at(20) }];
    const seen: string[] = [];
    let r = await flushOps(q, async (op) => { seen.push(op.kind); return "offline"; });
    expect(r.remaining).toHaveLength(3);
    r = await flushOps(q, async (op) => (op.at === at(9) ? "final" : "ok"));
    expect(r).toMatchObject({ remaining: [], sent: [q[0], q[2]], dropped: [q[1]] });
    r = await flushOps(q, async (op) => (op.at === at(9) ? "retry" : "ok"));
    expect(r.sent).toEqual([q[0]]);
    expect(r.remaining).toEqual([q[1], q[2]]);
    expect(seen).toEqual(["in"]);
  });
});
