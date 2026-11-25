import { describe, expect, it, vi } from "vitest";
import { clearShared, fetchShared, setShared } from "./query";

describe("shared query cache", () => {
  it("dedups concurrent requests: 25 callers, one request", async () => {
    clearShared();
    const fn = vi.fn(() => new Promise<string>((r) => setTimeout(() => r("v"), 5)));
    const all = await Promise.all(Array.from({ length: 25 }, () => fetchShared("k", fn, 30_000)));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(new Set(all)).toEqual(new Set(["v"]));
  });

  it("serves a fresh value from cache and refetches once stale", async () => {
    clearShared();
    const fn = vi.fn(async () => 1);
    await fetchShared("k", fn, 30_000, 0);
    await fetchShared("k", fn, 30_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await fetchShared("k", fn, 0);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure on its own; the next explicit call asks again", async () => {
    clearShared();
    const fn = vi.fn(async () => { throw new Error("404"); });
    await expect(fetchShared("k", fn, 30_000)).rejects.toThrow("404");
    await new Promise((r) => setTimeout(r, 20));
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(fetchShared("k", fn, 30_000)).rejects.toThrow("404"); // errors are never served from cache
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a mutation result replaces the cached value without a request", async () => {
    clearShared();
    const fn = vi.fn(async () => "old");
    await fetchShared("k", fn, 30_000);
    setShared("k", "new");
    expect(await fetchShared("k", fn, 30_000)).toBe("new");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
