import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { openAs } from "./helpers";
import { apiSession, installHarness, qa, seedOwner, tickets, wipeTickets, type OwnerMenu } from "./voice-qa-harness";

/**
 * Hostile end-to-end pass (owner, 2026-11-02; docs/VOICE_QA_REPORT.md "Hostile pass"): the owner's real flows, HOSTILE_N times
 * each (default 30), through the scripted recogniser with Chrome-like behaviour: word-by-word interims, a final, sometimes the
 * wake phrase only in the 2nd guess, a delayed final, a no-speech end and restart, two people talking. One failure is recorded
 * per iteration and the test fails with the list.
 */
const N = Number(process.env.HOSTILE_N ?? 30);
test.use({ viewport: { width: 1280, height: 800 } });

type Flow = (ctx: { page: Page; m: OwnerMenu; i: number; rnd: () => number; orders: () => Promise<{ lines: { item_name: string; quantity: number }[] }[]>; kots: () => Promise<unknown[]> }) => Promise<void>;
const sheet = (page: Page) => page.getByRole("dialog");
const cart = async (page: Page) => (await tickets(page)).flatMap((t) => [...t.lines, ...t.more]).map((l) => `${l.name} x${l.qty}`).sort();

/** Says `text` like Chrome: interims word by word, sometimes a delayed final, sometimes a no-speech end + restart after it. */
async function speak(page: Page, rnd: () => number, text: string, opts: { alts?: string[] } = {}) {
  const ws = text.split(" ");
  for (let k = 1; k < ws.length; k++) { await qa(page, "interim", ws.slice(0, k).join(" ")); await page.waitForTimeout(rnd() < 0.8 ? 30 : 250); }
  if (rnd() < 0.3) await page.waitForTimeout(600 + rnd() * 900); // a delayed final
  if (opts.alts) await qa(page, "finalAlts", [opts.alts[0], text, ...opts.alts.slice(1)]); else await qa(page, "final", text);
  if (rnd() < 0.2) { await page.waitForTimeout(100); await qa(page, "error", "no-speech"); } // Chrome ends the session after a pause
}
async function waiting(page: Page) {
  await expect.poll(() => qa(page, "newestListening"), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("auto-status")).toHaveText(/Waiting for “Hey Zonov”/, { timeout: 30_000 });
}

async function run(name: string, page: Page, context: BrowserContext, request: APIRequestContext, flow: Flow, init: { direct?: boolean; veg?: boolean; foodTypes?: boolean } = {}) {
  test.setTimeout(N * 60_000 + 120_000);
  const m = await seedOwner(request);
  const api = `http://localhost:${process.env.E2E_API_PORT ?? "8120"}/api/v1`;
  if (init.foodTypes) for (const [n, ft] of [["Butter Chicken", "non_veg"], ["Chicken Biryani", "non_veg"], ["Mutton Biryani", "non_veg"], ["Matar Paneer", "veg"], ["Sweet Lassi", "veg"], ["Mango Lassi", "veg"], ["Tandoori Roti", "veg"], ["Dal Makhani", "veg"], ["Garlic Naan", "veg"], ["Jeera Rice", "veg"]] as const)
    await request.patch(`${api}/menu/items/${m.ids[n]}`, { headers: m.auth, data: { food_type: ft } });
  await context.grantPermissions(["microphone"]);
  await installHarness(page, { handsFree: true, silenceMs: 4000, busyAfterCloseMs: 300 });
  await page.addInitScript(([direct, veg]) => {
    localStorage.setItem("pos.voiceDirect", direct ? "1" : "0");
    if (veg) localStorage.setItem("pos.vegOnly", "1"); else localStorage.removeItem("pos.vegOnly");
    (window as unknown as Record<string, unknown>).__POS_VOICE_WATCHDOG = { startGraceMs: 1500, silentMaxMs: 3000, deafMs: 3000 };
    (window as unknown as Record<string, unknown>).__POS_VOICE_RETRY_MS = 1500;
  }, [!!init.direct, !!init.veg] as const);
  const srv = apiSession(request, m);
  await srv.login();
  const orders = () => srv.get<{ lines: { item_name: string; quantity: number }[] }[]>("/orders");
  const kots = () => srv.get<unknown[]>("/kot");
  await openAs(page, m.token, "/pos", m.refresh);
  let seed = name.length * 7919;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const failures: string[] = [];
  for (let i = 0; i < N; i++) {
    try {
      await wipeTickets(page);
      await page.reload();
      await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible();
      await waiting(page);
      await flow({ page, m, i, rnd, orders, kots });
    } catch (e) {
      failures.push(`#${i}: ${(e as Error).message.split("\n").filter(Boolean).slice(0, 3).join(" | ").slice(0, 300)}`);
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  console.log(`HOSTILE ${name}: ${failures.length}/${N} failed\n${failures.join("\n")}`);
  expect(failures, name).toEqual([]);
}

const DISHES: [string, string][] = [["matar paneer", "Matar Paneer"], ["lassi", "Sweet Lassi"], ["mango lassi", "Mango Lassi"], ["chapati", "Tandoori Roti"], ["dal makhani", "Dal Makhani"], ["garlic naan", "Garlic Naan"]];
const QTY: [string, number][] = [["one", 1], ["two", 2], ["ek", 1], ["do", 2], ["teen", 3], ["four", 4]];

test("hostile: wake + several dishes + done", async ({ page, context, request }) => {
  await run("wake-done", page, context, request, async ({ page, rnd }) => {
    const picks = [...DISHES].sort(() => rnd() - 0.5).slice(0, 2 + Math.floor(rnd() * 3));
    const said = picks.map((d) => { const q = QTY[Math.floor(rnd() * QTY.length)]; return { t: `${q[0]} ${d[0]}`, want: `${d[1]} x${q[1]}` }; });
    const wake = ["hey zonov", "hey jonov", "Zonov", "hey sonov", "a zonov"][Math.floor(rnd() * 5)];
    await speak(page, rnd, `${wake} ${said.map((s) => s.t).join(", ")}, done`, rnd() < 0.3 ? { alts: [`hey Jonas ${said.map((s) => s.t).join(", ")}, done`] } : {});
    await expect.poll(() => cart(page), { timeout: 15_000 }).toEqual(said.map((s) => s.want).sort());
    await expect(sheet(page)).toHaveCount(0);
  });
});

test("hostile: direct add on the selected bill", async ({ page, context, request }) => {
  await run("direct", page, context, request, async ({ page, rnd }) => {
    const d = DISHES[Math.floor(rnd() * DISHES.length)], q = QTY[Math.floor(rnd() * QTY.length)];
    await speak(page, rnd, `${q[0]} ${d[0]}`);
    await expect.poll(() => cart(page), { timeout: 15_000 }).toEqual([`${d[1]} x${q[1]}`]);
    await speak(page, rnd, "kal subah jaldi aana bhai"); // talk around the counter
    await page.waitForTimeout(500);
    expect(await cart(page)).toEqual([`${d[1]} x${q[1]}`]);
  }, { direct: true });
});

test("hostile: the same dish twice (other spellings) is one line", async ({ page, context, request }) => {
  await run("repeat", page, context, request, async ({ page, rnd }) => {
    const second = ["butter chicken", "butter chican", "butter chiken", "butter chicin", "बटर चिकन"][Math.floor(rnd() * 5)];
    await speak(page, rnd, `hey zonov one butter chicken, ek ${second}, done`);
    await expect.poll(() => cart(page), { timeout: 15_000 }).toEqual(["Butter Chicken x2"]);
  });
});

test("hostile: modifiers and notes stay on the dish", async ({ page, context, request }) => {
  await run("notes", page, context, request, async ({ page, rnd }) => {
    const [mod, note] = ([["no onion", "No onion"], ["bina pyaaz ke", "No onion"], ["extra spicy", "Extra spicy"], ["butter kam dalna", "Less butter"], ["less butter", "Less butter"], ["jain", "Jain"]] as const)[Math.floor(rnd() * 6)];
    await speak(page, rnd, `hey zonov ek butter chicken full, ${mod}, done`);
    await expect.poll(async () => (await tickets(page)).flatMap((t) => t.lines).map((l) => `${l.name} x${l.qty}`), { timeout: 15_000 }).toEqual(["Butter Chicken x1"]);
    const notes = await page.evaluate(() => new Promise<string[]>((res) => { const r = indexedDB.open("pos-offline"); r.onsuccess = () => { const q = r.result.transaction("drafts").objectStore("drafts").getAll(); q.onsuccess = () => res((q.result as { data: { lines: { note?: string; variantId: string | null }[] } }[]).flatMap((d) => d.data.lines.map((l) => l.note ?? ""))); }; }));
    expect(notes[0] ?? "").toMatch(new RegExp(note.split(" ")[0], "i"));
  });
});

test("hostile: place order countdown, then 'ruko' (nothing placed) or let it run (placed + 1 KOT)", async ({ page, context, request }) => {
  await run("place-stop", page, context, request, async ({ page, rnd, orders, kots }) => {
    const before = (await orders()).length, kb = (await kots()).length;
    const stop = rnd() < 0.5;
    await speak(page, rnd, "hey zonov ek matar paneer, place order");
    await expect(page.getByTestId("voice-countdown")).toBeVisible({ timeout: 15_000 });
    if (stop) {
      await qa(page, "final", ["ruko", "stop", "nahi", "cancel", "wait"][Math.floor(rnd() * 5)]);
      await expect.poll(() => cart(page), { timeout: 15_000 }).toEqual(["Matar Paneer x1"]);
      await page.waitForTimeout(3500);
      expect((await orders()).length).toBe(before);
    } else {
      await expect.poll(async () => (await kots()).length, { timeout: 30_000 }).toBe(kb + 1);
      expect((await orders()).length).toBe(before + 1);
    }
  });
});

test("hostile: Veg only (non-veg not added; biryani -> a veg one)", async ({ page, context, request }) => {
  const m = test.info();
  void m;
  await run("veg", page, context, request, async ({ page, rnd }) => {
    if (rnd() < 0.5) {
      await speak(page, rnd, "hey zonov one butter chicken, one dal makhani, done");
      await expect.poll(() => cart(page), { timeout: 15_000 }).toEqual(["Dal Makhani x1"]);
      await expect(sheet(page).getByTestId("voice-veg-veto")).toBeVisible();
    } else {
      await speak(page, rnd, "hey zonov ek biryani, done");
      await expect.poll(() => cart(page), { timeout: 15_000 }).toEqual([]); // no veg biryani on this menu: both are non-veg
      await expect(sheet(page).getByTestId("voice-veg-veto")).toBeVisible();
    }
  }, { veg: true, foodTypes: true });
});

test("hostile: switching bills mid-sentence ('bill 2 ...')", async ({ page, context, request }) => {
  await run("bill-switch", page, context, request, async ({ page, rnd }) => {
    await page.getByRole("button", { name: /^New/ }).first().dispatchEvent("click");
    await page.getByRole("tablist", { name: "Open orders" }).getByRole("tab").first().click();
    await waiting(page);
    await speak(page, rnd, `hey zonov ${rnd() < 0.5 ? "bill 2" : "bill number 2"}, do lassi, done`);
    await expect.poll(async () => (await tickets(page)).find((t) => t.no === 2)?.lines.map((l) => `${l.name} x${l.qty}`), { timeout: 15_000 }).toEqual(["Sweet Lassi x2"]);
    expect((await tickets(page)).find((t) => t.no === 1)?.lines ?? []).toEqual([]);
  });
});

test("hostile: a sold-out dish stays, the rest is added", async ({ page, context, request }) => {
  await run("sold-out", page, context, request, async ({ page, rnd }) => {
    await speak(page, rnd, "hey zonov one jeera rice, two lassi, done");
    await expect.poll(() => cart(page), { timeout: 15_000 }).toEqual(["Sweet Lassi x2"]);
    await expect(sheet(page).getByTestId("voice-sold-out")).toBeVisible();
  });
});

test("hostile: Hindi and Hinglish", async ({ page, context, request }) => {
  await run("hindi", page, context, request, async ({ page, rnd }) => {
    const [t, want] = ([["हे ज़ोनोव दो मटर पनीर, एक लस्सी, हो गया", ["Matar Paneer x2", "Sweet Lassi x1"]], ["hey zonov do matar paneer aur ek lassi, bas itna", ["Matar Paneer x2", "Sweet Lassi x1"]],
      ["हे जोनोव तीन चपाती, हो गया", ["Tandoori Roti x3"]], ["hey jonov ek dal makhani, teen chapati, ho gaya", ["Dal Makhani x1", "Tandoori Roti x3"]]] as const)[Math.floor(rnd() * 4)];
    await speak(page, rnd, t);
    await expect.poll(() => cart(page), { timeout: 15_000 }).toEqual([...want].sort());
  });
});

test("hostile: two people talking", async ({ page, context, request }) => {
  await run("two-people", page, context, request, async ({ page, rnd }) => {
    await speak(page, rnd, "table five wants water and the bill");
    await speak(page, rnd, "hey zonov one mango lassi, done");
    await speak(page, rnd, "haan bhai kal aana, do minute");
    await page.waitForTimeout(600);
    expect(await cart(page)).toEqual(["Mango Lassi x1"]);
  });
});

test("hostile: long silence, then speaking", async ({ page, context, request }) => {
  await run("silence", page, context, request, async ({ page, rnd }) => {
    await page.waitForTimeout(3500 + rnd() * 4000); // the shortened watchdog recycles the recogniser in this time
    await waiting(page);
    await speak(page, rnd, "hey zonov two chapati, done");
    await expect.poll(() => cart(page), { timeout: 15_000 }).toEqual(["Tandoori Roti x2"]);
  });
});

test("hostile: tab switched away and back", async ({ page, context, request }) => {
  await run("tab", page, context, request, async ({ page, rnd }) => {
    await qa(page, "hide", true);
    await page.waitForTimeout(300 + rnd() * 1500);
    await qa(page, "hide", false);
    await waiting(page);
    await speak(page, rnd, "hey zonov one matar paneer, done");
    await expect.poll(() => cart(page), { timeout: 15_000 }).toEqual(["Matar Paneer x1"]);
  });
});
