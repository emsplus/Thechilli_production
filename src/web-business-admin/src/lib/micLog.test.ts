import { beforeEach, describe, expect, test, vi } from "vitest";
import { clearMicLog, formatLine, micLines, micLog, micLogText, MIC_LOG_MAX, micTranscript, setMicLogClock } from "./micLog";
import { explainWake } from "./wakeWord";

let clock = Date.parse("2026-11-02T10:00:00Z");
setMicLogClock(() => clock);
beforeEach(() => { vi.useFakeTimers(); clearMicLog(); });

describe("mic debug log (testing phase)", () => {
  test("a ring buffer of MIC_LOG_MAX lines, newest last", () => {
    for (let i = 0; i < MIC_LOG_MAX + 30; i++) micLog("event", `e${i}`);
    expect(micLines()).toHaveLength(MIC_LOG_MAX);
    expect(micLines().at(-1)!.text).toBe(`e${MIC_LOG_MAX + 29}`);
    expect(micLines()[0].text).toBe("e30");
  });
  test("interims are throttled to about 5 a second; the newest of a burst is kept; finals are never dropped", () => {
    for (let i = 0; i < 20; i++) { micTranscript(`hey zo ${i}`, false); clock += 10; }
    micTranscript("hey zonov", true, 0.91);
    const lines = micLines();
    expect(lines.filter((l) => l.kind === "interim").length).toBeLessThanOrEqual(2);
    expect(lines.filter((l) => l.kind === "interim").at(-1)!.text).toBe("interim: “hey zo 19”");
    expect(lines.at(-1)).toMatchObject({ kind: "final", text: "final: “hey zonov” (confidence 0.91)" });
  });
  test("plain-text format for Copy / Download", () => {
    micLog("error", "error network");
    const txt = micLogText("header line");
    expect(txt.split("\n")[0]).toBe("header line");
    expect(formatLine(micLines()[0])).toMatch(/^\d\d:\d\d:\d\d\.\d{3} ERROR   error network$/);
  });
  test("wake decisions in words", () => {
    expect(explainWake("hey jonov one lassi")).toMatch(/^WAKE matched \(sensitivity normal, heard “hey jonov”, key=ZANAV, distance=0\)$/);
    expect(explainWake("two lassi")).toBe("no wake: no greeting (hey / hi / ok / a ...) before a name");
    expect(explainWake("hey")).toMatch(/no name after it yet/);
    expect(explainWake("hey sonu")).toMatch(/everyday word/);
    expect(explainWake("hey zebra")).toMatch(/^no wake: “hey zebra” key=ZABRA distance=\d/);
  });
});
