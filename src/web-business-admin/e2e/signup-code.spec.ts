import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { seed, signIn } from "./helpers";

// The code step (pos-service docs/EMAIL.md, SIGNUP_EMAIL_VERIFICATION=true) against a mocked contract: the e2e API may run with
// verification off (the old immediate sign-up stays covered by login.spec.ts "/register creates an India restaurant").
// Sign-up, code check and sign-in go through the BFF (/bff/auth/register, /bff/auth/verify-email: ux/security), so those are
// what is mocked; a successful mock also sets the session cookies the BFF would set (signIn). Resend has no tokens and
// still goes straight to the API.
const PASSWORD = "Chilli-e2e-Pass-2026";

async function fillForm(page: Page, email: string) {
  await page.goto("/register");
  await page.getByLabel("Owner name").fill("Code Owner");
  await page.getByLabel("Restaurant name").fill("Code Cafe");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
}
const pending = (email: string, resendAfter = 60) => ({
  status: 202,
  json: { status: "verification_required", email, detail: "We emailed a 6-digit code. Enter it to finish creating your restaurant.", expires_in_seconds: 600, resend_after_seconds: resendAfter },
});
const digits = (page: Page) => page.getByRole("group", { name: "Enter the 6-digit code" }).getByRole("textbox");

test("202: enter the emailed code (paste, wrong code, typed code) and land on Manage (Today moved into Overview)", async ({ page, request }) => {
  const email = `code-${Date.now()}-${Math.floor(Math.random() * 1e6)}@x.in`;
  // A real session for the final 200, so the landing page loads against the e2e API.
  const s = await seed(request);
  const grant = { access_token: s.token, token_type: "bearer", expires_in: 900 };
  await page.route("**/bff/auth/register", (r) => r.fulfill(pending(email)));
  const tries: string[] = [];
  await page.route("**/bff/auth/verify-email", async (r) => {
    const b = r.request().postDataJSON();
    tries.push(b.otp);
    expect(b.email).toBe(email);
    if (b.otp === "123456") await r.fulfill({ status: 400, json: { detail: "The code is invalid or has expired. Request a new code." } });
    else { await signIn(page, s.token, s.refresh); await r.fulfill({ json: grant }); }
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await fillForm(page, email);
  await page.getByRole("button", { name: "Create restaurant" }).click();

  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByTestId("signup-code-email")).toHaveText(email);
  await expect(page.getByRole("button", { name: "Wrong email? Go back" })).toBeVisible();
  const boxes = digits(page);
  await expect(boxes).toHaveCount(6);
  await expect(boxes.first()).toHaveAttribute("inputmode", "numeric");
  await expect(boxes.first()).toHaveAttribute("autocomplete", "one-time-code");
  await expect(boxes.first()).toBeFocused();
  await expect(page.getByRole("button", { name: "Resend code" })).toBeDisabled();
  await expect(page.getByText(/You can ask again in 0:[0-5]\d|1:00/)).toBeVisible();
  // fits the phone: no horizontal scroll
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  await page.screenshot({ path: "test-results/signup-code-390.png", fullPage: true });

  // Paste a code with spaces into the first box: all six fill and it submits by itself; the 400 clears the boxes.
  await boxes.first().focus();
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData("text", "12 34 56");
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("alert").filter({ hasText: "That code is wrong or has expired" })).toContainText("Resend code");
  await expect(boxes.first()).toHaveValue("");
  await page.screenshot({ path: "test-results/signup-code-error-390.png", fullPage: true });

  // Typing moves to the next box; Backspace on an empty box goes back.
  await boxes.first().focus();
  await page.keyboard.type("65");
  await expect(boxes.nth(2)).toBeFocused();
  await page.keyboard.press("Backspace");
  await expect(boxes.nth(1)).toBeFocused();
  await expect(boxes.nth(1)).toHaveValue("");
  await page.keyboard.type("54321");
  await expect(page).toHaveURL(/\/manage$/, { timeout: 20_000 });
  expect(tries).toEqual(["123456", "654321"]);
});

test("resend: countdown, 429 Retry-After restarts it; Wrong email? Go back keeps the form", async ({ page }) => {
  const email = `resend-${Date.now()}@x.in`;
  await page.route("**/bff/auth/register", (r) => r.fulfill(pending(email, 2)));
  let resends = 0;
  await page.route("**/auth/verify-email/resend", async (r) => {
    resends++;
    if (resends === 1) await r.fulfill({ json: { detail: "If a sign-up is waiting for this email, a new code has been sent.", resend_after_seconds: 2 } });
    else await r.fulfill({ status: 429, headers: { "Retry-After": "45" }, json: { detail: "Please wait before asking for another code." } });
  });
  await fillForm(page, email);
  await page.getByRole("button", { name: "Create restaurant" }).click();
  const resend = page.getByRole("button", { name: "Resend code" });
  await expect(resend).toBeDisabled();
  await expect(resend).toBeEnabled({ timeout: 5000 });
  await resend.click();
  await expect(page.getByText("A new code is on its way")).toBeVisible();
  await expect(resend).toBeDisabled();
  await expect(resend).toBeEnabled({ timeout: 5000 });
  await resend.click();
  await expect(page.getByRole("alert").filter({ hasText: "Please wait before asking for another code." })).toBeVisible();
  await expect(digits(page).first()).not.toHaveAttribute("aria-invalid", "true"); // a resend refusal is not a bad code
  await expect(page.getByText(/You can ask again in 0:4\d/)).toBeVisible();

  // A reload keeps the step (phones drop the tab while the mail app is open).
  await page.reload();
  await expect(page.getByTestId("signup-code-email")).toHaveText(email);

  await page.getByRole("button", { name: "Wrong email? Go back" }).click();
  await expect(page.getByRole("heading", { name: "Register your restaurant" })).toBeVisible();
});

test("Go back before a reload returns the filled form", async ({ page }) => {
  const email = `back-${Date.now()}@x.in`;
  await page.route("**/bff/auth/register", (r) => r.fulfill(pending(email)));
  await fillForm(page, email);
  await page.getByRole("button", { name: "Create restaurant" }).click();
  await page.getByRole("button", { name: "Wrong email? Go back" }).click();
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await expect(page.getByLabel("Restaurant name")).toHaveValue("Code Cafe");
});

test("verification off (old 201 with the session): straight to Manage (Today moved into Overview), no code step", async ({ page, request }) => {
  const s = await seed(request);
  await page.route("**/bff/auth/register", async (r) => {
    await signIn(page, s.token, s.refresh);
    await r.fulfill({ status: 201, json: { access_token: s.token, token_type: "bearer", expires_in: 900 } });
  });
  await fillForm(page, `legacy-${Date.now()}@x.in`);
  await page.getByRole("button", { name: "Create restaurant" }).click();
  await expect(page).toHaveURL(/\/manage$/, { timeout: 20_000 });
  expect(await page.evaluate(() => sessionStorage.getItem("pos.signupPending"))).toBeNull();
});
