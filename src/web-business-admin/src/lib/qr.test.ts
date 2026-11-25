import { describe, expect, it } from "vitest";
import { qrMatrix, qrPath } from "./qr";

// Decoding was verified against Apple Vision (VNDetectBarcodesRequest) for versions 1, 2, 5, 7, 8 and 9; these checks keep the
// structure from regressing.
const finderAt = (m: boolean[][], x0: number, y0: number) => {
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
    if (m[y0 + y][x0 + x] !== (d !== 2)) return false;
  }
  return true;
};

describe("QR encoder (byte mode, level M)", () => {
  it("picks the smallest version: 21 modules for a short text, larger for a link", () => {
    expect(qrMatrix("HELLO")).toHaveLength(21);
    expect(qrMatrix("https://order.thechilli.ai/r/3f1c2a9e-1b7d-4c55-9f00-1234567890ab")).toHaveLength(37); // version 5
  });
  it("draws the three finder patterns, the timing lines and the dark module", () => {
    const m = qrMatrix("https://example.in/order");
    const n = m.length;
    expect(finderAt(m, 0, 0) && finderAt(m, n - 7, 0) && finderAt(m, 0, n - 7)).toBe(true);
    for (let i = 8; i < n - 8; i++) { expect(m[6][i]).toBe(i % 2 === 0); expect(m[i][6]).toBe(i % 2 === 0); }
    expect(m[n - 8][8]).toBe(true);
  });
  it("is deterministic, handles UTF-8 and refuses text that does not fit", () => {
    expect(qrMatrix("₹ 250")).toEqual(qrMatrix("₹ 250"));
    expect(() => qrMatrix("x".repeat(300))).toThrow();
  });
  it("renders one path square per dark module with a quiet zone", () => {
    const m = qrMatrix("A");
    const dark = m.flat().filter(Boolean).length;
    expect(qrPath(m).split("M").length - 1).toBe(dark);
    expect(qrPath(m)).toMatch(/^M4 4h1v1h-1z/);
  });
});
