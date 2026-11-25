import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { isStepUpCancelled, registerStepUpPrompt, withStepUp } from "./stepUpPrompt";

const required = () => new ApiError(403, "Re-enter your PIN to void a bill (step-up required)");
let off: (() => void) | null = null;
afterEach(() => { off?.(); off = null; });

describe("withStepUp", () => {
  it("passes a normal answer and other errors straight through without asking", async () => {
    const ask = vi.fn(async () => true);
    off = registerStepUpPrompt(ask);
    await expect(withStepUp(async () => 7, "x")).resolves.toBe(7);
    await expect(withStepUp(async () => { throw new ApiError(403, "Not allowed"); }, "x")).rejects.toThrow("Not allowed");
    expect(ask).not.toHaveBeenCalled();
  });
  it("asks for the PIN on step-up-required and retries once", async () => {
    const ask = vi.fn(async () => true);
    off = registerStepUpPrompt(ask);
    const run = vi.fn().mockRejectedValueOnce(required()).mockResolvedValueOnce("voided");
    await expect(withStepUp(run, "void this bill")).resolves.toBe("voided");
    expect(ask).toHaveBeenCalledWith("void this bill");
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("cancelled -> step_up_cancelled, and the request is not retried", async () => {
    off = registerStepUpPrompt(async () => false);
    const run = vi.fn().mockRejectedValue(required());
    const e = await withStepUp(run, "give this discount").catch((x) => x);
    expect(isStepUpCancelled(e)).toBe(true);
    expect((e as Error).message).toBe("Your PIN is needed to give this discount.");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("without a mounted dialog the original error is thrown", async () => {
    await expect(withStepUp(async () => { throw required(); }, "x")).rejects.toThrow(/step-up required/);
  });
  it("an unregistered dialog does not unregister a newer one", async () => {
    const a = registerStepUpPrompt(async () => false);
    off = registerStepUpPrompt(async () => true);
    a();
    const run = vi.fn().mockRejectedValueOnce(required()).mockResolvedValueOnce(1);
    await expect(withStepUp(run, "x")).resolves.toBe(1);
  });
});
