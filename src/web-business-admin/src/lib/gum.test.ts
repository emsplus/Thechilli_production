import { afterEach, describe, expect, it, vi } from "vitest";
import { getUserMediaQueued } from "./gum";

describe("getUserMediaQueued", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("never has two requests open at once, and a refusal does not block the next one", async () => {
    let open = 0, maxOpen = 0; const order: string[] = [];
    const gum = vi.fn(async (c: MediaStreamConstraints) => {
      open++; maxOpen = Math.max(maxOpen, open); order.push(c.audio ? "audio" : "video");
      await new Promise((r) => setTimeout(r, 5)); open--;
      if (c.video) throw new DOMException("no", "NotAllowedError");
      return {} as MediaStream;
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: gum } });
    const r = await Promise.allSettled([getUserMediaQueued({ audio: true }), getUserMediaQueued({ video: true }), getUserMediaQueued({ audio: true })]);
    expect(maxOpen).toBe(1);
    expect(order).toEqual(["audio", "video", "audio"]);
    expect(r.map((x) => x.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});
