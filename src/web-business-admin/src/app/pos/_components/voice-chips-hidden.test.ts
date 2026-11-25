import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./VoiceOrder.tsx", import.meta.url), "utf8");

describe("voice status chips are hidden from staff (owner 2026-11-13), except the Mic on/off switch (owner 2026-11-21)", () => {
  it("the Direct mode chip and Mic debug render only behind the developer flag; the hands-free switch is always shown", () => {
    expect(src).toContain('const SHOW_CHIPS_KEY = "chilli.showVoiceChips"');
    expect(src).toMatch(/\{\(\s*<button[^>]*data-testid="hands-free"/);
    expect(src).not.toMatch(/\{showVoiceChips && \(\s*<button[^>]*data-testid="hands-free"/);
    expect(src).toMatch(/\{showVoiceChips && directActive && <span data-testid="direct-mode"/);
    expect(src).toMatch(/\{showVoiceChips && <MicDebug /);
  });
  it("the flag defaults to hidden (state starts false)", () => {
    expect(src).toMatch(/function useShowVoiceChips\(\): boolean \{\s*const \[on, setOn\] = useState\(false\)/);
  });
});
