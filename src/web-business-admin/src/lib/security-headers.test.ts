import { describe, expect, it } from "vitest";
import { STATIC_HEADERS, apiOrigin, contentSecurityPolicy, hsts, newNonce, originOf } from "./security-headers";

const dir = (csp: string, name: string) => csp.split("; ").find((d) => d.split(" ")[0] === name);

describe("Content-Security-Policy", () => {
  const csp = contentSecurityPolicy({ nonce: "N0nce", api: "http://localhost:8120", https: false });
  it("allows scripts only by nonce: no 'unsafe-inline' or 'unsafe-eval' anywhere in script-src", () => {
    expect(dir(csp, "script-src")).toBe("script-src 'self' 'nonce-N0nce' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  });
  it("style elements need the nonce; only style attributes stay inline", () => {
    expect(dir(csp, "style-src")).toBe("style-src 'self' 'nonce-N0nce'");
    expect(dir(csp, "style-src-elem")).toBe("style-src-elem 'self' 'nonce-N0nce'");
    expect(dir(csp, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
  });
  it("locks down objects, framing, base and forms; lets the API origin through for data and photos", () => {
    for (const d of ["object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"]) expect(csp).toContain(d);
    expect(dir(csp, "connect-src")).toBe("connect-src 'self' http://localhost:8120");
    expect(dir(csp, "img-src")).toContain("http://localhost:8120");
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(contentSecurityPolicy({ nonce: "n", api: "", https: true })).toContain("upgrade-insecure-requests");
  });
  it("nonces are fresh base64 values", () => {
    const a = newNonce(), b = newNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
  it("same-origin API base adds no origin", () => {
    expect(apiOrigin("/api/v1")).toBe("");
    expect(apiOrigin("http://localhost:8000/api/v1")).toBe("http://localhost:8000");
  });
});

describe("other headers", () => {
  it("HSTS only over https, configurable", () => {
    expect(hsts(false, {})).toBeNull();
    expect(hsts(true, {})).toBe("max-age=31536000");
    expect(hsts(true, { HSTS: "off" })).toBeNull();
    expect(hsts(true, { HSTS_MAX_AGE: "600", HSTS_INCLUDE_SUBDOMAINS: "true" })).toBe("max-age=600; includeSubDomains");
  });
  it("static headers: nosniff, no framing, referrer policy, microphone and camera for this site only", () => {
    const h = Object.fromEntries(STATIC_HEADERS.map((x) => [x.key, x.value]));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toContain("microphone=(self)");
    expect(h["Permissions-Policy"]).toContain("camera=(self)");
  });
});

describe("connect-src extras (platform-core onboarding)", () => {
  it("adds the onboarding origin to connect-src only, once", () => {
    const csp = contentSecurityPolicy({ nonce: "n", api: "http://localhost:8120", https: false, connect: [originOf("https://core.example.in/api/v1"), ""] });
    expect(csp).toContain("connect-src 'self' http://localhost:8120 https://core.example.in");
    expect(csp).not.toMatch(/img-src[^;]*core\.example\.in/);
    expect(originOf(undefined)).toBe("");
    expect(originOf("/relative")).toBe("");
  });
});
