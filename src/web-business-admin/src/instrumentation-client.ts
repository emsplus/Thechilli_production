import { z } from "zod";

// Runs before any app code on the client. zod 4 probes `new Function("")` to speed up parsing; the Content-Security-Policy
// forbids eval (src/proxy.ts), so the probe only produced a violation report. jitless = the same validation, no probe.
z.config({ jitless: true });

// Libraries that inject <style> at run time (Radix dialogs lock scrolling through react-remove-scroll) put this nonce on
// it when the bundler global `__webpack_nonce__` is set; without it the CSP blocks their style. The value is this
// page's nonce, read from a script Next.js stamped (scripts can read it anyway; injected markup cannot).
const pageNonce = typeof document === "undefined" ? undefined : (document.querySelector("script[nonce]") as HTMLScriptElement | null)?.nonce;
if (pageNonce) (globalThis as { __webpack_nonce__?: string }).__webpack_nonce__ = pageNonce;
