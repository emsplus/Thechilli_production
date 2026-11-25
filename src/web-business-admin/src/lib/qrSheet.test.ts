import { describe, expect, it } from "vitest";
import { A4_PT, CAPTION, a4Pixels, cardRects, deflate, paginate, pdfFromImages, rgbOf } from "./qrSheet";

const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

describe("A4 layout", () => {
  it("is A4 portrait at the chosen resolution", () => {
    expect(a4Pixels(200)).toEqual({ w: 1654, h: 2339 });
    expect(a4Pixels(72).w / a4Pixels(72).h).toBeCloseTo(A4_PT.w / A4_PT.h, 2);
  });
  it("puts 4 equal cards inside the page with margins and gaps, none overlapping", () => {
    const { w, h } = a4Pixels(200);
    const r = cardRects(w, h);
    expect(r).toHaveLength(4);
    for (const c of r) {
      expect(c.x).toBeGreaterThan(0); expect(c.y).toBeGreaterThan(0);
      expect(c.x + c.w).toBeLessThan(w); expect(c.y + c.h).toBeLessThan(h);
      expect(c.w).toBe(r[0].w); expect(c.h).toBe(r[0].h);
    }
    expect(r[1].x).toBeGreaterThan(r[0].x + r[0].w);
    expect(r[2].y).toBeGreaterThan(r[0].y + r[0].h);
    // A card is big enough for a QR of about 6 cm (A4 is 21 cm wide).
    expect((r[0].w / w) * 21).toBeGreaterThan(9);
  });
  it("paginates cards 4 per page", () => {
    expect(paginate([1, 2, 3, 4, 5, 6, 7, 8, 9]).map((p) => p.length)).toEqual([4, 4, 1]);
    expect(paginate([])).toEqual([]);
  });
  it("captions say what the code does (no product name other than Chilli Agent)", () => {
    expect(CAPTION).toEqual({ menu: "Scan to see our menu", review: "Scan to rate your visit" });
    expect(Object.values(CAPTION).join(" ")).not.toMatch(/\bPOS\b/);
  });
});

describe("pdfFromImages", () => {
  it("writes a PDF whose cross-reference table points at every object", async () => {
    const rgb = rgbOf(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]));
    expect(Array.from(rgb)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const data = await deflate(rgb);
    const pdf = pdfFromImages([{ width: 2, height: 2, data }, { width: 2, height: 2, data }], "Menu QR (T1)");
    const s = text(pdf);
    expect(s.startsWith("%PDF-1.4\n")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).toContain("/Type /Pages /Kids [4 0 R 7 0 R] /Count 2");
    expect(s).toContain("/MediaBox [0 0 595.28 841.89]");
    expect(s).toContain("/Title (Menu QR \\(T1\\))");
    expect(s).toContain("/Producer (Chilli Agent)");
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
    expect(s.slice(startxref, startxref + 4)).toBe("xref");
    const rows = s.slice(startxref).split("\n").slice(3).filter((l) => / 00000 n $/.test(l));
    expect(rows).toHaveLength(9); // objects 1..9 (catalog, pages, info, 2 x page/content/image)
    rows.forEach((row, i) => { const off = Number(row.slice(0, 10)); expect(s.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`); });
    // The image stream is exactly the compressed pixels and inflates back to them.
    const at = s.indexOf("/Subtype /Image");
    const start = s.indexOf("stream\n", at) + 7;
    const length = Number(/\/Length (\d+)/.exec(s.slice(at))![1]);
    expect(Array.from(await inflate(pdf.slice(start, start + length)))).toEqual(Array.from(rgb));
  });
  it("keeps the title ASCII and escaped", () => {
    const s = text(pdfFromImages([], "टेबल (1) \\ x"));
    expect(s).toContain("/Title (???? \\(1\\) \\\\ x)");
    expect(s).toContain("/Count 0");
  });
});
