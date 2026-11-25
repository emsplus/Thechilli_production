import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isFullBleed, isKnownRoute, KNOWN_ROUTES } from "./routes";

const APP = path.resolve(import.meta.dirname, "../../app");

describe("shell routes", () => {
  it("KNOWN_ROUTES is exactly the app's pages (a new page must be added, or it would show as 404 chrome)", () => {
    const pages = readdirSync(APP, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(path.join(APP, d.name, "page.tsx")))
      .map((d) => `/${d.name}`);
    expect([...KNOWN_ROUTES].sort()).toEqual(["/", ...pages].sort());
  });
  it("unknown paths and deeper paths are not pages", () => {
    expect(isKnownRoute("/pos")).toBe(true);
    expect(isKnownRoute("/pos/")).toBe(true);
    expect(isKnownRoute("/this-page-does-not-exist")).toBe(false);
    expect(isKnownRoute("/pos/extra")).toBe(false);
  });
  it("only the counter screens are full width", () => {
    expect(isFullBleed("/pos")).toBe(true);
    expect(isFullBleed("/kitchen")).toBe(true);
    expect(isFullBleed("/reports")).toBe(false);
  });
});
