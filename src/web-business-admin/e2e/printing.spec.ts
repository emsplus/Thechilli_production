import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { payCash, API, openAs, openMenuPos, seedMenu, type MenuSeed } from "./helpers";

// Restaurant printing: Manage -> Printers (hub pairing, printers, test print, recent prints), the POS "Print" action and auto-print.
// The spec plays the HUB itself through the hub endpoints (pair, heartbeat, long-poll jobs, post results) - no real printer needed.

const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "3120"}`;
const QUEUE = "BIXOLON SRP-330II";

interface HubJob { id: string; printer: { id: string; connection: string; host: string | null; system_name: string | null }; payload_b64: string; attempts: number }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const slip = (j: HubJob) => Buffer.from(j.payload_b64, "base64").toString("latin1"); // item names are plain ASCII inside the ESC/POS bytes

async function hubPair(request: APIRequestContext, code: string) {
  const r = await request.post(`${API}/print/hub/pair`, { data: { code, name: "Counter PC", os: "linux", version: "1.0.0" } });
  expect(r.status()).toBe(200);
  return (await r.json()).token as string;
}
async function hubBeat(request: APIRequestContext, token: string, status: Record<string, string> = {}) {
  const r = await request.post(`${API}/print/hub/heartbeat`, { headers: bearer(token), data: { version: "1.0.0", os: "linux", system_printers: [QUEUE, "Microsoft Print to PDF"], printer_status: status } });
  expect(r.status()).toBe(200);
}
/** Long-polls (short wait) until `want` jobs arrived. */
async function hubPull(request: APIRequestContext, token: string, want = 1): Promise<HubJob[]> {
  const got: HubJob[] = [];
  for (let i = 0; i < 8 && got.length < want; i++) got.push(...((await (await request.get(`${API}/print/hub/jobs?wait=2`, { headers: bearer(token) })).json()).jobs as HubJob[]));
  expect(got.length).toBeGreaterThanOrEqual(want);
  return got;
}
const hubResult = async (request: APIRequestContext, token: string, id: string, ok: boolean, error?: string) =>
  expect((await request.post(`${API}/print/hub/jobs/${id}/result`, { headers: bearer(token), data: { ok, error } })).status()).toBe(204);

const jobsOf = async (request: APIRequestContext, s: MenuSeed) =>
  (await (await request.get(`${API}/print/jobs?limit=100`, { headers: s.auth })).json()) as { id: string; printer_name: string; kind: string; status: string; reprint_no: number; last_error: string | null }[];

async function addPrinter(page: Page, fill: (d: ReturnType<Page["getByRole"]>) => Promise<void>) {
  await page.getByRole("button", { name: "Add printer" }).first().click();
  const d = page.getByRole("dialog");
  await fill(d);
  return d;
}

test("owner sets up printers and a hub, prints a test page, auto-prints bill and kitchen slips, reprints a failure, removes the hub", async ({ page, request }) => {
  test.setTimeout(300_000);
  const s = await seedMenu(request);
  // A second category so the kitchen printer's routing is visible.
  const drinks = await (await request.post(`${API}/menu/categories`, { headers: s.auth, data: { name: "Drinks" } })).json();
  expect((await request.post(`${API}/menu/items`, { headers: s.auth, data: { category_id: drinks.id, name: "Mango Lassi", price: "3.50", tax_kind: "standard" } })).status()).toBe(201);

  await openAs(page, s.token, "/manage?tab=printers", s.refresh);
  await expect(page.getByRole("heading", { name: "No print hub yet" })).toBeVisible();
  await expect(page.getByText(/small program on the PC at your counter/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "No printers yet" })).toBeVisible();

  // ---- Kitchen printer on the LAN, only the Mains category. Validation first.
  let d = await addPrinter(page, async (dlg) => {
    await dlg.getByLabel("Name").fill("Kitchen");
    await dlg.getByRole("radio", { name: "Kitchen" }).click();
    await dlg.getByRole("button", { name: "Add printer" }).click();
    await expect(dlg.getByText("Enter the printer's IP address")).toBeVisible();
    await dlg.getByLabel("Host (IP address)").fill("192.168.1.50");
    await dlg.getByLabel("Columns").fill("10");
    await dlg.getByRole("button", { name: "Add printer" }).click();
    await expect(dlg.getByText("24 to 64")).toBeVisible();
    await dlg.getByLabel("Columns").fill("42");
    await expect(dlg.getByText("Print only these categories; none selected = everything.")).toBeVisible();
    await dlg.getByLabel("Mains").check();
    await dlg.getByRole("switch", { name: "Print kitchen slip automatically" }).check();
    await dlg.getByRole("button", { name: "Add printer" }).click();
  });
  await expect(d).toBeHidden();
  const kitchen = page.locator('[data-printer="Kitchen"]');
  await expect(kitchen).toContainText("LAN 192.168.1.50:9100");
  await expect(kitchen).toContainText("Only: Mains");
  await expect(kitchen.getByTestId("printer-status")).toContainText("Unknown");
  await expect(kitchen.getByRole("switch", { name: "Print kitchen slip automatically" })).toBeChecked();

  // A server error (duplicate name) is shown on the field.
  d = await addPrinter(page, async (dlg) => {
    await dlg.getByLabel("Name").fill("Kitchen");
    await dlg.getByLabel("Host (IP address)").fill("192.168.1.51");
    await dlg.getByRole("button", { name: "Add printer" }).click();
    await expect(dlg.getByText(/already exists/)).toBeVisible();
    await dlg.getByRole("button", { name: "Cancel" }).click();
  });
  await expect(d).toBeHidden();

  // ---- Pairing: the code, the command, the countdown; the hub (this spec) uses the code.
  await page.getByRole("button", { name: "Connect a hub" }).first().click();
  const code = (await page.getByTestId("pairing-code").innerText()).trim();
  expect(code).toMatch(/^([A-Z2-9]{10}|\d{6})$/); // new servers: 10 upper-case letters and digits (no 0/O/1/I); older ones: 6 digits
  await expect(page.getByTestId("pairing-command")).toHaveText(`print-hub pair ${WEB} ${code}`);
  await expect(page.getByTestId("pairing-countdown")).toContainText(/Expires in 1[45]:\d\d/);
  await expect(page.getByRole("button", { name: "Copy command" })).toBeVisible();
  const hub = await hubPair(request, code);
  await expect(page.getByTestId("hub-row")).toHaveCount(1); // the list is polled while the code shows
  await expect(page.getByTestId("pairing")).toBeHidden();
  await expect(page.getByTestId("hub-row")).toContainText("Counter PC");
  await expect(page.getByTestId("hub-status")).toHaveText("Online");

  // ---- Test print while the hub is silent: queued, then the hub goes Offline in the UI.
  await kitchen.getByRole("button", { name: "Test print" }).click();
  await expect(kitchen.getByTestId("test-progress")).toContainText("Queued: waiting for the hub");
  await expect(page.getByTestId("hub-status")).toHaveText("Offline", { timeout: 90_000 });
  await expect(page.getByTestId("hub-row")).toContainText(/Last seen/);
  await expect(kitchen.getByTestId("test-progress")).toContainText("No print hub is online");

  // The hub comes back: heartbeat -> Online with its print queues, picks the job up, prints it.
  await hubBeat(request, hub);
  await expect(page.getByTestId("hub-status")).toHaveText("Online", { timeout: 30_000 });
  await expect(page.getByTestId("hub-row")).toContainText(QUEUE);
  const [test1] = await hubPull(request, hub);
  expect(test1.printer.connection).toBe("lan");
  expect(test1.payload_b64.length).toBeGreaterThan(20);
  await expect(kitchen.getByTestId("test-progress")).toContainText("Sent to the printer", { timeout: 15_000 });
  await hubResult(request, hub, test1.id, true);
  await expect(kitchen.getByTestId("test-progress")).toContainText("Printed", { timeout: 15_000 });

  // ---- Counter printer on USB/serial: the queue comes from the hub's list.
  d = await addPrinter(page, async (dlg) => {
    await dlg.getByLabel("Name").fill("Counter");
    await dlg.getByRole("radio", { name: "USB / serial" }).click();
    await dlg.getByLabel("Print queue on the hub PC").selectOption(QUEUE);
    await dlg.getByRole("button", { name: "My queue is not listed: type its name" }).click();
    await expect(dlg.getByLabel("Print queue name")).toBeVisible();
    await dlg.getByRole("button", { name: "Pick from the hub's list" }).click();
    await dlg.getByLabel("Print queue on the hub PC").selectOption(QUEUE);
    await expect(dlg.getByText("Use the ruler on the test slip.")).toBeVisible();
    await expect(dlg.getByText("Pick the one whose line on the test slip prints its accented letters cleanly (not as ?).")).toBeVisible();
    await dlg.getByRole("switch", { name: "Print bill automatically" }).check();
    await dlg.getByRole("button", { name: "Add printer" }).click();
  });
  await expect(d).toBeHidden();
  const counter = page.locator('[data-printer="Counter"]');
  await expect(counter).toContainText(`USB/serial via queue ${QUEUE}`);

  // The hub reports printer status: Kitchen online, Counter offline.
  const printers = (await (await request.get(`${API}/print/printers`, { headers: s.auth })).json()) as { id: string; name: string }[];
  const id = Object.fromEntries(printers.map((p) => [p.name, p.id]));
  await hubBeat(request, hub, { [id.Kitchen]: "online", [id.Counter]: "offline" });
  await expect(kitchen.getByTestId("printer-status")).toContainText("Online", { timeout: 20_000 });
  await expect(counter.getByTestId("printer-status")).toContainText("Offline", { timeout: 20_000 });

  // ---- POS: finalize a bill and place an order; the server queues the jobs.
  await openMenuPos(page, s);
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: /^Mango Lassi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  // the kitchen printer is automatic: placing the order sends the kitchen slip by itself (no "Send to kitchen" tap)
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();
  await expect(page.getByTestId("thermal-print-kot")).toBeVisible();
  await expect(page.getByTestId("thermal-print-kot").getByTestId("print-status")).toContainText("Kitchen: Queued: waiting for the hub");

  const [kot] = await hubPull(request, hub);
  expect(kot.printer.id).toBe(id.Kitchen);
  const text = slip(kot);
  expect(text).toMatch(/LAMB KARAHI/i);
  expect(text).not.toMatch(/MANGO LASSI/i); // the kitchen printer only takes Mains
  await hubResult(request, hub, kot.id, true);
  await expect(page.getByTestId("thermal-print-kot").getByTestId("print-status")).toContainText("Kitchen: Printed", { timeout: 15_000 });

  await page.getByRole("button", { name: "Make bill" }).click();
  const billActions = page.getByTestId("bill-actions");
  await expect(billActions.getByTestId("print-status")).toContainText("Counter: Queued: waiting for the hub", { timeout: 15_000 });
  await expect(billActions.getByRole("button", { name: "Print PDF" })).toBeVisible(); // the PDF fallback stays
  await expect(billActions.getByRole("button", { name: "Download PDF" })).toBeVisible();
  const bill = await hubPull(request, hub);
  expect(bill).toHaveLength(1);
  expect(bill[0].printer.id).toBe(id.Counter);
  expect(bill[0].printer.system_name).toBe(QUEUE);
  expect(slip(bill[0])).toMatch(/Lamb Karahi/);
  expect(slip(bill[0])).toMatch(/Mango Lassi/);
  // The printer is broken: five failed deliveries make the job failed.
  let job = bill[0];
  for (let i = 0; i < 5; i++) {
    await hubResult(request, hub, job.id, false, "printer queue not found: " + QUEUE);
    if (i < 4) job = (await hubPull(request, hub))[0];
  }
  await expect(billActions.getByTestId("print-status")).toContainText("Counter: Failed", { timeout: 15_000 });
  await expect(billActions.getByTestId("print-status")).toContainText("no print queue with that name");

  // "Print" in the POS sends it again; this time the hub prints it.
  await billActions.getByRole("button", { name: "Print", exact: true }).click();
  await expect(page.getByText("Sent to Counter")).toBeVisible();
  const [again] = await hubPull(request, hub);
  expect(again.printer.id).toBe(id.Counter);
  await hubResult(request, hub, again.id, true);
  await expect(billActions.getByTestId("print-status")).toContainText("Counter: Printed", { timeout: 15_000 });
  await payCash(page);
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();

  // ---- Recent prints: the failed bill shows its error and Reprint works.
  await page.goto("/manage?tab=printers");
  const failedRow = page.locator('[data-testid="job-row"][data-kind="bill"][data-status="failed"]');
  await expect(failedRow).toHaveCount(1);
  await expect(failedRow).toContainText("no print queue with that name");
  await expect(page.locator('[data-testid="job-row"][data-kind="kot"][data-status="printed"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="job-row"][data-kind="test"][data-status="printed"]')).toHaveCount(1);
  const before = (await jobsOf(request, s)).filter((j) => j.kind === "bill").length;
  await failedRow.getByRole("button", { name: "Reprint" }).click();
  await expect.poll(async () => (await jobsOf(request, s)).filter((j) => j.kind === "bill").length).toBe(before + 1);
  const [re] = await hubPull(request, hub);
  expect(re.printer.id).toBe(id.Counter);
  await hubResult(request, hub, re.id, true);
  await expect(page.locator('[data-testid="job-row"][data-kind="bill"][data-status="printed"]')).toHaveCount(2, { timeout: 15_000 });

  // ---- Toggles save, then removing the hub (revoke).
  await page.locator('[data-printer="Counter"]').getByRole("switch", { name: "Print bill automatically" }).uncheck();
  await expect.poll(async () => ((await (await request.get(`${API}/print/printers`, { headers: s.auth })).json()) as { name: string; auto_bill: boolean }[]).find((p) => p.name === "Counter")!.auto_bill).toBe(false);
  await page.getByRole("button", { name: "Remove Counter PC" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove hub" }).click();
  await expect(page.getByTestId("hub-row")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No print hub yet" })).toBeVisible();
  expect((await request.post(`${API}/print/hub/heartbeat`, { headers: bearer(hub), data: {} })).status()).toBe(401);

  // Deleting a printer asks first.
  await page.locator('[data-printer="Counter"]').getByRole("button", { name: "Delete Counter" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete printer" }).click();
  await expect(page.locator('[data-printer="Counter"]')).toHaveCount(0);
});

test("no printers: the POS looks and behaves exactly as before", async ({ page, request }) => {
  const s = await seedMenu(request);
  await openMenuPos(page, s);
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();
  await page.getByRole("button", { name: "Make bill" }).click();
  const actions = page.getByTestId("bill-actions");
  await expect(actions.getByRole("button", { name: "Print", exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Download PDF" })).toBeVisible();
  await page.waitForTimeout(1500); // the printer check has answered by now
  await expect(page.getByRole("button", { name: "Print PDF" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Print KOT slip", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("print-status")).toHaveCount(0);
  await payCash(page);
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();
  expect(await jobsOf(request, s)).toHaveLength(0);
});

test("only owners and managers see the Printers tab", async ({ page, browser, request }) => {
  const s = await seedMenu(request);
  const mk = async (role: string) => {
    const email = `${role}-${Date.now()}@example.in`;
    expect((await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: role, password: "supersecret123", role } })).status()).toBe(201);
    const t = await (await request.post(`${API}/auth/login`, { data: { email, password: "supersecret123" } })).json();
    return t.access_token as string;
  };
  // The printer API itself refuses a cashier.
  const cashier = await mk("cashier");
  expect((await request.get(`${API}/print/printers`, { headers: bearer(cashier) })).status()).toBe(403);
  await openAs(page, cashier, "/manage?tab=printers");
  await expect(page.getByText("Ask the owner or manager")).toBeVisible();
  await expect(page.getByRole("link", { name: "Printers", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("print-hub-card")).toHaveCount(0);

  const manager = await mk("manager");
  const ctx2 = await browser.newContext({ baseURL: process.env.E2E_BASE ?? `http://localhost:${process.env.E2E_WEB_PORT ?? "3120"}` });
  const page2 = await ctx2.newPage();
  await openAs(page2, manager, "/manage?tab=printers");
  await expect(page2.getByTestId("print-hub-card")).toBeVisible();
  await expect(page2.getByRole("link", { name: "Printers", exact: true })).toBeVisible();
});

test("a cashier sees Print as soon as a printer exists, even with auto-print off and no job yet", async ({ page, request }) => {
  const s = await seedMenu(request);
  expect((await request.post(`${API}/print/printers`, { headers: s.auth, data: { name: "Counter", role: "counter", connection: "system", system_name: QUEUE } })).status()).toBe(201);
  const email = `cashier-${Date.now()}@example.in`;
  expect((await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: "Cashier", password: "supersecret123", role: "cashier" } })).status()).toBe(201);
  const t = await (await request.post(`${API}/auth/login`, { data: { email, password: "supersecret123" } })).json();
  await openAs(page, t.access_token, "/pos");
  await expect(page.getByRole("button", { name: /^Lamb Karahi,/ })).toBeVisible();
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: "Make bill" }).click();
  const actions = page.getByTestId("bill-actions");
  await expect(actions.getByRole("button", { name: "Print PDF" })).toBeVisible(); // the thermal "Print" exists, so the PDF one is relabelled
  await actions.getByRole("button", { name: "Print", exact: true }).click();
  await expect(page.getByTestId("print-status")).toContainText("Counter");
  expect(await jobsOf(request, s)).toHaveLength(1); // one manual job, none came from auto-print
});


test("a kitchen printer that is NOT automatic leaves the Send to kitchen button in charge", async ({ page, request }) => {
  const s = await seedMenu(request);
  expect((await request.post(`${API}/print/printers`, { headers: s.auth, data: { name: "Kitchen", role: "kitchen", connection: "lan", host: "192.168.1.60", auto_kot: false } })).status()).toBe(201);
  await openMenuPos(page, s);
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: /Send to kitchen/ })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toHaveCount(0);
  expect(await jobsOf(request, s)).toHaveLength(0);
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();
  expect(await jobsOf(request, s)).toHaveLength(0); // no auto-print: nothing was queued by the tap either
});
