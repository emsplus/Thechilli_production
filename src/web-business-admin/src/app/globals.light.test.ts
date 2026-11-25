import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Light theme only (owner decision 2026-11-01): the app stylesheet carries no dark-theme selectors, and the light rules that
 *  sat next to the removed dead ones (.qr-plate) are unchanged. */
const css = fs.readFileSync(path.resolve(import.meta.dirname, "globals.css"), "utf8");

describe("globals.css is light only", () => {
  it("has no dark media query and no data-theme=dark selector", () => {
    expect(css).not.toMatch(/prefers-color-scheme:\s*dark/);
    expect(css).not.toMatch(/data-theme=["']?dark/);
  });
  it("keeps the light QR plate (dark modules on a light plate)", () => {
    expect(css).toContain(".qr-plate { background: var(--c-on-ink); fill: var(--c-ink); }");
  });
});
