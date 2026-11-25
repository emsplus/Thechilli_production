import { describe, expect, it, vi } from "vitest";
import { notifyKitchenChanged, onKitchenChanged } from "./kitchenSignal";

describe("kitchen signal", () => {
  it("a bill made at the counter reloads the kitchen board", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const fn = vi.fn();
    const off = onKitchenChanged(fn);
    notifyKitchenChanged();
    expect(fn).toHaveBeenCalledTimes(1);
    off(); notifyKitchenChanged();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
