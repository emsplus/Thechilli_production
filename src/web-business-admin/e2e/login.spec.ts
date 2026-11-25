import { expect, test } from "@playwright/test";
import { API, seed, signIn } from "./helpers";

const PASSWORD = "supersecret123";

test("login page: no sign-up tab, has email / password / eye toggle / forgot link / new-restaurant link", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign In", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "thechilli.ai" }).first()).toBeVisible(); // the real wordmark (owner logo file)
  await expect(page.getByText("Register restaurant")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show characters" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Forgot password?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "New to Chilli?" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Register" })).toHaveAttribute("href", "/register");
});

test("the eye toggle shows and hides the password", async ({ page }) => {
  await page.goto("/login");
  const pw = page.getByLabel("Password");
  await pw.fill("hunter2hunter2");
  await expect(pw).toHaveAttribute("type", "password");
  const eye = page.getByRole("button", { name: "Show characters" });
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  await eye.click();
  await expect(pw).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Hide characters" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Hide characters" }).click();
  await expect(pw).toHaveAttribute("type", "password");
});

test("validation and a wrong password give friendly messages and stay on /login", async ({ page, request }) => {
  const s = await seed(request);
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Enter a valid email")).toBeVisible();
  await expect(page.getByText("Password required")).toBeVisible();
  await page.getByLabel("Email").fill(s.email);
  await page.getByLabel("Password").fill("definitely-wrong-1");
  await page.getByLabel("Password").press("Enter"); // Enter submits
  await expect(page.getByText("That email and password do not match")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  // and the right one gets in
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/manage$/, { timeout: 20_000 });
});

test("Forgot password? opens the code form with guidance for staff and owners (no dead link)", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Forgot password?" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Forgot your password?")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Email me a code" })).toBeVisible(); // the emailed-code flow (docs/EMAIL.md); its steps are in password-reset-otp.spec.ts
  await expect(dialog.getByText(/Manage, Staff, Reset password/)).toBeVisible();
  await expect(dialog.getByText(/docs\/runbook\.md/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
});

test("/register creates an India restaurant (no country picker, optional GSTIN with checksum) and lands on Manage", async ({ page }) => {
  await page.goto("/register");
  await expect(page.getByRole("heading", { name: "Register your restaurant" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
  await expect(page.getByLabel("Country")).toHaveCount(0);           // India only: nothing to pick
  await expect(page.getByText(/VAT|HMRC/)).toHaveCount(0);
  const email = `reg-${Date.now()}-${Math.floor(Math.random() * 1e6)}@x.in`;
  await page.getByLabel("Owner name").fill("Reg Owner");
  await page.getByLabel("Restaurant name").fill("Register Cafe");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  const gstin = page.getByLabel("GSTIN (optional)");
  await gstin.fill("27AAPFU0939F1ZW");                               // bad check character
  await page.getByRole("button", { name: "Create restaurant" }).click();
  await expect(page.getByText(/check digit/)).toBeVisible();
  await expect(page).toHaveURL(/\/register$/);
  await gstin.fill("27aapfu0939f1zv");
  await expect(page.getByText("State: Maharashtra")).toBeVisible();  // from the first two digits
  const sent = page.waitForRequest((r) => r.url().endsWith("/bff/auth/register") && r.method() === "POST");
  await page.getByRole("button", { name: "Create restaurant" }).click();
  expect((await sent).postDataJSON()).toMatchObject({ country: "IN", trn: "27AAPFU0939F1ZV", restaurant_name: "Register Cafe", owner_name: "Reg Owner", owner_email: email });
  await expect(page).toHaveURL(/\/manage$/, { timeout: 20_000 });
});

test("owner resets a cashier's password in Manage > Staff: old fails, new works, old session is dead", async ({ page, request }) => {
  const s = await seed(request);
  const email = `cashier-${Date.now()}@example.in`;
  const created = await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: "Casey Cashier", password: PASSWORD, role: "cashier" } });
  expect(created.status()).toBe(201);
  const oldSession = await (await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } })).json();

  await signIn(page, s.token, s.refresh);
  await page.goto("/manage?tab=staff");
  await page.getByRole("button", { name: "Reset password for Casey Cashier" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/signs them out on every device/)).toBeVisible();
  const fresh = "Fresh-pass-2468";
  await dialog.getByLabel("New password").fill(fresh);
  await dialog.getByRole("button", { name: "Set new password" }).click();
  await expect(dialog).toHaveCount(0);

  const oldLogin = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(oldLogin.status()).toBe(401);
  const newLogin = await request.post(`${API}/auth/login`, { data: { email, password: fresh } });
  expect(newLogin.status()).toBe(200);
  const refresh = await request.post(`${API}/auth/refresh`, { data: { refresh_token: oldSession.refresh_token } });
  expect(refresh.status()).toBe(401);
});

test("an email used by several restaurants: pick one after the password is accepted", async ({ page, request }) => {
  // Two restaurants with the same owner email (the API allows it today; the picker is what makes it usable).
  const email = `multi-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.in`;
  const reg = async (name: string) => {
    const r = await request.post(`${API}/auth/register-restaurant`, { data: { restaurant_name: name, country: "IN", owner_email: email, owner_name: "Owner", owner_password: PASSWORD } });
    expect(r.status()).toBe(201);
    const t = (await r.json()).access_token as string;
    return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).rid as string;
  };
  const one = await reg("Spice Route Andheri");
  const two = await reg("Spice Route Bandra");

  // An API that still answers the old way (409 before checking the password, no list): a clear message, no picker.
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(/used at more than one restaurant and this server cannot list them/)).toBeVisible();

  // The contract (docs/AUTH_CONTRACT.md): after a correct password, 409 multiple_restaurants with the list.
  const sent: unknown[] = [];
  await page.route("**/bff/auth/login", async (route) => {
    const body = route.request().postDataJSON() as { restaurant_id?: string };
    sent.push(body);
    if (body.restaurant_id) return route.continue();
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "multiple_restaurants", message: "Choose a restaurant", restaurants: [{ id: one, name: "Spice Route Andheri" }, { id: two, name: "Spice Route Bandra" }] } }) });
  });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose a restaurant" })).toBeVisible();
  const group = page.getByRole("group", { name: "Restaurant" });
  await expect(group.getByRole("radio")).toHaveCount(2);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Choose a restaurant" })).toBeVisible(); // nothing chosen yet
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/login-restaurant-picker.png`, fullPage: true });
  await group.getByLabel("Spice Route Bandra").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/manage$/, { timeout: 20_000 });
  expect(sent.at(-1)).toMatchObject({ email, password: PASSWORD, restaurant_id: two });
  // signed in to the chosen one
  const rid = await page.evaluate(() => document.cookie.match(/pos_session=v1\.[^.]+\.([^.;]+)/)?.[1]);
  expect(rid).toBe(two.replace(/[^A-Za-z0-9_-]/g, ""));
});

test("'Use a different account' leaves the picker and forgets the password", async ({ page }) => {
  await page.route("**/bff/auth/login", (route) => route.fulfill({ status: 409, contentType: "application/json",
    body: JSON.stringify({ error: { code: "multiple_restaurants", restaurants: [{ id: "a", name: "One" }, { id: "b", name: "Two" }] } }) }));
  await page.goto("/login");
  await page.getByLabel("Email").fill("someone@example.in");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Use a different account" }).click();
  await expect(page.getByRole("heading", { name: "Sign In", exact: true })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveValue("");
});
