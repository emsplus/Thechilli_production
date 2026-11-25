import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { appendFileSync } from "node:fs";
import { seed, signIn, type Seed } from "./helpers";

// Every route at phone (360) and desktop (1280) width, light only: axe serious/critical violations must be zero, and at 360px
// every visible control (button, link, field) is at least 44px in both directions (inline text links inside a sentence are exempt).
const PUBLIC = ["/login", "/register", "/forgot-password", "/reset-password"];
const APP = ["/pos", "/orders", "/kitchen", "/alerts", "/reports", "/procurement", "/cash", "/end-of-day", "/customers", "/audit", "/sync", "/system", "/account", "/ai", "/modifiers", "/offers", "/reservations", "/attendance",
  ...["overview", "menu", "tables", "customers", "recipes", "inventory", "suppliers", "staff", "restaurant", "printers", "outlets", "system"].map((t) => `/manage?tab=${t}`)];
const SIZES = [{ name: "360", width: 360, height: 740 }, { name: "1280", width: 1280, height: 800 }] as const;
const SCHEMES = ["light"] as const;

let s: Seed;
test.beforeAll(async ({ request }: { request: APIRequestContext }) => { s = await seed(request); });

for (const route of [...PUBLIC, ...APP]) {
  for (const size of SIZES) {
    for (const scheme of SCHEMES) {
      test.describe(`${size.name}`, () => {
      // The phone is a touch device: coarse pointer, so `pointer-fine:` size reductions (desktop mouse only) do not apply.
      if (size.width === 360) test.use({ hasTouch: true, isMobile: true });
      test(`axe + touch targets: ${route} @${size.name} ${scheme}`, async ({ page }) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.emulateMedia({ colorScheme: scheme });
        if (!PUBLIC.includes(route)) await signIn(page, s.token, s.refresh);
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(1500); // route transition + skeletons settle
        const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
        const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 4).map((n) => n.target.join(" ") + " :: " + (JSON.stringify(n.any[0]?.data ?? n.all[0]?.data ?? n.none[0]?.data) ?? "").slice(0, 300)).join(" | ")} [${v.nodes.length}]`);
        const log = (what: string, items: string[]) => { if (process.env.A11Y_OUT && items.length) appendFileSync(process.env.A11Y_OUT, `${route} @${size.name} ${scheme} ${what}: ${JSON.stringify(items.slice(0, 15))}\n`); };
        log("axe", bad);
        expect.soft(bad, "axe serious/critical").toEqual([]);
        if (size.width === 360) {
          const small = await page.evaluate(() => {
            const out: string[] = [];
            const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch], [role=checkbox], summary';
            for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
              if (el.closest("[aria-hidden=true], [inert]")) continue;
              if (r.width <= 2 || r.height <= 2) continue; // visually hidden (skip links, sr-only, native check inputs inside a label)
              if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio" || el.type === "file")) {
                const lab = el.closest("label"); const lr = lab?.getBoundingClientRect();
                if (lr && lr.height >= 44) continue; if (cs.position === "absolute" && cs.clip !== "auto") continue;
              }
              if (el instanceof HTMLAnchorElement && cs.display === "inline" && el.closest("p, li, span, td, dd")) continue; // inline link in a sentence
              if (r.height < 43.5 || r.width < 43.5) {
                const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30);
                out.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${(el.className?.toString() ?? "").split(" ")[0]} "${name}" ${Math.round(r.width)}x${Math.round(r.height)}`);
              }
            }
            return out;
          });
          log(`small(${small.length})`, small);
          expect.soft(small.slice(0, 15), `controls under 44px (${small.length})`).toEqual([]);
        }
      });
      });
    }
  }
}
