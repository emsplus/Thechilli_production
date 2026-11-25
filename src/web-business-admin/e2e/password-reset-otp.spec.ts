import { expect, test } from "@playwright/test";

// Forgot password by emailed code (docs/EMAIL.md, PASSWORD_RESET_MODE=otp). The server routes are mocked in the browser, so the
// spec does not depend on the API's mail settings.
test("forgot password: code -> resend countdown -> new password -> done", async ({ page }) => {
  let verified = 0;
  await page.route("**/auth/forgot-password", (r) => r.fulfill({ status: 200, json: { detail: "If an account exists for this email, we have sent a code to it." } }));
  await page.route("**/auth/password-reset/verify", (r) => {
    const b = r.request().postDataJSON() as { otp: string };
    if (b.otp !== "123456") return r.fulfill({ status: 400, json: { detail: "The code is invalid or has expired. Request a new code." } });
    verified++;
    return r.fulfill({ status: 200, json: { reset_token: "t".repeat(40), expires_in_seconds: 600 } });
  });
  await page.route("**/auth/password-reset/complete", (r) => r.fulfill({ status: 204 }));

  await page.goto("/forgot-password");
  await page.getByLabel("Your email").fill("owner@example.in");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByTestId("forgot-sent")).toContainText("6-digit code");
  await expect(page.getByRole("button", { name: /Resend code in \d:\d\d/ })).toBeDisabled();

  await page.getByLabel("6-digit code").fill("000 000");
  await page.getByRole("button", { name: "Check code" }).click();
  await expect(page.getByText("That code is wrong or has expired")).toBeVisible();
  await page.getByLabel("6-digit code").fill("123-456");
  await page.getByRole("button", { name: "Check code" }).click();
  expect(verified).toBe(1);

  await page.getByLabel("New password", { exact: true }).fill("saffron-tandoor-42");
  await page.getByLabel("New password again").fill("saffron-tandoor-42");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByTestId("reset-done")).toContainText("Your password is changed");
});
