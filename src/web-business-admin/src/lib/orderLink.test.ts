import { describe, expect, it } from "vitest";
import { BRAND_COLOR_ERROR, brandColorCheck, canNativeShare, isBrandColor, linkFailure, linkView, normalizeBrandColor, qrFileName, qrSvgMarkup, whatsappShareUrl } from "./orderLink";

const SETTINGS = { enabled: true, accept_before_kot: false, delivery_fee: "0.00", free_delivery_above: null, min_order: "0.00", radius_km: null, hours: null, webhook_url: null, has_webhook_secret: false };

describe("linkView", () => {
  it("is legacy on a server without the switch", () => {
    expect(linkView({})).toBe("legacy");
    expect(linkView({ public_order_url: "https://order.thechilli.ai/r/abc" })).toBe("legacy");
  });
  it("follows the switch and the URL", () => {
    expect(linkView({ public_order_enabled: false, public_order_url: null })).toBe("off");
    expect(linkView({ public_order_enabled: true, public_order_url: "https://order.thechilli.ai/r/abc123" })).toBe("on");
    expect(linkView({ public_order_enabled: true, public_order_url: null })).toBe("on_no_url");
    expect(linkView({ public_order_enabled: true, public_order_url: "javascript:alert(1)" })).toBe("on_no_url");
  });
});

describe("linkFailure", () => {
  it("502 carries the saved settings and the plain sentence", () => {
    const f = linkFailure({ status: 502, code: "delivery_service_unavailable", message: "We could not reach the online ordering service, so the link was not changed. Your other settings were saved. Please try again in a minute.", data: { settings: { ...SETTINGS, min_order: "150.00", webhook_secret: "s3cret" } } });
    expect(f.kind).toBe("unavailable");
    expect(f.message).toContain("Please try again in a minute");
    expect(f.settings?.min_order).toBe("150.00");
    expect(f.settings?.webhook_secret).toBe("s3cret");
  });
  it("502 'not connected' and 'does not know this restaurant' are the empty state", () => {
    expect(linkFailure({ status: 502, code: "delivery_service_unavailable", message: "The online ordering link is not connected yet, so it could not be changed." }).kind).toBe("not_connected");
    expect(linkFailure({ status: 502, code: "delivery_service_unavailable", message: "The online ordering service does not know this restaurant yet" }).kind).toBe("not_connected");
  });
  it("502 without a settings object has none", () => {
    expect(linkFailure({ status: 502, code: "delivery_service_unavailable", message: "x", data: { settings: [1] } }).settings).toBeUndefined();
    expect(linkFailure({ status: 502, code: "delivery_service_unavailable", message: "x" }).settings).toBeUndefined();
  });
  it("409 public_order_link_off is the off message (not the server text)", () => {
    const f = linkFailure({ status: 409, code: "public_order_link_off", message: "Turn the online ordering link on first, then you can make a new link or change its colour." });
    expect(f.kind).toBe("off");
    expect(f.message).toMatch(/link is off/i);
  });
  it("offline, validation and unknown errors", () => {
    expect(linkFailure({ status: 0, message: "Cannot reach server" }).kind).toBe("offline");
    expect(linkFailure({ status: 422, code: "x", message: "bad colour" })).toEqual({ kind: "other", message: "bad colour" });
    expect(linkFailure(new Error("boom")).kind).toBe("other");
    expect(linkFailure(undefined).message.length).toBeGreaterThan(5);
    expect(linkFailure({ status: 409, code: "something_else", message: "m" }).kind).toBe("other");
  });
});

describe("share", () => {
  it("builds the WhatsApp link with the text and the URL encoded", () => {
    const u = whatsappShareUrl("https://order.thechilli.ai/r/abc?x=1&y=2");
    expect(u.startsWith("https://wa.me/?text=")).toBe(true);
    expect(decodeURIComponent(u.slice("https://wa.me/?text=".length))).toBe("Order from us online: https://order.thechilli.ai/r/abc?x=1&y=2");
    expect(u).not.toContain(" ");
  });
  it("detects the Web Share API", () => {
    expect(canNativeShare({ share: () => Promise.resolve() })).toBe(true);
    expect(canNativeShare({})).toBe(false);
    expect(canNativeShare(undefined)).toBe(false);
  });
});

describe("brand colour", () => {
  it("validates #RRGGBB only", () => {
    for (const ok of ["#0B6E4F", "#000000", "#ffffff"]) expect(isBrandColor(ok)).toBe(true);
    for (const bad of ["", "0B6E4F", "#0B6E4", "#0B6E4FF", "#GGGGGG", "red", "#0b6e4f "]) expect(isBrandColor(bad)).toBe(false);
    expect(BRAND_COLOR_ERROR).toContain("#");
  });
  it("normalises what people type", () => {
    expect(normalizeBrandColor(" 0b6e4f ")).toBe("#0B6E4F");
    expect(normalizeBrandColor("#0b6e4f")).toBe("#0B6E4F");
    expect(normalizeBrandColor("#abc")).toBe("#abc");
    expect(normalizeBrandColor("")).toBe("");
  });
  it("empty and invalid have no preview", () => {
    expect(brandColorCheck("").state).toBe("empty");
    expect(brandColorCheck("#12").state).toBe("invalid");
  });
  it("a dark green: white label, passes AA", () => {
    const c = brandColorCheck("#0B6E4F");
    expect(c.state).toBe("ok");
    expect(c.hex).toBe("#0B6E4F");
    expect(c.label?.toLowerCase()).toBe("#ffffff");
    expect(c.labelRatio).toBeGreaterThanOrEqual(4.5);
    expect(c.warning).toBeNull(); // a good label; on the dark surface the page only nudges it as text
    expect(c.note).toMatch(/little darker or lighter/);
  });
  it("a bright yellow: dark label, passes AA, but it is nudged where it is text", () => {
    const c = brandColorCheck("#FFD60A");
    expect(c.label).toBe("#111820");
    expect(c.labelRatio).toBeGreaterThanOrEqual(4.5);
    expect(c.warning).toBeNull();
    expect(c.note).toMatch(/little darker or lighter/);
  });
  it("a mid grey fails AA for labels in both directions and says so with the ratio", () => {
    const c = brandColorCheck("#797979");
    expect(c.state).toBe("ok");
    expect(c.labelRatio).toBeLessThan(4.5);
    expect(c.warning).toMatch(/hard to read \(\d\.\d:1/);
  });
});

describe("QR download", () => {
  it("makes a standalone SVG with the link as title and token colours only", () => {
    const svg = qrSvgMarkup("https://order.thechilli.ai/r/k3f9x2qd7mwa?a=1&b=2");
    expect(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\"")).toBe(true);
    expect(svg).toContain("<title>https://order.thechilli.ai/r/k3f9x2qd7mwa?a=1&amp;b=2</title>");
    expect(svg).toMatch(/<rect [^>]*fill="#FFFFFF"/i);
    expect(svg).toMatch(/<path d="M[^"]+" fill="#111820"/);
  });
  it("names the file from the slug", () => {
    expect(qrFileName("https://order.thechilli.ai/r/k3f9x2qd7mwa", "png")).toBe("ordering-link-qr-k3f9x2qd7mwa.png");
    expect(qrFileName("https://example.in/order", "svg")).toBe("ordering-link-qr.svg");
  });
});
