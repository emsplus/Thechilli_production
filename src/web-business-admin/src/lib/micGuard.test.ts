import { describe, expect, test } from "vitest";
import { gapDecision, VadState } from "./micGuard";

// Never sleep, step 2 (docs/VOICE_QA_REPORT.md): the voice-activity detector and the gap fallback decision.
describe("voice activity", () => {
  test("speech starts within two frames above the noise floor and ends after 600 ms of quiet (hysteresis)", () => {
    const v = new VadState();
    let t = 0;
    for (let i = 0; i < 40; i++) expect(v.feed(0.004 + (i % 3) * 0.001, (t += 50))).toBeNull(); // a quiet room
    expect(v.feed(0.08, (t += 50))).toBeNull();
    expect(v.feed(0.09, (t += 50))).toBe("start");
    for (let i = 0; i < 10; i++) expect(v.feed(i % 2 ? 0.05 : 0.012, (t += 50))).toBeNull(); // a dip inside a word is not the end
    for (let i = 0; i < 12; i++) expect(v.feed(0.003, (t += 50))).toBeNull();
    expect(v.feed(0.003, (t += 50))).toBe("end");
  });
  test("a louder room raises the floor: steady noise is not speech", () => {
    const v = new VadState();
    let t = 0;
    for (let i = 0; i < 200; i++) expect(v.feed(0.03 + (i % 2) * 0.002, (t += 50))).toBeNull();
    expect(v.floor).toBeGreaterThan(0.02);
  });
});

describe("the gap fallback (server speech-to-text) only for speech the recogniser missed", () => {
  const u = { start: 10_000, end: 11_500 };
  test("sent: no final from the recogniser since the speech started, 1.2 s after it ended (interim fragments only = a gap)", () => { expect(gapDecision(u, { lastResultAt: 9_000, now: 12_800, recent: [] }).send).toBe(true); });
  test("not sent: the recogniser gave a final for it", () => { expect(gapDecision(u, { lastResultAt: 10_400, now: 13_100, recent: [] })).toMatchObject({ send: false, why: "the recogniser gave a final for it" }); });
  test("not yet: still waiting for the recogniser", () => { expect(gapDecision(u, { lastResultAt: 0, now: 12_000, recent: [] }).send).toBe(false); });
  test("too short (< 0.4 s): a cough, a door", () => { expect(gapDecision({ start: 0, end: 300 }, { lastResultAt: -1, now: 5_000, recent: [] }).send).toBe(false); });
  test("budget: at most 20 clips per 10 minutes per device", () => {
    expect(gapDecision(u, { lastResultAt: 0, now: 13_100, recent: Array.from({ length: 20 }, (_, i) => 13_000 - i * 1000) })).toMatchObject({ send: false });
    expect(gapDecision(u, { lastResultAt: 0, now: 13_100, recent: Array.from({ length: 20 }, () => 13_100 - 700_000) }).send).toBe(true);
  });
});
