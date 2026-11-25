import { expect as baseExpect, test, type APIRequestContext } from "@playwright/test";
import { API, openAs, seedIn, sessionAccessToken, type Seed } from "./helpers";

// Staff wiring (pos-service docs/STAFF_WIRING_CHECK.md): an owner adds a waiter without email, the sign-in card shows the
// restaurant code and a one-time password once, the waiter signs in with code + phone and must choose a password, and only
// the outlets granted are reachable. Also: restaurant code in Manage, one-time password from the reset dialog, invite links.
const expect = baseExpect.configure({ timeout: 20_000 });
const PW = "Wire-Pass-7319x";

const code = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/restaurant`, { headers: s.auth })).json()).login_code as string;

test("owner adds a waiter by phone with an outlet; the waiter signs in with the restaurant code", async ({ page, request, browser }) => {
  const s = await seedIn(request);
  const roof = await (await request.post(`${API}/outlets`, { headers: s.auth, data: { name: "Rooftop", code: "ROOF", invoice_prefix: "RF" } })).json();
  await openAs(page, s.token, "/manage?tab=staff", s.refresh);
  await page.getByRole("button", { name: "Add staff" }).first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Full name").fill("Ramesh Waiter");
  await dlg.getByLabel("Phone or username").fill("98765 43210");
  await dlg.getByLabel(/^Waiter/).check();
  await dlg.getByLabel("Rooftop").check();
  await dlg.getByRole("button", { name: "Add staff" }).click();
  const card = page.getByTestId("credentials-card");
  await expect(card).toBeVisible();
  const restaurantCode = await code(request, s);
  await expect(page.getByTestId("cred-code")).toHaveText(restaurantCode);
  await expect(page.getByTestId("cred-login")).toHaveText("+919876543210");
  const temp = (await page.getByTestId("cred-password").textContent())!.trim();
  expect(temp).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Ramesh Waiter").first()).toBeVisible();
  await expect(page.getByText(temp)).toHaveCount(0); // shown once

  // the waiter, on another device
  const ctx = await browser.newContext();
  const w = await ctx.newPage();
  await w.goto("/login");
  await w.getByRole("link", { name: /restaurant code/ }).click();
  await expect(w).toHaveURL(/\/staff-login$/);
  const f = w.getByTestId("staff-login-form"); // the /login form can still be leaving (page transition): stay inside this one
  await f.getByLabel("Restaurant code").fill(restaurantCode.toLowerCase());
  await f.getByLabel("Phone, username or email").fill("9876543210");
  await f.getByLabel("Password").fill(temp);
  await f.getByRole("button", { name: "Sign in" }).click();
  await expect(w.getByTestId("staff-change-password")).toBeVisible();
  await w.getByLabel("New password", { exact: true }).fill(PW);
  await w.getByLabel("New password again").fill(PW);
  await w.getByRole("button", { name: "Save and continue" }).click();
  await expect(w).not.toHaveURL(/staff-login/);
  const token = await sessionAccessToken(w); // the session is the BFF cookie (ux/security), not localStorage
  const me = await (await request.get(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(me.role).toBe("waiter");
  expect(me.must_change_password).toBe(false);
  expect(me.outlets.map((o: { id: string }) => o.id)).toEqual([roof.id]); // only the granted outlet
  await ctx.close();
});

test("restaurant code is shown in Manage > Restaurant; wrong code is refused on staff sign-in", async ({ page, request }) => {
  const a = await seedIn(request);
  const b = await seedIn(request);
  await request.post(`${API}/auth/users`, { headers: a.auth, data: { full_name: "Sita", username: "sita", password: PW, role: "waiter" } });
  await openAs(page, a.token, "/manage?tab=restaurant", a.refresh);
  await expect(page.getByTestId("restaurant-code")).toHaveText(await code(request, a));
  const ctx = await page.context().browser()!.newContext();
  const w = await ctx.newPage();
  await w.goto("/staff-login");
  await w.getByLabel("Restaurant code").fill(await code(request, b)); // B's code with A's waiter
  await w.getByLabel("Phone, username or email").fill("sita");
  await w.getByLabel("Password").fill(PW);
  await w.getByRole("button", { name: "Sign in" }).click();
  await expect(w.getByText("The restaurant code, phone / username or password is wrong.")).toBeVisible();
  await w.getByLabel("Restaurant code").fill(await code(request, a));
  await w.getByRole("button", { name: "Sign in" }).click();
  await expect(w).not.toHaveURL(/staff-login/);
  await ctx.close();
});

test("owner makes a one-time password from the reset dialog; outlets dialog changes access", async ({ page, request }) => {
  const s = await seedIn(request);
  const roof = await (await request.post(`${API}/outlets`, { headers: s.auth, data: { name: "Rooftop", code: "ROOF", invoice_prefix: "RF" } })).json();
  const u = await (await request.post(`${API}/auth/users`, { headers: s.auth, data: { full_name: "Kiran Kitchen", username: "kiran", password: PW, role: "kitchen" } })).json();
  await openAs(page, s.token, "/manage?tab=staff", s.refresh);
  await page.getByRole("button", { name: "Outlets for Kiran Kitchen" }).click();
  await page.getByRole("dialog").getByLabel("Rooftop").check();
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await (await request.get(`${API}/users/${u.id}/outlets`, { headers: s.auth })).json()).outlet_ids).toEqual([roof.id]);
  await page.getByRole("button", { name: /Reset password for Kiran Kitchen|Reset.*Kiran/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "One-time password" }).click();
  await expect(page.getByTestId("cred-login")).toHaveText("kiran");
  const temp = (await page.getByTestId("cred-password").textContent())!.trim();
  const r = await request.post(`${API}/auth/login`, { data: { restaurant_code: await code(request, s), identifier: "kiran", password: temp } });
  expect(r.status()).toBe(200);
  expect((await r.json()).password_change_required).toBe(true);
  expect((await request.post(`${API}/auth/login`, { data: { restaurant_code: await code(request, s), identifier: "kiran", password: PW } })).status()).toBe(401);
});

test("invite link: the staff member chooses a password on /accept-invite and lands in this restaurant", async ({ page, request }) => {
  const s = await seedIn(request);
  const email = `neha-${Date.now()}@example.in`;
  const created = await (await request.post(`${API}/auth/users`, { headers: s.auth, data: { full_name: "Neha", email, role: "cashier", send_invite: true } })).json();
  const url = new URL(created.invite.url);
  await page.goto(`/accept-invite${url.hash}`);
  await page.getByLabel("New password", { exact: true }).fill(PW);
  await page.getByLabel("New password again").fill(PW);
  await page.getByRole("button", { name: "Save and sign in" }).click();
  await expect(page).not.toHaveURL(/accept-invite/);
  const token = await sessionAccessToken(page);
  const me = await (await request.get(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(me.email).toBe(email);
  expect(me.restaurant_code).toBe(await code(request, s));
  // the link is single use
  const again = await page.context().browser()!.newContext();
  const p2 = await again.newPage();
  await p2.goto(`/accept-invite${url.hash}`);
  await p2.getByLabel("New password", { exact: true }).fill(PW);
  await p2.getByLabel("New password again").fill(PW);
  await p2.getByRole("button", { name: "Save and sign in" }).click();
  await expect(p2.getByTestId("invite-invalid")).toBeVisible();
  await again.close();
});
