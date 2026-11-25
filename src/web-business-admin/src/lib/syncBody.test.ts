import { describe, expect, it } from "vitest";
import { isOpRejection, syncBody } from "./syncBody";

describe("POST /sync/operations body (QA review H1)", () => {
  it("carries client_sent_at, the raw device time of the send, next to the ops", () => {
    const op = { op_id: "a", device_id: "d", client_created_at: "2026-11-02T18:00:00.000Z", op: { type: "send_kot", order_client_uuid: "o" } } as never;
    const b = syncBody([op], new Date("2026-11-02T18:45:30.123Z"));
    expect(b.client_sent_at).toBe("2026-11-02T18:45:30.123Z");
    expect(b.operations).toEqual([op]); // client_created_at per op is still sent as before
  });
  it("uses the device clock as it is (a wrong clock is what the server corrects)", () => {
    const before = Date.now();
    const t = Date.parse(syncBody([]).client_sent_at);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});

describe("which rejections are about the operations", () => {
  it("400, 404, 409, 413, 422 are; 401, 402, 403, 408, 425, 429 and 5xx / network are not", () => {
    for (const s of [400, 404, 409, 413, 422]) expect(isOpRejection(s), String(s)).toBe(true);
    for (const s of [0, 401, 402, 403, 408, 425, 429, 500, 502, 503]) expect(isOpRejection(s), String(s)).toBe(false);
  });
});
