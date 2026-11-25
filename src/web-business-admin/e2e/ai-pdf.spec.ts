import { expect, test, type Page, type Route } from "@playwright/test";
import { API, openAs, seedMenu, type MenuSeed } from "./helpers";

// "Ask the AI, get a PDF": only POST /ai/chat (and, for history, the conversation reads) are mocked; the PDF url points at the REAL report route.

const newKey = () => crypto.randomUUID();
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };

/** One paid takeaway bill, so the PDF has something to show; returns the restaurant-local date. */
async function seedDay(request: Parameters<typeof seedMenu>[0]) {
  const s = await seedMenu(request);
  const o = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: newKey(), order_type: "takeaway", table_id: null, lines: [{ item_id: s.items["Lamb Karahi"].id, quantity: 2 }] } })).json();
  const b = await (await request.post(`${API}/orders/${o.id}/bill`, { headers: s.auth, data: {} })).json();
  expect((await request.post(`${API}/bills/${b.id}/payments`, { headers: s.auth, data: { idempotency_key: newKey(), method: "card", amount: b.total } })).status()).toBe(201);
  const tz = (await (await request.get(`${API}/restaurant`, { headers: s.auth })).json()).timezone as string;
  return { s, day: new Date().toLocaleDateString("en-CA", { timeZone: tz }) };
}

const attachment = (day: string) => ({
  kind: "sales_summary", title: "Sales summary", from: day, to: day, filename: `karahi-test_sales_summary_${day}_${day}.pdf`,
  url: `/api/v1/reports/pdf?kind=sales_summary&from=${day}&to=${day}`,
});

const panel = (page: Page) => page.getByRole("complementary", { name: "AI assistant" });
async function openAi(page: Page, s: MenuSeed) {
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(page.getByRole("button", { name: /^Lamb Karahi,/ })).toBeVisible();
  await page.getByRole("button", { name: "AI assistant", exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

async function mockChat(page: Page, reply: (body: { message: string }) => object) {
  const sent: { message: string; conversation_id?: string }[] = [];
  await page.route("**/ai/chat", async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const body = route.request().postDataJSON();
    sent.push(body);
    await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(reply(body)) });
  });
  return sent;
}

async function expectPdf(download: import("@playwright/test").Download) {
  const path = await download.path();
  const head = (await import("node:fs")).readFileSync(path).subarray(0, 5).toString("latin1");
  expect(head).toBe("%PDF-");
}

test("the assistant's PDF shows as a Download PDF button and downloads the real report", async ({ page, request }) => {
  const { s, day } = await seedDay(request);
  const sent = await mockChat(page, () => ({ conversation_id: newKey(), answer: "Here is last week's sales report.", tools_used: [], attachments: [attachment(day)] }));
  await openAi(page, s);
  await panel(page).getByLabel("Your question").fill("Pichhle hafte ki sales ka PDF do");
  await panel(page).getByRole("button", { name: "Ask", exact: true }).click();
  await expect(panel(page).getByText("Here is last week's sales report.")).toBeVisible();
  expect(sent[0].message).toBe("Pichhle hafte ki sales ka PDF do");

  const list = panel(page).getByRole("list", { name: "PDF reports" });
  await expect(list).toContainText("Sales summary");
  const btn = list.getByRole("button", { name: /Download PDF/ });
  await expect(btn).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent("download"), btn.click()]);
  expect(dl.suggestedFilename()).toBe(`karahi-test_sales_summary_${day}_${day}.pdf`);
  await expectPdf(dl);
  await expect(btn).toBeEnabled();
});

test("a failed PDF download shows a friendly message and the button works again", async ({ page, request }) => {
  const { s, day } = await seedDay(request);
  await mockChat(page, () => ({ conversation_id: newKey(), answer: "Report ready.", tools_used: [], attachments: [{ ...attachment(day), url: `/api/v1/reports/pdf?kind=sales_summary&from=${day}&to=2000-01-01` }] }));
  await openAi(page, s);
  await panel(page).getByLabel("Your question").fill("sales pdf");
  await page.keyboard.press("Enter");
  const btn = panel(page).getByRole("button", { name: /Download PDF/ });
  await btn.click();
  await expect(page.getByText(/Could not create the PDF|too long|Only the owner/).first()).toBeVisible();
  await expect(btn).toBeEnabled();
});

test("quick questions: six areas, tapping sends the exact text, and Ideas stays available once the chat has started", async ({ page, request }) => {
  const { s } = await seedDay(request);
  const sent = await mockChat(page, (b) => ({ conversation_id: "11111111-1111-4111-8111-111111111111", answer: `Answer to: ${b.message}`, tools_used: [] }));
  await openAi(page, s);
  const areas = ["Sales & Billing", "Inventory & Purchase", "Kitchen Operations & Food Cost", "Finance & Profitability", "Staff & Customer Management", "AI Analytics & Revenue Leakage"];
  for (const a of areas) await expect(panel(page).getByRole("button", { name: a, exact: true })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Question ideas" })).toHaveCount(0); // empty chat: the list itself is on screen

  await panel(page).getByRole("button", { name: "How much did I sell today?", exact: true }).click();
  await expect(panel(page).getByText("Answer to: How much did I sell today?")).toBeVisible();
  expect(sent[0]).toMatchObject({ message: "How much did I sell today?" });

  await panel(page).getByRole("button", { name: "Question ideas" }).click();
  const ideas = panel(page).getByRole("region", { name: "Question ideas" });
  await ideas.getByRole("button", { name: "AI Analytics & Revenue Leakage" }).click();
  await ideas.getByRole("button", { name: "Leakage report PDF for this month", exact: true }).click();
  await expect(ideas).toHaveCount(0);
  await expect(panel(page).getByText("Answer to: Leakage report PDF for this month")).toBeVisible();
  expect(sent[1]).toMatchObject({ message: "Leakage report PDF for this month", conversation_id: "11111111-1111-4111-8111-111111111111" });
});

test("the ideas strip stays above the message box after every question, so the next one is one tap away", async ({ page, request }) => {
  const { s } = await seedDay(request);
  const sent = await mockChat(page, (b) => ({ conversation_id: "33333333-3333-4333-8333-333333333333", answer: `Answer to: ${b.message}`, tools_used: [] }));
  await openAi(page, s);
  const strip = panel(page).getByRole("group", { name: "Ask about" });
  await expect(strip).toHaveCount(0); // empty chat: the big list is shown instead
  await panel(page).getByRole("button", { name: "Which dishes sell best this week?", exact: true }).click();
  await expect(panel(page).getByText("Answer to: Which dishes sell best this week?")).toBeVisible();
  // after the first question the strip is there, and it stays there after the second one
  await expect(strip).toBeVisible();
  for (const [area, q] of [["Staff & Customer Management", "Who are my best customers?"], ["Inventory & Purchase", "Which items are low on stock?"]] as const) {
    await strip.getByRole("button", { name: area }).click();
    await panel(page).getByRole("group", { name: `${area}: questions` }).getByRole("button", { name: q, exact: true }).click();
    await expect(panel(page).getByText(`Answer to: ${q}`)).toBeVisible();
    await expect(strip).toBeVisible();
    await expect(panel(page).getByRole("group", { name: `${area}: questions` })).toHaveCount(0); // closed after sending
  }
  expect(sent.map((m) => m.message)).toEqual(["Which dishes sell best this week?", "Who are my best customers?", "Which items are low on stock?"]);
  expect(sent[2].conversation_id).toBe("33333333-3333-4333-8333-333333333333");
  await panel(page).getByRole("button", { name: "New chat" }).click();
  await expect(strip).toHaveCount(0); // a new empty chat shows the big list again
});

test("a PDF in an older conversation still has its button when the chat is restored from history", async ({ page, request }) => {
  const { s, day } = await seedDay(request);
  const cid = "22222222-2222-4222-8222-222222222222";
  const json = (route: Route, body: unknown) => route.request().method() === "OPTIONS" ? route.fulfill({ status: 204, headers: CORS }) : route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/ai/conversations", (r) => json(r, [{ id: cid, title: "Last week's sales PDF", created_at: new Date().toISOString() }]));
  await page.route(`**/ai/conversations/${cid}`, (r) => json(r, { id: cid, title: "Last week's sales PDF", created_at: new Date().toISOString(), messages: [
    { role: "user", content: "Pichhle hafte ki sales ka PDF do", tool_calls: null, attachments: [], created_at: new Date().toISOString() },
    { role: "model", content: "Here it is.", tool_calls: [], attachments: [attachment(day)], created_at: new Date().toISOString() },
  ] }));
  await openAi(page, s);
  await panel(page).getByRole("button", { name: "Past chats" }).click();
  await page.getByRole("button", { name: /Last week's sales PDF/ }).click();
  const btn = panel(page).getByRole("button", { name: /Download PDF/ });
  await expect(btn).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent("download"), btn.click()]);
  await expectPdf(dl);
});
