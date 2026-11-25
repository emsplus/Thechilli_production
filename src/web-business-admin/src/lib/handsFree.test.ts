import { describe, expect, test } from "vitest";
import { handsFreeLabel, REARM_LIMIT, rearmDecision, sleepRetryDelay, type RearmState, type Trigger } from "./handsFree";

const S = (sleep: RearmState["sleep"], history: number[] = []): RearmState => ({ sleep, history });

describe("rearmDecision", () => {
  test("sleeping re-arms on focus, visible, online, new order and a granted permission", () => {
    for (const t of ["focus", "visible", "online", "new-ticket", "permission-granted"] as Trigger[]) {
      const r = rearmDecision(S("sleeping"), t, 1000, false);
      expect(r.rearm, t).toBe(true);
      expect(r.state).toEqual({ sleep: null, history: [1000] });
    }
  });

  test("permission denied never re-arms by itself (no loop), only a granted permission or a tap", () => {
    for (const t of ["focus", "visible", "online", "new-ticket"] as Trigger[]) expect(rearmDecision(S("blocked"), t, 0, false).rearm, t).toBe(false);
    expect(rearmDecision(S("blocked"), "permission-granted", 0, false).rearm).toBe(true);
    expect(rearmDecision(S("blocked"), "tap", 0, false).rearm).toBe(true);
  });

  test("a browser that needs a tap re-arms on a new order or a granted permission, not on focus", () => {
    expect(rearmDecision(S("tap"), "focus", 0, false).rearm).toBe(false);
    expect(rearmDecision(S("tap"), "visible", 0, false).rearm).toBe(false);
    expect(rearmDecision(S("tap"), "new-ticket", 0, false).rearm).toBe(true);
  });

  test("the off switch wins over everything", () => {
    for (const t of ["focus", "tap", "switch-on", "permission-granted"] as Trigger[]) expect(rearmDecision(S("sleeping"), t, 0, true).rearm).toBe(false);
  });

  test("at most REARM_LIMIT.max automatic re-arms per window; then it waits for a tap; old ones expire", () => {
    let s = S("sleeping");
    let n = 0;
    for (let i = 0; i < 10; i++) {
      const r = rearmDecision({ ...s, sleep: "sleeping" }, "focus", 1000 + i, false);
      if (r.rearm) n++;
      s = r.state;
    }
    expect(n).toBe(REARM_LIMIT.max);
    expect(rearmDecision({ ...s, sleep: "sleeping" }, "tap", 2000, false).rearm).toBe(true);
    expect(rearmDecision({ ...s, sleep: "sleeping" }, "focus", 1000 + REARM_LIMIT.windowMs + 50, false).rearm).toBe(true);
  });

  test("nothing to do when it is not asleep", () => {
    expect(rearmDecision(S(null), "focus", 0, false).rearm).toBe(false);
  });
});

test("handsFreeLabel says the state in words (never colour only)", () => {
  expect(handsFreeLabel({ on: false, listening: false, trouble: null, sleep: null, wait: null }).short).toBe("Off");
  expect(handsFreeLabel({ on: true, listening: true, trouble: null, sleep: null, wait: null })).toMatchObject({ short: "Listening", long: "Waiting for “Hey Zonov”" });
  expect(handsFreeLabel({ on: true, listening: true, trouble: "network", sleep: null, wait: null }).long).toMatch(/keeps failing \(network\)/);
  expect(handsFreeLabel({ on: true, listening: false, trouble: null, sleep: "sleeping", wait: null })).toMatchObject({ state: "paused", short: "Reconnecting" });
  expect(handsFreeLabel({ on: true, listening: false, trouble: null, sleep: "blocked", wait: null }).short).toBe("Mic blocked");
  expect(handsFreeLabel({ on: true, listening: false, trouble: null, sleep: "nomic", wait: null }).short).toBe("No mic");
  expect(handsFreeLabel({ on: true, listening: false, trouble: null, sleep: null, wait: "Voice is paused while you type" }).long).toBe("Voice is paused while you type");
});

// Owner bug 2026-11-02 (docs/VOICE_QA_REPORT.md B14): the mic stayed dead until a reload on a counter screen that never loses focus.
test("sleeping: the till's own timer re-arms without limit; a microphone change re-arms; a denied mic still never loops", () => {
  let st: RearmState = { sleep: "sleeping", history: [] };
  for (let i = 0; i < 50; i++) { const r = rearmDecision(st, "timer", i * 1000, false); expect(r.rearm).toBe(true); st = { ...r.state, sleep: "sleeping" }; }
  expect(rearmDecision({ sleep: "sleeping", history: [] }, "device", 0, false).rearm).toBe(true);
  expect(rearmDecision({ sleep: "nomic", history: [] }, "device", 0, false).rearm).toBe(true);
  expect(rearmDecision({ sleep: "blocked", history: [] }, "timer", 0, false).rearm).toBe(false);
  expect(rearmDecision({ sleep: "blocked", history: [] }, "device", 0, false).rearm).toBe(false);
  expect(rearmDecision({ sleep: "blocked", history: [] }, "reset", 0, false).rearm).toBe(true);
  expect(sleepRetryDelay(0)).toBe(1_000);
  expect(sleepRetryDelay(99)).toBe(3_000);
});
