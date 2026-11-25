import { expect, test } from "@playwright/test";
import { fakeSpeech, seed, signIn, type Seed } from "./helpers";

/** Voice ordering's microphone under the production CSP + Permissions-Policy (fake device: no real audio). */
test.use({ permissions: ["microphone"], launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } });

let s: Seed;
test.beforeAll(async ({ request }) => { s = await seed(request); });

test("the page may open the microphone (Permissions-Policy) without any CSP violation", async ({ page }) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on("console", (m) => { if (/Content Security Policy|Permissions policy violation/i.test(m.text())) violations.push(m.text()); });
  await fakeSpeech(page);
  await signIn(page, s.token, s.refresh);
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: /Latte/ }).first()).toBeVisible();
  const mic = await page.evaluate(async () => {
    const d = document as unknown as { permissionsPolicy?: { allowsFeature(f: string): boolean }; featurePolicy?: { allowsFeature(f: string): boolean } };
    const allowed = (d.permissionsPolicy ?? d.featurePolicy)?.allowsFeature("microphone") ?? null;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tracks = stream.getAudioTracks().length;
    stream.getTracks().forEach((t) => t.stop());
    return { allowed, tracks };
  });
  expect(mic.allowed).not.toBe(false);
  expect(mic.tracks).toBe(1);
  violations.push(...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)));
  expect(violations).toEqual([]);
});
