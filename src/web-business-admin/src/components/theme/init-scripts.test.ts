import { describe, expect, it } from "vitest";
import { resolveTheme } from "@chilli/tokens";
import { THEME_INIT_SCRIPT, THEME_KEY } from "./init-scripts";

/** Runs the inline pre-paint script against a fake document/localStorage. */
function run(stored: string | null, opts: { throwing?: boolean } = {}) {
  const store = new Map<string, string>(stored === null ? [] : [[THEME_KEY, stored]]);
  const attrs = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => { if (opts.throwing) throw new Error("blocked"); return store.get(k) ?? null; },
    removeItem: (k: string) => { if (opts.throwing) throw new Error("blocked"); store.delete(k); },
  };
  const document = { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) } };
  new Function("localStorage", "document", THEME_INIT_SCRIPT)(localStorage, document);
  return { store, attrs };
}

describe("light theme only: no-flash script", () => {
  it.each(["dark", "light", "system", "garbage", null])("saved %s: html gets data-theme=light and the saved value is forgotten", (saved) => {
    const { store, attrs } = run(saved);
    expect(attrs.get("data-theme")).toBe("light");
    expect(store.has(THEME_KEY)).toBe(false);
  });
  it("never applies dark, even when storage throws (private mode)", () => {
    expect(run("dark", { throwing: true }).attrs.get("data-theme")).toBe("light");
  });
  it("the script text can not mention a dark theme value", () => {
    expect(THEME_INIT_SCRIPT).not.toMatch(/dark/);
  });
});

describe("light theme only: resolver", () => {
  it("always resolves light, for every stored preference and OS setting", () => {
    for (const pref of ["dark", "light", "system", null, undefined] as const) for (const os of [true, false]) expect(resolveTheme(pref, os)).toBe("light");
  });
});
