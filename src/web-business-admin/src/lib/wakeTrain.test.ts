import { beforeEach, describe, expect, test, vi } from "vitest";

// Training "Hey Zonov" to one voice (docs/VOICE_QA_REPORT.md B13): learned forms are extra, guarded, capped, resettable.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
const m = await import("./wakeWord");
let clock = Date.parse("2026-11-02T10:00:00Z");
m.setLearnClock(() => clock);
beforeEach(() => { store.clear(); m.reloadLearned(); m.forgetNearMiss(); clock = Date.parse("2026-11-02T10:00:00Z"); });

describe("training", () => {
  test("good samples: forms close to Zonov are learned, and then wake the till", () => {
    expect(m.findWake("hey sanob")).toBeNull(); // two sounds off: not understood out of the box
    const r = m.train(["hey sanob", "Hey Zanob.", "हे ज़ोनोव", "hey jonov", "hey sanob"]);
    expect(r.map((x) => x.accepted)).toEqual([true, true, true, true, true]);
    expect(m.learnedWakes()).toEqual(["sanob"]); // the ones already understood are not stored again
    expect(m.findWake("hey sanob two lassi")).not.toBeNull();
    expect(m.afterWake("hey sanob two lassi")!.rest).toBe("two lassi");
  });
  test("garbage and everyday words are refused; nothing learned", () => {
    const r = m.train(["hello", "two lassi please", "hey sonu", "hey jaanu", "hey zoom", "hey honey", "hey mango", "", "hey"]);
    expect(r.every((x) => !x.accepted)).toBe(true);
    expect(m.learnedWakes()).toEqual([]);
    expect(m.findWake("hey sonu")).toBeNull();
  });
  test("the learned word alone wakes only as the first word of a phrase, like the name itself", () => {
    m.addLearned("sanob");
    expect(m.findWake("sanob two lassi")).not.toBeNull();
    expect(m.findWake("two lassi sanob")).toBeNull();
    expect(m.findWake("hey sanob")).not.toBeNull();
  });
  test("persistence (versioned key), cap at 20, delete, reset; the built-in matcher stays", () => {
    expect(m.addLearned("sanob")).toBeNull();
    expect(JSON.parse(store.get("pos.wakeLearned.v2")!)).toMatchObject({ v: 2, items: [{ w: "sanob", auto: false }] });
    m.reloadLearned();
    expect(m.learnedWakes()).toEqual(["sanob"]);
    for (let i = 0; i < 25; i++) m.addLearned(`sanob${"a".repeat(i % 8)}${i % 3 ? "" : "v"}`);
    expect(m.learnedWakes().length).toBeLessThanOrEqual(m.LEARN_MAX);
    m.removeLearned("sanob");
    expect(m.learnedWakes()).not.toContain("sanob");
    m.resetLearned();
    expect(m.learnedWakes()).toEqual([]);
    expect(m.findWake("hey jonov")).not.toBeNull(); // built in, always
  });
  test("a broken store (private mode, bad JSON) leaves the built-in matcher", () => {
    store.set("pos.wakeLearned.v2", "{not json");
    m.reloadLearned();
    expect(m.learnedWakes()).toEqual([]);
    expect(m.findWake("hey sonov")).not.toBeNull();
  });
  test("a v1 list (manual training before) is still read", () => {
    store.set("pos.wakeLearned.v1", JSON.stringify({ v: 1, words: ["sanob"] }));
    m.reloadLearned();
    expect(m.learnedWakes()).toEqual(["sanob"]);
  });
});

// Auto-learn (owner, 2026-11-02): no prompt; text only, on this device, never sent anywhere.
describe("auto-learn", () => {
  test("a near miss before a voice command that succeeded is learned by itself", () => {
    m.noteNearMiss("hey sanob");
    clock += 20_000;
    expect(m.confirmNearMiss()).toBe("sanob");
    expect(m.learnedEntries()).toMatchObject([{ w: "sanob", auto: true }]);
    expect(m.findWake("hey sanob two lassi")).not.toBeNull();
  });
  test("garbage, everyday words, words already understood and stale near misses are not learned", () => {
    for (const t of ["hey sonu", "hey jaanu", "hey mango", "hello", "two lassi", "hey jonov", "hey"]) { m.noteNearMiss(t); expect(m.confirmNearMiss(), t).toBeNull(); }
    m.noteNearMiss("hey sanob");
    clock += m.AUTO_WINDOW_MS + 1;
    expect(m.confirmNearMiss()).toBeNull();
    expect(m.learnedWakes()).toEqual([]);
  });
  test("at most AUTO_PER_DAY a day", () => {
    for (const w of ["sanob", "sanop", "sanod", "sanok", "sanoc"]) { m.noteNearMiss(`hey ${w}`); m.confirmNearMiss(); clock += 60_000; }
    expect(m.learnedWakes().length).toBe(m.AUTO_PER_DAY);
    clock += 86_400_000;
    m.noteNearMiss("hey sanoc"); expect(m.confirmNearMiss()).toBe("sanoc");
  });
  test("entries a wake has not used for 30 days are dropped; a use keeps them", () => {
    m.addLearned("sanob", true); m.addLearned("sanop", true);
    clock += 20 * 86_400_000;
    expect(m.findWake("hey sanob")).not.toBeNull(); // used: kept
    clock += 15 * 86_400_000;
    m.reloadLearned();
    expect(m.learnedWakes()).toEqual(["sanob"]);
  });
  test("the switch off stops learning", () => {
    m.setAutoLearn(false);
    m.noteNearMiss("hey sanob");
    expect(m.confirmNearMiss()).toBeNull();
    expect(m.learnedWakes()).toEqual([]);
    m.setAutoLearn(true);
    expect(m.autoLearnOn()).toBe(true);
  });
  test("near misses are found only after a greeting and never for everyday words", () => {
    expect(m.nearMiss("hey sanob one lassi")).toBe("sanob");
    expect(m.nearMiss("hey jonov")).toBeNull();
    expect(m.nearMiss("hey sonu")).toBeNull();
    expect(m.nearMiss("sanob")).toBeNull();
  });
});
