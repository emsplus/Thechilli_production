import { describe, expect, it } from "vitest";
import { injectedStyleHashes, sha256, sonnerCss } from "./csp-style-hashes";

describe("CSP hashes for library-injected styles", () => {
  it("finds sonner's stylesheet and hashes it (plus the empty <style> it appends first)", () => {
    const h = injectedStyleHashes();
    expect(h[0]).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
    expect(h[1]).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
  });
  it("decodes the JS string literal exactly", () => {
    expect(sonnerCss('x;__insertCSS("[a]{b:\\"c\\"}");y')).toBe('[a]{b:"c"}');
    expect(sha256("")).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
    expect(() => sonnerCss("nothing here")).toThrow(/sonner/);
  });
});
