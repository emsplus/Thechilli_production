import { expect, test, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// The Chilli Staff app opens this site from another origin, so the server renders /login without cookies (SameSite=Strict).
// A page that finds the readable session marker must check the session from inside the page and go straight home.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const ME = { id: "u1", email: "o@example.in", full_name: "Owner", role: "owner", is_active: true, restaurant_name: "Spice Garden", business_types: ["restaurant"], capabilities: { dine_in: true, tables: true } };

test("an already signed-in session on /login goes straight to the owner's home", async ({ page }) => {
  await page.route("**/api/v1/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/auth/me") return route.fulfill({ json: ME });
    return route.fulfill({ json: [] });
  });
  await signIn(page, fakeJwt());
  await page.goto("/login");
  await expect(page).not.toHaveURL(/\/login/);
});

test("an expired session on /login stays on the sign-in form", async ({ page }) => {
  await page.route("**/api/v1/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/auth/me") return route.fulfill({ status: 401, json: { detail: "expired" } });
    return route.fulfill({ json: [] });
  });
  await signIn(page, fakeJwt());
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /sign in/i }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("Back to staff login shows only when the Staff app opened the site, and only for its own local origin", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await page.goto("/login?from=https%3A%2F%2Fevil.example");
  await expect(page.getByTestId("back-to-staff")).toHaveCount(0);
  await page.goto("/login?from=https%3A%2F%2Flocalhost");
  await expect(page.getByTestId("back-to-staff")).toHaveAttribute("href", "https://localhost/?mode=staff");
  await page.goto("/login");                                       // remembered on this device (the manager signed out here)
  await expect(page.getByTestId("back-to-staff")).toBeVisible();
});
