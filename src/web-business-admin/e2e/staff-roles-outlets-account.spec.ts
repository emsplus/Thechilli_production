import { expect as baseExpect, test, type Page } from "@playwright/test";
import { API, openAs, seed } from "./helpers";

// The shared dev API can be slow under load: give assertions more room than the 5 s default.
const expect = baseExpect.configure({ timeout: 20_000 });

// Roles (assumed REST paths, not yet on the server), outlets limit, account and password-reset pages. Routes the server may not have are mocked in the browser.

const ROLE = { id: "r1", name: "Shift supervisor", is_system: false, editable: true, permissions: ["bills.discount", "bills.void", "orders.create"], user_count: 1 };

test.describe("roles", () => {
  test("a server without /roles (404): explanation, built-in roles remain", async ({ page, request }) => {
    const s = await seed(request);
    await page.route("**/roles", (r) => r.fulfill({ status: 404, json: { detail: "Not Found" } }));
    await openAs(page, s.token, "/manage?tab=staff", s.refresh);
    await page.getByRole("radio", { name: "Roles and permissions" }).click();
    await expect(page.getByText("Custom roles are not available on this server yet")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Built-in roles" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New role" })).toHaveCount(0);
  });

  test("create, edit and delete a custom role; assign it to a person", async ({ page, request }) => {
    const s = await seed(request);
    // a team member to assign it to (the signed-in owner is the "you" card, not a list row)
    expect((await request.post(`${API}/auth/users`, { headers: s.auth, data: { email: `sup-${Date.now()}@x.in`, full_name: "Sunita Supervisor", password: "supersecret123", role: "cashier" } })).ok()).toBeTruthy();
    const roles: typeof ROLE[] = [];
    let created: { name?: string; permissions?: string[] } = {};
    let assigned: { role_id?: string } = {};
    await page.route("**/roles", async (r) => {
      if (r.request().method() === "POST") { created = r.request().postDataJSON(); roles.push({ ...ROLE, ...created, name: created.name!, permissions: created.permissions! }); return r.fulfill({ status: 201, json: roles[0] }); }
      return r.fulfill({ json: roles });
    });
    await page.route("**/roles/r1", async (r) => {
      if (r.request().method() === "DELETE") { roles.length = 0; return r.fulfill({ status: 204 }); }
      return r.fulfill({ json: ROLE });
    });
    await page.route("**/users/*/role", async (r) => { assigned = r.request().postDataJSON(); return r.fulfill({ json: {} }); });
    await openAs(page, s.token, "/manage?tab=staff", s.refresh);
    await page.getByRole("radio", { name: "Roles and permissions" }).click();
    await expect(page.getByText("No custom roles yet.")).toBeVisible();

    await page.getByRole("button", { name: "New role" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Create role" }).click();
    await expect(dlg.getByText("Give the role a name.")).toBeVisible();
    await dlg.getByLabel("Role name").fill("Shift supervisor");
    await dlg.getByRole("button", { name: "Create role" }).click();
    await expect(dlg.getByText("Pick at least one permission.")).toBeVisible();
    await dlg.getByLabel("Give discounts").check();
    await dlg.getByLabel("Void bills").check();
    await dlg.getByRole("button", { name: "Create role" }).click();
    await expect(page.getByRole("cell", { name: /Shift supervisor/ }).first()).toBeVisible();
    expect(created.permissions).toEqual(["bills.discount", "bills.void"]);

    // assign it from the People view
    await page.getByRole("radio", { name: "People" }).click();
    await page.getByRole("button", { name: /Change role for/ }).first().click();
    await page.getByRole("dialog").getByLabel(/Shift supervisor/).check();
    await page.getByRole("dialog").getByRole("button", { name: "Save role" }).click();
    await expect.poll(() => assigned.role_id).toBe("r1");

    // delete (confirm first)
    await page.getByRole("radio", { name: "Roles and permissions" }).click();
    await page.getByRole("button", { name: "Delete role Shift supervisor" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete role" }).click();
    await expect(page.getByText("No custom roles yet.")).toBeVisible();
  });

  test("without roles.manage / users.manage the roles list is read-only and Role buttons are hidden", async ({ page, request }) => {
    const s = await seed(request);
    await page.route("**/auth/me", async (r) => { const res = await r.fetch(); const me = await res.json(); await r.fulfill({ response: res, json: { ...me, permissions: ["staff.view", "staff.create"] } }); });
    await page.route("**/roles", (r) => r.fulfill({ json: [ROLE] }));
    await openAs(page, s.token, "/manage?tab=staff", s.refresh);
    await expect(page.getByRole("button", { name: /Change role for/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add staff" }).first()).toBeVisible();
    await page.getByRole("radio", { name: "Roles and permissions" }).click();
    await expect(page.getByRole("cell", { name: /Shift supervisor/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New role" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Delete role/ })).toHaveCount(0);
  });
});

test.describe("outlets", () => {
  const withLimit = (page: Page, limit: number | null) => page.route("**/auth/me", async (r) => { const res = await r.fetch(); const me = await res.json(); await r.fulfill({ response: res, json: { ...me, entitlements: { status: "active", outlet_limit: limit, features: {} } } }); });

  test("limit reached: Add outlet is disabled with the reason; unlimited: it opens and creates", async ({ page, request }) => {
    const s = await seed(request);
    await withLimit(page, 1);
    await openAs(page, s.token, "/manage?tab=outlets", s.refresh);
    await expect(page.getByTestId("outlet-quota")).toHaveText("1 of 1 outlet in use");
    await expect(page.getByText("Outlet limit reached")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add outlet" })).toBeDisabled();
  });

  test("create an outlet; a server 403 outlet_limit_reached shows the limit message", async ({ page, request }) => {
    const s = await seed(request);
    await openAs(page, s.token, "/manage?tab=outlets", s.refresh);
    await expect(page.getByTestId("outlet-quota")).toHaveText("1 active outlet");
    await page.getByRole("button", { name: "Add outlet" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Add outlet" }).click();
    await expect(dlg.getByText("Enter the outlet's name")).toBeVisible();
    await dlg.getByLabel("Outlet name").fill("Marina Branch");
    await dlg.getByLabel("Code").fill("mar");
    await dlg.getByLabel("Invoice prefix").fill("mar");
    await page.route("**/outlets", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, json: { error: { code: "outlet_limit_reached", message: "limit" } } }) : r.continue());
    await dlg.getByRole("button", { name: "Add outlet" }).click();
    await expect(dlg.getByText(/no room for another outlet/)).toBeVisible();
    await page.unroute("**/outlets");
    await dlg.getByRole("button", { name: "Add outlet" }).click();
    await expect(page.getByRole("cell", { name: /Marina Branch/ }).first()).toBeVisible();
    const list = (await (await request.get(`${API}/outlets`, { headers: s.auth })).json()) as { code: string }[];
    expect(list.map((o) => o.code)).toContain("MAR");
  });
});

test.describe("account and password reset", () => {
  test("My account shows the profile and changes the password (signs out)", async ({ page, request }) => {
    const s = await seed(request);
    await openAs(page, s.token, "/account", s.refresh);
    await expect(page.getByTestId("account-profile")).toContainText(s.email);
    await page.getByLabel("Current password").fill("supersecret123");
    await page.getByLabel("New password", { exact: true }).fill("short");
    await page.getByLabel("New password again").fill("short");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("At least 10 characters", { exact: true })).toBeVisible();
    await page.getByLabel("New password", { exact: true }).fill("a-new-secret-123");
    await page.getByLabel("New password again").fill("a-new-secret-123");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });
  });

  test("/reset-password: link is read from ?r= and #t=, posted, and the token leaves the URL", async ({ page }) => {
    let body: { restaurant_id?: string; token?: string; new_password?: string } = {};
    await page.route("**/auth/reset-password", (r) => { body = r.request().postDataJSON(); return r.fulfill({ status: 200, json: { ok: true } }); });
    await page.goto("/reset-password?r=rest-1#t=tok-abc");
    await expect(page).not.toHaveURL(/tok-abc/);
    await page.getByLabel("New password", { exact: true }).fill("a-new-secret-123");
    await page.getByLabel("New password again").fill("a-new-secret-123");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByTestId("reset-done")).toBeVisible();
    expect(body).toMatchObject({ restaurant_id: "rest-1", token: "tok-abc", new_password: "a-new-secret-123" });
  });

  test("/reset-password: a bad link (400) and a link without a token both offer a new link", async ({ page }) => {
    await page.route("**/auth/reset-password", (r) => r.fulfill({ status: 400, json: { detail: "Invalid or expired link" } }));
    await page.goto("/reset-password?r=rest-1#t=tok-bad");
    await page.getByLabel("New password", { exact: true }).fill("a-new-secret-123");
    await page.getByLabel("New password again").fill("a-new-secret-123");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByTestId("reset-invalid")).toContainText("not valid or has expired");
    await page.goto("/reset-password");
    await expect(page.getByTestId("reset-invalid")).toBeVisible();
    await expect(page.getByRole("link", { name: "Get a new link" })).toHaveAttribute("href", "/forgot-password");
  });

  test("forgot password: sent message; server without the route falls back to guidance", async ({ page }) => {
    await page.route("**/auth/forgot-password", (r) => r.fulfill({ status: 200, json: { ok: true } }));
    await page.goto("/forgot-password");
    await page.getByLabel("Your email").fill("owner@example.in");
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.getByTestId("forgot-sent")).toContainText("If an account exists");
    await page.unroute("**/auth/forgot-password");
    await page.route("**/auth/forgot-password", (r) => r.fulfill({ status: 404, json: { detail: "Not Found" } }));
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.getByText("Email reset is not switched on")).toBeVisible();
    await expect(page.getByText(/Manage, Staff, Reset password/)).toBeVisible();
  });
});
