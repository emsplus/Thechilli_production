import { beforeEach, describe, expect, test, vi } from "vitest";

// Testing-phase "share what the mic heard" (docs/VOICE_QA_REPORT.md B16): text only, server-switched, batched, stoppable.
const store = new Map<string, string>();
const sess = new Map<string, string>();
vi.stubGlobal("sessionStorage", { getItem: (k: string) => sess.get(k) ?? null, setItem: (k: string, v: string) => { sess.set(k, v); }, removeItem: (k: string) => { sess.delete(k); } });
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
const s = await import("./voiceShare");
const w = await import("./wakeWord");

let clock = 1_000_000;
const posts: { samples: { heard: string; matched: boolean; kind: string; device: string }[] }[] = [];
let config: unknown = { share_samples: true, variants: [] };
let postError: { status: number } | null = null;
let getError: { status: number } | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  store.clear(); posts.length = 0; clock = 1_000_000; postError = null; getError = null; config = { share_samples: true, variants: [] };
  s.resetShare();
  s.setShareTransport({
    get: async () => { if (getError) throw getError; return config as { share_samples: boolean; variants: string[] }; },
    post: async (b) => { if (postError) throw postError; posts.push(JSON.parse(JSON.stringify(b))); },
  }, () => clock);
});
const tick = async (ms: number) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); };

describe("flag off (production default)", () => {
  test("no sample request, no notice", async () => {
    config = { share_samples: false, variants: [] };
    await s.refreshWakeConfig();
    s.shareSample("hey zonov one lassi", true, "wake");
    await tick(120_000);
    expect(posts).toEqual([]);
    expect(s.shareOffered()).toBe(false);
  });
  test("a config that cannot be read counts as off", async () => {
    getError = { status: 500 };
    await s.refreshWakeConfig();
    s.shareSample("hey zonov", true, "wake");
    await tick(120_000);
    expect(posts).toEqual([]);
  });
});

describe("flag on (testing phase)", () => {
  test("batched, text only, digits stripped, 120 characters, at most one call a minute", async () => {
    await s.refreshWakeConfig();
    expect(s.shareOffered()).toBe(true);
    s.shareSample("hey jonov, name Raj number 98765 43210", false, "wake");
    s.shareSample("x".repeat(300), true, "command");
    await tick(10);
    expect(posts).toHaveLength(1);
    expect(posts[0].samples[0]).toMatchObject({ heard: "hey jonov, name Raj number", matched: false, kind: "wake" });
    expect(posts[0].samples[0].device).toMatch(/^dev-/);
    expect(posts[0].samples[1].heard).toHaveLength(120);
    expect(Object.keys(posts[0].samples[0]).sort()).toEqual(["device", "heard", "kind", "matched"]);
    for (let i = 0; i < 80; i++) s.shareSample(`hey zonov ${i} lassi`, true, "wake");
    await tick(30_000);
    expect(posts).toHaveLength(1); // the minute is not over
    await tick(31_000);
    expect(posts).toHaveLength(2);
    expect(posts[1].samples.length).toBeLessThanOrEqual(s.SHARE_MAX_BATCH);
  });
  test("the switch off stops sending (and drops the queue)", async () => {
    await s.refreshWakeConfig();
    s.setShareSwitch(false);
    s.shareSample("hey zonov", true, "wake");
    await tick(120_000);
    expect(posts).toEqual([]);
  });
  test("403 stops sending for the page; a failed batch is not retried", async () => {
    await s.refreshWakeConfig();
    postError = { status: 500 };
    s.shareSample("hey zonov", true, "wake");
    await tick(10);
    expect(posts).toEqual([]);
    expect(s.pendingSamples()).toEqual([]); // dropped, no retry storm
    postError = { status: 403 };
    await tick(61_000);
    s.shareSample("hey zonov again", true, "wake");
    await tick(61_000);
    expect(s.shareOffered()).toBe(false);
    postError = null;
    s.shareSample("hey zonov more", true, "wake");
    await tick(120_000);
    expect(posts).toEqual([]);
  });
  test("server variants pass the same guard rails and never replace the built-in matcher", async () => {
    config = { share_samples: true, variants: ["zanob", "sonu", "hello", "pizza", 42] };
    await s.refreshWakeConfig();
    expect(w.serverWakeForms()).toEqual(["zanob"]);
    expect(w.findWake("hey zanob")).not.toBeNull();
    expect(w.findWake("hey sonu")).toBeNull();
    expect(w.findWake("hey jonov")).not.toBeNull();
  });
});

describe("wake-config is read once per session (QA B18)", () => {
  test("a second refresh (re-mount, reload) uses the cache; a 404 is remembered; after 6 h it asks again", async () => {
    let gets = 0;
    s.setShareTransport({ get: async () => { gets++; throw { status: 404 }; }, post: async () => {} }, () => clock);
    await s.refreshWakeConfig();
    await s.refreshWakeConfig();
    s.resetShareMemoryOnly();
    await s.refreshWakeConfig();
    expect(gets).toBe(1);
    expect(s.shareOffered()).toBe(false);
    clock += s.SHARE_CONFIG_EVERY_MS + 1;
    s.resetShareMemoryOnly();
    await s.refreshWakeConfig();
    expect(gets).toBe(2);
  });
});
