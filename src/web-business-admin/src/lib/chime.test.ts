import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
import { BELL_SOUND_KEY, bellSoundOn, chime, setBellSound } from "./chime";

describe("counter bell sound switch", () => {
  beforeEach(() => store.clear());
  it("is ON by default (a payment reminder should be heard) and remembers the choice on this device", () => {
    expect(bellSoundOn()).toBe(true);
    setBellSound(false);
    expect(store.get(BELL_SOUND_KEY)).toBe("0");
    expect(bellSoundOn()).toBe(false);
    setBellSound(true);
    expect(bellSoundOn()).toBe(true);
  });
  it("never throws where there is no audio (tests, old browsers): the visual alert still shows", () => {
    expect(() => chime()).not.toThrow();
  });
  it("storage that throws (private mode) leaves the sound on", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(bellSoundOn()).toBe(true);
    expect(() => setBellSound(false)).not.toThrow();
  });
});
