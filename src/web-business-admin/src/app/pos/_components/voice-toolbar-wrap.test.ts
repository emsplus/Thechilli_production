import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// QA break-ui D01: with the mic unavailable the voice chips (Reset, Mic debug, Direct mode) used to push past the menu column, squeeze the
// search box to 0 px and overlap the order panel. The search row and the voice group must wrap. (Visual check: docs/testing/BREAK_UI_REPORT.md)
describe("search + voice toolbar wraps instead of overflowing", () => {
  const menu = readFileSync(join(__dirname, "MenuPanel.tsx"), "utf8");
  const voice = readFileSync(join(__dirname, "VoiceOrder.tsx"), "utf8");
  it("search row wraps and search keeps a minimum width", () => {
    expect(menu).toContain('<div className="flex flex-wrap gap-2">');
    expect(menu).toContain('className="relative min-w-[11rem] flex-1"');
  });
  it("the voice group wraps inside the column", () => {
    expect(voice).toContain('className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5"');
  });
});
