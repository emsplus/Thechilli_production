/**
 * Hands-free listener self-healing (liveSpeech.ts): the watchdog, the capped backoff, "sleeping" after repeated failures,
 * start() races, and the 60 s (not whole-page) vendor-service pause. A fake SpeechRecognition on a fake `window`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

class FakeSR {
  static made: FakeSR[] = [];
  static autoStart = true;
  static throwOnStart = false;
  lang = ""; continuous = false; interimResults = false; maxAlternatives = 1;
  onresult: ((e: unknown) => void) | null = null; onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null; onstart: (() => void) | null = null; onaudiostart: (() => void) | null = null;
  started = false; aborted = false;
  constructor() { FakeSR.made.push(this); }
  start() {
    if (FakeSR.throwOnStart) { const e = new Error("busy"); e.name = "InvalidStateError"; throw e; }
    this.started = true;
    if (FakeSR.autoStart) setTimeout(() => { if (this.started) { this.onstart?.(); this.onaudiostart?.(); } }, 0);
  }
  stop() { this.started = false; setTimeout(() => this.onend?.(), 0); }
  abort() { this.started = false; this.aborted = true; }
}

let mod: typeof import("./liveSpeech");
beforeAll(async () => {
  vi.stubGlobal("window", { SpeechRecognition: FakeSR, addEventListener: () => {} });
  mod = await import("./liveSpeech");
});
beforeEach(() => {
  vi.useFakeTimers();
  FakeSR.made = []; FakeSR.autoStart = true; FakeSR.throwOnStart = false;
  mod.resetSpeechBroken();
});
afterEach(() => { vi.useRealTimers(); });

const listener = (persistent = true) => {
  const cb = { onUpdate: vi.fn(), onFail: vi.fn(), onEnd: vi.fn(), onTrouble: vi.fn() };
  const l = new mod.LiveListener({ lang: "en-IN", persistent, ...cb });
  return { l, cb };
};

describe("hands-free watchdog", () => {
  test("a recogniser that never reports onstart is thrown away and replaced", () => {
    FakeSR.autoStart = false;
    const { l, cb } = listener();
    expect(l.start()).toBe(true);
    vi.advanceTimersByTime(mod.WATCHDOG.startGraceMs + 1500);
    expect(FakeSR.made.length).toBe(2);
    expect(FakeSR.made[0].aborted).toBe(true);
    expect(cb.onFail).not.toHaveBeenCalled();
    l.abort();
  });

  test("a recogniser that went silent without ending (sleep, lid, device switch) is restarted", () => {
    const { l, cb } = listener();
    l.start();
    vi.advanceTimersByTime(10);
    expect(FakeSR.made.length).toBe(1);
    FakeSR.made[0].started = false; // dies with no onend / onerror
    vi.advanceTimersByTime(mod.WATCHDOG.silentMaxMs + 2000);
    expect(FakeSR.made.length).toBe(2);
    expect(FakeSR.made[1].started).toBe(true);
    expect(cb.onFail).not.toHaveBeenCalled();
    l.abort();
  });

  test("a healthy session that ends after a pause restarts at once, with no trouble reported", () => {
    const { l, cb } = listener();
    l.start();
    vi.advanceTimersByTime(10);
    FakeSR.made[0].stop();
    vi.advanceTimersByTime(10);
    expect(FakeSR.made.length).toBe(2);
    expect(cb.onTrouble).not.toHaveBeenCalled();
    l.abort();
  });

  test("NEVER sleeps: restarts that keep failing are retried forever, at most 3 s apart (owner, 2026-11-02)", () => {
    FakeSR.autoStart = false;
    const { l, cb } = listener();
    l.start();
    vi.advanceTimersByTime(30 * 60_000); // half an hour of a service that never starts
    expect(cb.onFail).not.toHaveBeenCalled();
    expect(FakeSR.made.length).toBeGreaterThan(250); // a try at least every ~7 s (3 s backoff + the 3 s start grace)
    expect(cb.onTrouble).toHaveBeenCalled(); // the till shows "Reconnecting" while it struggles
    FakeSR.autoStart = true;
    vi.advanceTimersByTime(10_000);
    expect(FakeSR.made.at(-1)!.started).toBe(true);
    l.abort();
  });

  test("start() throwing after the listener has worked once is retried, never fatal", () => {
    const { l, cb } = listener();
    l.start();
    vi.advanceTimersByTime(10);
    FakeSR.throwOnStart = true;
    FakeSR.made[0].stop(); // onend -> spawn -> start() throws (old recogniser still closing)
    vi.advanceTimersByTime(10);
    expect(cb.onFail).not.toHaveBeenCalled();
    FakeSR.throwOnStart = false;
    vi.advanceTimersByTime(2000);
    expect(FakeSR.made.at(-1)!.started).toBe(true);
    expect(cb.onFail).not.toHaveBeenCalled();
    l.abort();
  });

  test("stop() and abort() remove the watchdog", () => {
    FakeSR.autoStart = false;
    const { l } = listener();
    l.start();
    l.abort();
    vi.advanceTimersByTime(60_000);
    expect(FakeSR.made.length).toBe(1);
  });
});

describe("vendor-service failure", () => {
  test("'network' pauses live speech for 60 s, not for the whole page", () => {
    const { l, cb } = listener(false);
    l.start();
    vi.advanceTimersByTime(10);
    expect(mod.liveSpeechUsable()).toBe(true);
    FakeSR.made[0].onerror?.({ error: "network" });
    expect(cb.onFail).toHaveBeenCalledWith("unsupported");
    expect(mod.liveSpeechUsable()).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(mod.liveSpeechUsable()).toBe(true);
  });

  test("in hands-free mode 'network' is retried instead of ending listening", () => {
    const { l, cb } = listener();
    l.start();
    vi.advanceTimersByTime(10);
    const r = FakeSR.made[0];
    r.onerror?.({ error: "network" });
    r.started = false; r.onend?.();
    vi.advanceTimersByTime(10);
    expect(cb.onFail).not.toHaveBeenCalled();
    expect(FakeSR.made.length).toBe(2);
    l.abort();
  });

  test("'not-allowed' in hands-free mode ends it as blocked", () => {
    const { l, cb } = listener();
    l.start();
    vi.advanceTimersByTime(10);
    FakeSR.made[0].onerror?.({ error: "not-allowed" });
    expect(cb.onFail).toHaveBeenCalledWith("blocked");
  });
});

test("collapseFinals drops Android's repeated earlier finals", () => {
  expect(mod.collapseFinals(["two naan", "two naan one lassi"]).join(" ")).toContain("one lassi");
});

// docs/VOICE_QA_REPORT.md bug B3: a "place order" / "done" still unfinished (interim) when Chrome ends the session after a pause
// was committed silently on the restart; the till heard about it only with the NEXT words (or never, when nobody spoke again).
describe("unfinished words at a session end (QA B3)", () => {
  const interim = (r: FakeSR, finals: string[], tail: string) => r.onresult?.({ resultIndex: 0, results: Object.assign([
    ...finals.map((t) => Object.assign([{ transcript: t }], { isFinal: true })), Object.assign([{ transcript: tail }], { isFinal: false })], { length: finals.length + 1 }) });
  test.each([false, true])("persistent=%s: the restart reports the committed text at once", (persistent) => {
    const { l, cb } = listener(persistent);
    l.forget = false;
    l.start();
    vi.advanceTimersByTime(10);
    interim(FakeSR.made[0], ["one matar paneer, two lassi"], "place order");
    expect(cb.onUpdate).toHaveBeenLastCalledWith({ finalText: "one matar paneer, two lassi", interim: "place order" });
    FakeSR.made[0].started = false; FakeSR.made[0].onend?.();
    expect(cb.onUpdate).toHaveBeenLastCalledWith({ finalText: "one matar paneer, two lassi, place order", interim: "" });
    expect(FakeSR.made.length).toBe(2); // and it goes on listening (for "stop")
    l.abort();
  });
  test("a caller that stops on those words gets no new recogniser", () => {
    const cb = { onUpdate: vi.fn(), onFail: vi.fn(), onEnd: vi.fn() };
    const l: import("./liveSpeech").LiveListener = new mod.LiveListener({ lang: "en-IN", ...cb, onUpdate: (u) => { cb.onUpdate(u); if (!u.interim && /done$/.test(u.finalText)) l.abort(); } });
    l.start();
    vi.advanceTimersByTime(10);
    interim(FakeSR.made[0], ["two lassi"], "done");
    FakeSR.made[0].started = false; FakeSR.made[0].onend?.();
    expect(FakeSR.made.length).toBe(1);
    expect(cb.onEnd).not.toHaveBeenCalled();
  });
  test("while waiting for the wake phrase (forget) nothing is reported", () => {
    const { l, cb } = listener(true);
    l.forget = true;
    l.start();
    vi.advanceTimersByTime(10);
    interim(FakeSR.made[0], [], "table five wants the bill");
    cb.onUpdate.mockClear();
    FakeSR.made[0].started = false; FakeSR.made[0].onend?.();
    expect(cb.onUpdate).not.toHaveBeenCalled();
    l.abort();
  });
});

// Owner bug 2026-11-02 (docs/VOICE_QA_REPORT.md B11): after an order was sent, "Hey Zonov" did nothing. The new background listener
// started right after the order sheet's recogniser was aborted; Chrome threw InvalidStateError and a FRESH listener gave up at once.
describe("a fresh hands-free listener whose first start throws (QA B11)", () => {
  test("is retried with the backoff instead of failing", () => {
    FakeSR.throwOnStart = true;
    const { l, cb } = listener(true);
    expect(l.start()).toBe(true);
    expect(cb.onFail).not.toHaveBeenCalled();
    FakeSR.throwOnStart = false;
    vi.advanceTimersByTime(3000);
    expect(FakeSR.made.at(-1)!.started).toBe(true);
    expect(cb.onFail).not.toHaveBeenCalled();
    l.abort();
  });
  test("a tapped listener retries a throwing start a few times (a recogniser still closing), then falls back", () => {
    FakeSR.throwOnStart = true;
    const { l, cb } = listener(false);
    expect(l.start()).toBe(true);
    vi.advanceTimersByTime(350);
    expect(cb.onFail).not.toHaveBeenCalled();
    FakeSR.throwOnStart = false;
    vi.advanceTimersByTime(350);
    expect(FakeSR.made.at(-1)!.started).toBe(true);
    expect(cb.onFail).not.toHaveBeenCalled();
    l.abort();
  });
  test("a tapped listener that never starts falls back (recording / typing)", () => {
    FakeSR.throwOnStart = true;
    const { cb } = listener(false);
    const { l } = { l: new mod.LiveListener({ lang: "en-IN", ...cb }) };
    l.start();
    vi.advanceTimersByTime(2000);
    expect(cb.onFail).toHaveBeenCalledWith("unsupported");
  });
});

// QA B14: a quiet room (no recogniser event for a while) is not a failure: hands-free must never fall asleep from silence.
describe("silence is no failure", () => {
  test("many silent periods in a row never lead to 'sleeping'", () => {
    const { l, cb } = listener(true);
    l.start();
    for (let i = 0; i < 12; i++) vi.advanceTimersByTime(mod.WATCHDOG.silentMaxMs + mod.WATCHDOG.tickMs * 2);
    expect(cb.onFail).not.toHaveBeenCalled();
    expect(FakeSR.made.at(-1)!.started).toBe(true);
    l.abort();
  });
});

// QA B18 (owner: works after a hard refresh, degrades later): a recogniser that hears speech but returns nothing, and long
// sessions, are replaced by themselves; every guess of the newest result is reported.
describe("degrading sessions (QA B18)", () => {
  const result = (r: FakeSR, alts: string[], final = true) => r.onresult?.({ resultIndex: 0, results: Object.assign([Object.assign(alts.map((t) => ({ transcript: t })), { isFinal: final })], { length: 1 }) });
  test("speech without any result for deafMs: replaced (no failure counted)", () => {
    const { l, cb } = listener(true);
    l.start();
    vi.advanceTimersByTime(10);
    (FakeSR.made[0] as unknown as { onspeechstart?: () => void }).onspeechstart?.();
    vi.advanceTimersByTime(mod.WATCHDOG.deafMs + 2000);
    expect(FakeSR.made.length).toBe(2);
    expect(FakeSR.made[0].aborted).toBe(true);
    expect(cb.onFail).not.toHaveBeenCalled();
    l.abort();
  });
  test("a session older than recycleMs is replaced at a quiet moment", () => {
    const { l } = listener(true);
    l.start();
    for (let t = 0; t < mod.WATCHDOG.recycleMs + 10_000; t += 30_000) { vi.advanceTimersByTime(30_000); FakeSR.made.at(-1)!.onaudiostart?.(); }
    expect(FakeSR.made.length).toBeGreaterThan(1);
    l.abort();
  });
  test("the other guesses (maxAlternatives 5) are passed on", () => {
    const { l, cb } = listener(true);
    l.forget = false;
    l.start();
    vi.advanceTimersByTime(10);
    expect(FakeSR.made[0].maxAlternatives).toBe(5);
    result(FakeSR.made[0], ["hey Jonas", "hey zonov", "hey zone of"]);
    expect(cb.onUpdate).toHaveBeenLastCalledWith({ finalText: "hey Jonas", interim: "", alternatives: ["hey zonov", "hey zone of"] });
    l.abort();
  });
});

// live log 2026-11-02: speechstart, soundstart... but not one result for the first utterance after a start: recreated in 3 s
test("a deaf START (speech heard, no result at all) is recreated after deafFirstMs, not 15 s", () => {
  const { l } = listener(true);
  l.start();
  vi.advanceTimersByTime(10);
  (FakeSR.made[0] as unknown as { onspeechstart?: () => void }).onspeechstart?.();
  vi.advanceTimersByTime(mod.WATCHDOG.deafFirstMs + 1500);
  expect(FakeSR.made.length).toBe(2);
  l.abort();
});
