import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { isBlocked, ordersLeft, bannerText, bannerTone, billingApi, billingMissing, billsLeft, canTopUpOnline, chilli, chilliNumber, kindLabel, monthOf, paiseToRupees, parseRechargeRupees, rechargeProblem, rupees, shiftMonth, signedChilli, signedRupees, stateLabel, stateTone, walletBlock, type BillingBlock } from "./billing";

const block = (o: Partial<BillingBlock> = {}): BillingBlock => ({ state: "active", balance_paise: 25_000, per_bill_paise: 500, ...o });

describe("money in paise", () => {
  it("converts exactly", () => {
    expect(paiseToRupees(500)).toBe("5.00");
    expect(paiseToRupees(-500)).toBe("-5.00");
    expect(paiseToRupees(7)).toBe("0.07");
    expect(paiseToRupees(null)).toBe("0.00");
  });
  it("shows rupees with lakh / crore grouping", () => {
    expect(rupees(12_345_650)).toBe("₹1,23,456.50");
    expect(rupees(1_234_567_800)).toBe("₹1,23,45,678.00");
    expect(rupees(-500)).toBe("-₹5.00");
    expect(signedRupees(50_000)).toBe("+₹500.00");
    expect(signedRupees(-500)).toBe("-₹5.00");
  });
});

describe("Chilli (1 rupee = 1 Chilli, amounts arrive in paise)", () => {
  it("shows whole Chilli with Indian grouping", () => {
    expect(chilli(200_000)).toBe("2,000 Chilli");
    expect(chilli(500)).toBe("5 Chilli");
    expect(chilli(0)).toBe("0 Chilli");
    expect(chilli(12_345_600)).toBe("1,23,456 Chilli");
    expect(chilli(-500)).toBe("-5 Chilli");
    expect(chilliNumber(250)).toBe("2.50");
    expect(signedChilli(200_000)).toBe("+2,000 Chilli");
    expect(signedChilli(-500)).toBe("-5 Chilli");
  });
  it("recharge amounts are whole rupees between the limits", () => {
    expect(parseRechargeRupees("2,000")).toBe(2000);
    expect(parseRechargeRupees("₹ 5000")).toBe(5000);
    expect(parseRechargeRupees("20.5")).toBeNull();
    expect(parseRechargeRupees("abc")).toBeNull();
    expect(parseRechargeRupees("0")).toBeNull();
    expect(rechargeProblem("2000")).toBeNull();
    expect(rechargeProblem("1999")).toBe("The smallest recharge is ₹2,000");
    expect(rechargeProblem("100001")).toBe("The largest recharge is ₹1,00,000 at a time");
    expect(rechargeProblem("2000.5")).toMatch(/whole number/);
    expect(rechargeProblem("500", { min_topup_paise: 50_000, max_topup_paise: 10_000_000 })).toBeNull(); // limits come from the server
  });
});

describe("state and banner", () => {
  it("labels and tones", () => {
    expect(stateLabel("blocked")).toBe("Recharge needed");
    expect(stateLabel("grace")).toBe("Chilli used up");
    expect(stateTone(block({ state: "grace" }))).toBe("danger");
    expect(stateTone(block({ state: "blocked" }))).toBe("danger");
    expect(stateTone(block({ state: "trial" }))).toBe("info");
    expect(stateTone(block())).toBe("success");
    expect(stateTone(block({ state: "low" }))).toBe("warning");
    expect(stateTone(block({ state: "low", banner: { level: "critical", code: "grace" } }))).toBe("danger");
    expect(stateTone(block({ state: "suspended" }))).toBe("danger");
  });
  it("uses the server's English banner message", () => {
    const b = block({ state: "low", banner: { level: "critical", code: "grace", message: { en: "Chilli used up: 9 more bill(s) allowed. Recharge now.", hi: "..." } } });
    expect(bannerText(b)).toBe("Chilli used up: 9 more bill(s) allowed. Recharge now.");
    expect(bannerTone(b)).toBe("danger");
  });
  it("falls back to English text per code, never Hindi", () => {
    expect(bannerText(block({ state: "trial", days_left: 3, banner: { level: "warning", code: "trial_ending", message: null } }))).toBe("Your free trial ends in 3 days. Recharge to keep billing.");
    expect(bannerText(block({ state: "trial", days_left: 5, banner: { level: "info", code: "trial" } }))).toContain("each bill uses 5 Chilli");
    expect(bannerText(block({ state: "blocked", banner: null }))).toBe("Recharge to continue. You have no Chilli left for new orders.");
    expect(bannerText(block({ state: "empty", banner: null }))).toBe("Recharge to continue. You have no Chilli left for new orders."); // an older server's name for it
    expect(bannerText(block())).toBeNull();
    expect(bannerText(block({ state: "low", banner: { level: "warning", code: "low", message: { hi: "कम" } } }))).toBe("Your Chilli are running low. Recharge soon.");
  });
  it("bills left: server value, else balance / fee", () => {
    expect(billsLeft(block({ bills_left: 9 }))).toBe(9);
    expect(billsLeft(block({ balance_paise: 2_499 }))).toBe(4);
    expect(billsLeft(block({ balance_paise: -500 }))).toBe(0);
  });
  it("ledger kinds", () => {
    expect(kindLabel("bill_fee")).toBe("Bill");
    expect(kindLabel("topup")).toBe("Recharge");
    expect(kindLabel("void_credit_back")).toBe("Voided bill, Chilli returned");
    expect(kindLabel("something_new")).toBe("something new");
  });
  it("online top-up only when the server allows it and the user may top up", () => {
    expect(canTopUpOnline(block({ topup_online: false }), true)).toBe(false);
    expect(canTopUpOnline(block({ topup_online: true }), false)).toBe(false);
    expect(canTopUpOnline(block({ topup_online: true }), true)).toBe(true);
    expect(canTopUpOnline(null, true)).toBe(false);
  });
});

describe("grace: 20 orders after zero", () => {
  const g = (o: Partial<BillingBlock> = {}) => block({ state: "grace", balance_paise: 0, grace_paise: 10_000, ...o });
  it("orders left from the server, else from balance and grace", () => {
    expect(ordersLeft(g({ orders_left: 7 }))).toBe(7);
    expect(ordersLeft(g())).toBe(20);
    expect(ordersLeft(g({ balance_paise: -9_500 }))).toBe(1);
    expect(ordersLeft(block())).toBeNull();
  });
  it("says 'N orders left before billing stops' in grace and only blocks when blocked", () => {
    expect(bannerText(g({ banner: null }))).toBe("20 orders left before billing stops. Recharge now.");
    expect(bannerText(g({ balance_paise: -9_500, banner: { level: "critical", code: "grace" } }))).toBe("1 order left before billing stops. Recharge now.");
    expect(bannerText(g({ banner: { level: "critical", code: "grace", message: { en: "5 orders left before billing stops. Recharge now." } } }))).toBe("5 orders left before billing stops. Recharge now.");
    expect(isBlocked(g())).toBe(false);
    expect(isBlocked(block({ state: "blocked" }))).toBe(true);
    expect(isBlocked(block({ state: "empty" }))).toBe(true);
    expect(bannerText(block({ state: "blocked", balance_paise: -10_000 }))).toMatch(/^Recharge to continue/);
  });
});

describe("402 at the counter", () => {
  it("chilli_empty on a new order -> plain English, open orders keep working", () => {
    const w = walletBlock(new ApiError(402, "Recharge to continue. You have no Chilli left, so new orders are paused.", "chilli_empty"));
    expect(w?.code).toBe("chilli_empty");
    expect(w?.title).toBe("Recharge to continue. No Chilli left for new orders");
    expect(w?.description).toMatch(/already open can still be billed and paid/);
  });
  it("billing_suspended", () => {
    expect(walletBlock(new ApiError(402, "Billing is paused by Chilli support.", "billing_suspended"))?.code).toBe("billing_suspended");
  });
  it("a 402 without a code, or the older wallet_empty, reads as no Chilli; other errors are not ours", () => {
    expect(walletBlock(new ApiError(402, "Payment required"))?.code).toBe("chilli_empty");
    expect(walletBlock(new ApiError(402, "x", "wallet_empty"))?.code).toBe("chilli_empty");
    expect(walletBlock(new ApiError(409, "Already billed", "conflict"))).toBeNull();
    expect(walletBlock(new Error("x"))).toBeNull();
  });
  it("billingMissing: only a bare route miss", () => {
    expect(billingMissing(new ApiError(404, "Not Found"))).toBe(true);
    expect(billingMissing(new ApiError(405, "x"))).toBe(true);
    expect(billingMissing(new ApiError(503, "Chilli credit details are temporarily unavailable.", "billing_unavailable"))).toBe(false);
  });
});

describe("months", () => {
  it("monthOf uses India time", () => {
    expect(monthOf(new Date("2026-10-31T19:00:00Z"))).toBe("2026-11"); // 00:30 IST on 1 Nov
    expect(monthOf(new Date("2026-10-31T10:00:00Z"))).toBe("2026-10");
  });
  it("shiftMonth crosses years", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});

describe("billingApi (fetch mocked)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("ledger sends filters and paging", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ items: [], total: 0, limit: 20, offset: 40 }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await billingApi.ledger({ kind: "bill_fee", from: "2026-11-01", limit: 20, offset: 40 });
    expect(String((f.mock.calls[0] as unknown as [string])[0])).toMatch(/\/billing\/ledger\?from=2026-11-01&kind=bill_fee&limit=20&offset=40$/);
  });
  it("recharge: intent posts whole paise, status polls by id", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ intent: { id: "abc", status: "created", amount_paise: 200000 }, checkout: { url: "https://rzp.io/i/x" } }), { status: 201 }));
    vi.stubGlobal("fetch", f);
    const r = await billingApi.topupIntent(200_000);
    expect(r.checkout.url).toBe("https://rzp.io/i/x");
    const call = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toMatch(/\/billing\/topups\/intent$/);
    expect(JSON.parse(String(call[1].body))).toEqual({ amount_paise: 200000 });
    await billingApi.topupStatus("abc");
    expect(String((f.mock.calls[1] as unknown as [string])[0])).toMatch(/\/billing\/topups\/abc$/);
  });
  it("503 billing_unavailable keeps its code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Your Chilli balance is temporarily unavailable. Billing itself keeps working.", error: { code: "billing_unavailable", message: "x" } }), { status: 503 })));
    await expect(billingApi.usage("2026-11")).rejects.toMatchObject({ status: 503, code: "billing_unavailable" });
  });
});
