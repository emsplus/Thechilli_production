import { describe, expect, test } from "vitest";
import { countdownSeconds, countdownText, holdText, intentFor, intentStep, pickDefault, saysStop } from "./voiceFlow";

// docs/VOICE_QA_REPORT.md: the spoken intents of the voice sheet (owner rules 2026-11).
describe("intents are queued, never dropped (QA bug B1, hypothesis a)", () => {
  test("waits while the server reads the order, an AI pass runs, an add is saving or a countdown runs", () => {
    for (const s of [{ stage: "busy" }, { stage: "confirm", improving: true }, { stage: "confirm", saving: true }, { stage: "recording" }, { stage: "countdown", counting: true }])
      expect(intentStep({ improving: false, saving: false, counting: false, ...s }), JSON.stringify(s)).toBe("wait");
  });
  test("runs on a ready sheet (live or confirm), is dropped once the sheet closed", () => {
    expect(intentStep({ stage: "confirm", improving: false, saving: false, counting: false })).toBe("run");
    expect(intentStep({ stage: "live", improving: false, saving: false, counting: false })).toBe("run");
    expect(intentStep({ stage: "closed", improving: true, saving: false, counting: false })).toBe("drop");
  });
});

describe("what each spoken ending does", () => {
  test("done and add to order only add; place order and send to kitchen add + place + kitchen ticket", () => {
    expect(intentFor(null, true)).toMatchObject({ kind: "add" });
    expect(intentFor("place", false)).toMatchObject({ kind: "go", from: "place" });
    expect(intentFor("kot", false)).toMatchObject({ kind: "go", from: "kot" });
  });
  test("cancel keeps its question; a command wins over done said with it", () => {
    expect(intentFor("clear", false)).toMatchObject({ kind: "clear" });
    expect(intentFor("place", true)).toMatchObject({ kind: "go", from: "place" });
    expect(intentFor(null, false)).toBeNull();
    expect(intentFor(null, true)!.id).not.toBe(intentFor(null, true)!.id);
  });
  test("countdown: the device setting, 5 s when a dish has a Check marker, 0 = at once", () => {
    expect(countdownSeconds(3, 0)).toBe(3);
    expect(countdownSeconds(3, 2)).toBe(5);
    expect(countdownSeconds(8, 1)).toBe(8);
    expect(countdownSeconds(0, 2)).toBe(0);
  });
  test("the countdown line and the hold line", () => {
    expect(countdownText("kot", 3, 3, true)).toBe("Sending to the kitchen in 3, 2, 1. Say “stop” or tap Cancel.");
    expect(countdownText("place", 1.2, 3, true)).toBe("Placing the order in 2, 1. Say “stop” or tap Cancel.");
    expect(countdownText("kot", 4.5, 5, false)).toBe("Sending to the kitchen in 5, 4, 3, 2, 1. Tap Cancel to stop it.");
    expect(holdText("kot", "choose how to add to table T4")).toBe("Not sent to the kitchen yet: choose how to add to table T4 first.");
  });
});

describe("stop words during the countdown", () => {
  test.each(["stop", "Stop!", "cancel", "ruko", "ruk jao", "nahi", "nahin", "no no", "wait", "mat karo", "रुको", "नहीं"])("%j stops it", (t) => { expect(saysStop(t)).toBe(true); });
  test.each(["", ".", "place order", "send to kitchen", "two lassi", "now"])("%j does not", (t) => { expect(saysStop(t)).toBe(false); });
});

describe("a default when several dishes fit (never a block)", () => {
  const names: Record<string, string> = { cb: "Chicken Biryani", mb: "Mutton Biryani", sl: "Sweet Lassi", ml: "Mango Lassi", bn: "Butter Naan", gn: "Garlic Naan", n: "Naan" };
  const order = ["sl", "ml", "bn", "gn", "n", "mb", "cb"];
  const menu = (o: Partial<Parameters<typeof pickDefault>[2]> = {}) => ({ order: (id: string) => order.indexOf(id), name: (id: string) => names[id], soldOut: () => false, ...o });
  test("menu order when nothing else decides", () => { expect(pickDefault(["cb", "mb"], "ek biryani", menu())).toBe("mb"); });
  test("the full name said wins over menu order ('naan' -> Naan, not Butter Naan)", () => { expect(pickDefault(["bn", "gn", "n"], "two naan", menu())).toBe("n"); });
  test("a dish whose name starts with the first word said ('mango' -> Mango Lassi)", () => { expect(pickDefault(["sl", "ml"], "mango", menu())).toBe("ml"); });
  test("a taught alias wins", () => { expect(pickDefault(["sl", "ml"], "lassi", menu({ alias: (h) => (h === "lassi" ? "ml" : null) }))).toBe("ml"); });
  test("more orders win over the name and menu order", () => { expect(pickDefault(["cb", "mb"], "biryani", menu({ popularity: (id) => (id === "cb" ? 9 : 1) }))).toBe("cb"); });
  test("never a sold-out dish when another fits", () => { expect(pickDefault(["mb", "cb"], "biryani", menu({ soldOut: (id) => id === "mb" }))).toBe("cb"); });
});
