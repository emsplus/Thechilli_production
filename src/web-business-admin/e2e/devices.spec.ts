import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, openAs, seed, type Seed } from "./helpers";

// Signed-in devices, counter devices, staff PINs and step-up (pos-service docs/STAFF_PIN_DEVICES_API.md), against the real API.
// The step-up test needs the API started with STEP_UP_REQUIRED=1 (it is skipped otherwise).
// E2E_SHOTS_DIR=<dir>: also saves phone / desktop, light / dark screenshots of the new screens.

const PW = "supersecret123";
const SHOTS = process.env.E2E_SHOTS_DIR;

async function apiLogin(request: APIRequestContext, email: string, password: string, device: { id: string; name: string; platform?: string }) {
  const r = await request.post(`${API}/auth/login`, { data: { email, password }, headers: { "X-Device-Id": device.id, "X-Device-Name": device.name, "X-Device-Platform": device.platform ?? "android" } });
  expect(r.status(), await r.text()).toBe(200);
  return r.json() as Promise<{ access_token: string; refresh_token: string }>;
}
async function addStaff(request: APIRequestContext, s: Seed, name: string, role: string) {
  const email = `${role}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.in`;
  const r = await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: name, password: PW, role } });
  expect(r.status(), await r.text()).toBe(201);
  return { ...(await r.json() as { id: string }), email };
}
/** Signs in through the real login form, so the BFF sends this browser's device headers. */
async function loginUi(page: Page, email: string, password = PW) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
/** Phone (360 px) and desktop, light and dark. The viewport goes back to what it was. */
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  const was = page.viewportSize()!;
  for (const [kind, size] of [["phone", { width: 360, height: 780 }], ["desktop", { width: 1280, height: 860 }]] as const) {
    await page.setViewportSize(size);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/${name}-${kind}-${scheme}.png` });
    }
  }
  await page.setViewportSize(was);
  await page.emulateMedia({ colorScheme: "light" });
}

test("my devices: this device is marked, another one is revoked and its refresh token dies", async ({ page, request }) => {
  const s = await seed(request);
  const phone = await apiLogin(request, s.email, PW, { id: "e2e-phone-1", name: "Asha's phone" });
  await loginUi(page, s.email);
  await page.goto("/manage?tab=devices");
  const mine = page.getByTestId("my-device-list");
  await expect(mine.getByTestId("current-device")).toHaveCount(1);
  const row = mine.getByTestId("device-row").filter({ hasText: "Asha's phone" });
  await expect(row).toContainText("Android");
  await expect(row).toContainText("Last seen");
  await shot(page, "devices-mine");
  await row.getByRole("button", { name: "Revoke Asha's phone" }).click();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(row.getByText("Signed out")).toBeVisible();
  expect((await request.post(`${API}/auth/refresh`, { data: { refresh_token: phone.refresh_token } })).status()).toBe(401);
  // Sign out everywhere, keeping this browser: still signed in here.
  await apiLogin(request, s.email, PW, { id: "e2e-tablet-2", name: "Old tablet" });
  await page.reload();
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  const dlg = page.getByRole("dialog", { name: "Sign out everywhere?" });
  await expect(dlg.getByLabel("Keep me signed in on this device")).toBeChecked();
  await dlg.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page.getByText(/Signed out of \d+ device/)).toBeVisible();
  await expect(mine.getByTestId("device-row").filter({ hasText: "Old tablet" }).getByText("Signed out")).toBeVisible();
  await expect(page).toHaveURL(/tab=devices/);
});

test("all staff devices: filter by person and sign one person out everywhere; a waiter sees no Manage", async ({ page, request }) => {
  const s = await seed(request);
  const w = await addStaff(request, s, "Ravi Waiter", "waiter");
  const wp = await apiLogin(request, w.email, PW, { id: "e2e-ravi-phone", name: "Ravi's phone" });
  await openAs(page, s.token, "/manage?tab=devices&view=staff", s.refresh);
  const all = page.getByTestId("all-device-list");
  await expect(all.getByTestId("device-row").filter({ hasText: "Ravi's phone" })).toBeVisible();
  await page.getByLabel("Person").selectOption({ label: "Ravi Waiter (waiter)" });
  await expect(all.getByTestId("device-row")).toHaveCount(1);
  await shot(page, "devices-staff");
  await page.getByRole("button", { name: "Sign Ravi Waiter out everywhere" }).click();
  await page.getByRole("button", { name: "Sign out everywhere", exact: true }).click();
  await expect(all.getByTestId("device-row").getByText("Signed out")).toBeVisible();
  expect((await request.post(`${API}/auth/refresh`, { data: { refresh_token: wp.refresh_token } })).status()).toBe(401);

  // The waiter: no Devices / Manage, but My account has their PIN and their own devices.
  const w2 = await apiLogin(request, w.email, PW, { id: "e2e-ravi-phone-2", name: "Ravi new phone" });
  await page.context().clearCookies();
  await openAs(page, w2.access_token, "/account", w2.refresh_token);
  await expect(page.getByTestId("my-pin")).toBeVisible();
  await expect(page.getByTestId("my-device-list").getByTestId("device-row").filter({ hasText: "Ravi new phone" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Devices" })).toHaveCount(0);
  await page.goto("/manage?tab=devices&view=counter");
  await expect(page.getByTestId("counter-devices")).toHaveCount(0);
});

test("counter devices: the code is shown once with a warning, works on the tablet routes, and dies when revoked", async ({ page, request }) => {
  const s = await seed(request);
  await openAs(page, s.token, "/manage?tab=devices&view=counter", s.refresh);
  await expect(page.getByTestId("counter-devices")).toBeVisible();
  await page.getByRole("button", { name: "Register a counter device" }).click();
  const reg = page.getByRole("dialog", { name: "Register a counter device" });
  await reg.getByRole("button", { name: "Register" }).click();
  await expect(reg.getByText(/Give it a name/)).toBeVisible();
  await reg.getByLabel("Name").fill("Front counter");
  await reg.getByRole("button", { name: "Register" }).click();
  const once = page.getByTestId("counter-token");
  await expect(once.getByText("You will not see this code again")).toBeVisible();
  const code = (await once.getByTestId("counter-token-value").textContent())!.trim();
  expect(code).toMatch(/^cdt_/);
  await expect(once.getByRole("img", { name: "QR code of the device code" })).toBeVisible();
  await shot(page, "counter-code-once");
  await page.getByRole("button", { name: "I have saved the code" }).click();
  await expect(page.getByTestId("counter-token")).toHaveCount(0);
  const row = page.getByTestId("counter-row").filter({ hasText: "Front counter" });
  await expect(row).toBeVisible();
  await expect(page.getByText(code)).toHaveCount(0); // never shown again
  await shot(page, "counter-list");
  expect((await request.get(`${API}/devices/counter/roster`, { headers: { "X-Counter-Token": code } })).status()).toBe(200);
  await row.getByRole("button", { name: "Revoke Front counter" }).click();
  await page.getByRole("button", { name: "Revoke tablet" }).click();
  await expect(row.getByText("Revoked")).toBeVisible();
  expect((await request.get(`${API}/devices/counter/roster`, { headers: { "X-Counter-Token": code } })).status()).toBe(401);
});

test("PINs: my own PIN needs the password; a manager sets, and unlocks, a waiter's PIN", async ({ page, request }) => {
  const s = await seed(request);
  const w = await addStaff(request, s, "Meena Waiter", "waiter");
  const counter = await (await request.post(`${API}/devices/counter`, { headers: s.auth, data: { name: "Till" } })).json() as { device_token: string };

  await openAs(page, s.token, "/account", s.refresh);
  const card = page.getByTestId("my-pin");
  await expect(card.getByTestId("my-pin-status")).toContainText("No PIN yet");
  await shot(page, "account-pin");
  await card.getByRole("button", { name: "Set PIN" }).click();
  const dlg = page.getByRole("dialog", { name: "Set your PIN" });
  await dlg.getByLabel("PIN", { exact: true }).fill("1234");
  await dlg.getByLabel("PIN again").fill("1234");
  await dlg.getByLabel("Current password").fill(PW);
  await dlg.getByRole("button", { name: "Set PIN" }).click();
  await expect(dlg.getByText(/avoid runs like 1234/)).toBeVisible();          // checked before sending
  await dlg.getByLabel("PIN", { exact: true }).fill("4826");
  await dlg.getByLabel("PIN again").fill("4826");
  await dlg.getByLabel("Current password").fill("wrong-password");
  await dlg.getByRole("button", { name: "Set PIN" }).click();
  await expect(dlg.getByText("Current password is incorrect")).toBeVisible();
  await expect(dlg.getByLabel("PIN", { exact: true })).toHaveAttribute("type", "password"); // never shown back
  await dlg.getByLabel("Current password").fill(PW);
  await shot(page, "account-pin-dialog");
  await dlg.getByRole("button", { name: "Set PIN" }).click();
  await expect(card.getByTestId("my-pin-status")).toContainText("PIN is set");
  await expect(page.getByText("4826")).toHaveCount(0);

  // Manager view: set Meena's PIN, lock it with wrong tries on the tablet, unlock it.
  await page.goto("/manage?tab=staff");
  await page.getByRole("button", { name: "Counter PIN for Meena Waiter" }).click();
  const pd = page.getByTestId("staff-pin-dialog");
  await pd.getByLabel("New PIN", { exact: true }).fill("5937");
  await pd.getByLabel("New PIN again").fill("5937");
  await shot(page, "staff-pin-dialog");
  await page.getByRole("button", { name: "Set PIN", exact: true }).click();
  await expect(page.getByText(/New PIN set for Meena Waiter/)).toBeVisible();
  const pinLogin = (pin: string) => request.post(`${API}/auth/pin-login`, { data: { device_token: counter.device_token, user_id: w.id, pin } });
  const ok = await pinLogin("5937");
  expect(ok.status(), await ok.text()).toBe(200);
  expect((await ok.json()).pin_change_suggested).toBe(true);
  let last = 0;
  for (let i = 0; i < 5; i++) last = (await pinLogin("0000")).status();
  expect(last).toBe(429);
  expect((await pinLogin("5937")).status()).toBe(429);                           // a locked PIN is not even checked
  await page.getByRole("button", { name: "Counter PIN for Meena Waiter" }).click();
  await page.getByTestId("staff-pin-dialog").getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Meena Waiter can try their PIN again")).toBeVisible();
  expect((await pinLogin("5937")).status()).toBe(200);
  // The owner row of another owner would need owner rights; a manager never sees the owner's PIN button.
  await expect(page.getByRole("button", { name: /^Counter PIN for O$/ })).toHaveCount(0);
});

test("step-up: voiding a bill asks for the PIN again, counts a wrong PIN, then voids", async ({ page, request }) => {
  const s = await seed(request);
  expect((await request.put(`${API}/auth/me/pin`, { headers: s.auth, data: { pin: "4826", current_password: PW } })).status()).toBe(204);
  const o = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", lines: [{ item_id: s.itemId, quantity: 1 }] } })).json();
  const b = await (await request.post(`${API}/orders/${o.id}/bill`, { headers: s.auth, data: {} })).json() as { id: string; invoice_number: string; total: string };
  await request.post(`${API}/bills/${b.id}/payments`, { headers: s.auth, data: { idempotency_key: crypto.randomUUID(), method: "cash", amount: b.total } });
  const probe = await request.post(`${API}/bills/${b.id}/void`, { headers: s.auth, data: { reason: "probe", idempotency_key: crypto.randomUUID() } });
  test.skip(probe.status() !== 403, "the API runs without STEP_UP_REQUIRED=1");
  expect(probe.headers()["x-step-up-required"]).toBe("1");

  await openAs(page, s.token, "/orders", s.refresh);
  await page.getByTestId("order-card").first().getByRole("button", { name: "View bill" }).click();
  await page.getByTestId("void-bill").click();
  const v = page.getByRole("dialog", { name: "Void this bill?" });
  await v.getByRole("radio", { name: "Duplicate bill" }).click();
  await v.getByRole("button", { name: "Void bill" }).click();
  await page.getByRole("button", { name: "Yes, void the bill" }).click();
  const su = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(su).toBeVisible();
  await su.getByLabel("PIN").fill("1357");
  await su.getByRole("button", { name: "Confirm" }).click();
  await expect(su.getByText(/Wrong PIN\. 4 attempts left/)).toBeVisible();      // X-Pin-Attempts-Left through the BFF
  await expect(su.getByLabel("PIN")).toHaveValue("");
  await su.getByLabel("PIN").fill("4826");
  await shot(page, "step-up");
  await su.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("dialog", { name: "Bill voided" })).toBeVisible();
});

test("step-up cancelled: the bill is not voided and says why", async ({ page, request }) => {
  const s = await seed(request);
  const o = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", lines: [{ item_id: s.itemId, quantity: 1 }] } })).json();
  const b = await (await request.post(`${API}/orders/${o.id}/bill`, { headers: s.auth, data: {} })).json() as { id: string };
  const probe = await request.post(`${API}/bills/${b.id}/void`, { headers: s.auth, data: { reason: "probe", idempotency_key: crypto.randomUUID() } });
  test.skip(probe.status() !== 403, "the API runs without STEP_UP_REQUIRED=1");
  await openAs(page, s.token, "/orders", s.refresh);
  await page.getByTestId("order-card").first().getByRole("button", { name: "View bill" }).click();
  await page.getByTestId("void-bill").click();
  const v = page.getByRole("dialog", { name: "Void this bill?" });
  await v.getByRole("radio", { name: "Duplicate bill" }).click();
  await v.getByRole("button", { name: "Void bill" }).click();
  await page.getByRole("button", { name: "Yes, void the bill" }).click();
  const su = page.getByRole("dialog", { name: "Confirm it is you" });
  await su.getByRole("button", { name: "No PIN? Use my password" }).click();
  await expect(su.getByLabel("Password", { exact: true })).toBeVisible();
  await su.getByRole("button", { name: "Cancel" }).click();
  await expect(v.getByText("Not voided: your PIN is needed to void a bill.")).toBeVisible();
});
