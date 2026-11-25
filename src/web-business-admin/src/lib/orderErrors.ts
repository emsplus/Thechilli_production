/**
 * Plain-language messages for errors the counter can meet while taking an order (docs/ORDER_FLOW_AUDIT.md section 8,
 * finding C-22). The server's `error.code` decides the message; known raw `detail` texts from servers without codes are
 * matched as a fallback. Raw server text is never shown to the cashier.
 */
import { ApiError } from "./api";

export interface FriendlyError {
  /** One short sentence: what happened. */
  title: string;
  /** What to do next. */
  hint?: string;
  /** A retry can help (network, server busy). */
  retry: boolean;
}

/** Order-rule codes (pos-service phase4/order-rules, docs/ORDER_RULES.md) and older codes the counter can meet. */
const BY_CODE: Record<string, FriendlyError> = {
  kitchen_ticket_required: { title: "Send the order to the kitchen first", hint: "Tap Send to kitchen, then make the bill.", retry: false },
  table_has_open_order: { title: "This table already has an order", hint: "Add to that order, or pick another table.", retry: false },
  item_unavailable: { title: "A dish is sold out", hint: "Remove the dish marked Sold out, then try again.", retry: false },
  already_in_kitchen: { title: "The kitchen already has this dish", hint: "Ask a manager to cancel it.", retry: false },
  last_item: { title: "This is the only dish", hint: "To remove it, cancel the whole order.", retry: false },
  table_required: { title: "Pick a table first", hint: "Choose the table under Dine-in.", retry: false },
  bill_has_payment: { title: "This bill is already (partly) paid", hint: "Ask a manager to correct the bill.", retry: false },
  bill_already_exists: { title: "A bill already exists for this order", hint: "Use that bill, or ask a manager to change its discount.", retry: false },
  manager_required: { title: "A manager must do this", hint: "Ask the manager or owner to sign in and do it.", retry: false },
  variant_required: { title: "Choose Half or Full", hint: "Tap the dish in the order and choose the size.", retry: false },
  idempotency_conflict: { title: "This was already saved", hint: "Check the order before trying again.", retry: false },
  validation_error: { title: "Something in the order is not right", hint: "Check the dishes and quantities.", retry: false },
};

/** The session is gone (expired, signed out elsewhere). The counter also shows a sign-in prompt that keeps the order. */
export const SESSION_EXPIRED: FriendlyError = { title: "Session expired, sign in again", hint: "Your order is saved on this device.", retry: false };

/** Raw `detail` texts sent by servers without an error code. */
const BY_TEXT: [RegExp, FriendlyError][] = [
  [/less than or equal to 999|fractional part|greater than or equal to 1/i, { title: "That quantity is not possible", hint: "Use a number from 1 to 999.", retry: false }],
  [/menu item .* not found|archived|no longer available/i, { title: "A dish is no longer on the menu", hint: "Remove it from the order, then try again.", retry: false }],
  [/(indoor|dine-in) orders? require a table|table is required/i, { title: "Pick a table first", hint: "Choose the table under Dine-in.", retry: false }],
  [/already has an open order/i, BY_CODE.table_has_open_order],
  [/everything on this order is already in the kitchen/i, { title: "Everything on this order is already in the kitchen", retry: false }],
  [/no new items to send/i, { title: "The kitchen already has these items", retry: false }],
  [/already billed/i, { title: "This order already has a bill", hint: "Take payment, or ask a manager to change the bill.", retry: false }],
  [/was corrected and replaced|voided/i, { title: "This bill was changed by a manager", hint: "Open the order again from Orders.", retry: false }],
  [/idempotency/i, BY_CODE.idempotency_conflict],
  [/tax rule|place of supply|unknown outlet/i, { title: "GST settings are missing", hint: "Ask the owner to finish GST settings in Manage.", retry: false }],
  [/not synced yet|earlier operation failed/i, { title: "This order is still waiting for the internet", hint: "Wait until the order shows Sent, then try again.", retry: true }],
  [/missing permission|not allowed|forbidden/i, BY_CODE.manager_required],
  [/sold out|unavailable/i, BY_CODE.item_unavailable],
  [/already sent to the kitchen/i, { title: "The kitchen already has this dish", hint: "Ask a manager to cancel it.", retry: false }],
  [/only item: cancel the order/i, { title: "This is the only dish", hint: "To remove it, cancel the whole order.", retry: false }],
  [/discount/i, { title: "That discount is not allowed", hint: "Ask a manager or owner for a bigger discount.", retry: false }],
];

/** The friendly version of any error thrown by an order action. */
export function friendlyError(e: unknown): FriendlyError {
  if (!(e instanceof ApiError)) return { title: "That did not work", hint: "Please try again.", retry: true };
  if (e.status === 0) return { title: "No internet connection", hint: "Check the Wi-Fi, then try again.", retry: true };
  // 401 first: the server's own words ("Not authenticated") mean nothing to a cashier (QA D25).
  if (e.status === 401) return SESSION_EXPIRED;
  if (e.code && BY_CODE[e.code]) return BY_CODE[e.code];
  // Order-rule servers word every order refusal for the counter (docs/ORDER_RULES.md "plain words"): show it as it is.
  if (e.code && e.status >= 400 && e.status < 500 && e.message && e.message.length <= 200 && !/[{}<>]|idempotency|uuid|KOT|finaliz/i.test(e.message)) return { title: e.message, retry: false };
  for (const [re, f] of BY_TEXT) if (re.test(e.message)) return f;
  if (e.status === 403) return BY_CODE.manager_required;
  if (e.status === 404) return { title: "This order is no longer open", hint: "Check Orders, or start a new order.", retry: false };
  if (e.status === 409) return { title: "This order changed on another device", hint: "Check the order, then try again.", retry: true };
  if (e.status === 422) return BY_CODE.validation_error;
  if (e.status === 429) return { title: "Too many taps at once", hint: "Wait a moment, then try again.", retry: true };
  if (e.status >= 500) return { title: "The server had a problem", hint: "Please try again in a moment.", retry: true };
  return { title: "That did not work", hint: "Please try again.", retry: true };
}

/** 409 from "Send to kitchen" when another device (or tab) already sent everything: the order IS in the kitchen, the screen just has not caught up. */
export function isNothingToSend(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && /everything on this order is already in the kitchen/i.test(e.message);
}

/** A string field of the error body (`error.<k>`, `detail.<k>` or top-level), e.g. the existing order id of table_has_open_order. */
export function errorField(e: unknown, ...keys: string[]): string | null {
  if (!(e instanceof ApiError) || !e.data) return null;
  for (const k of keys) { const v = e.data[k]; if (typeof v === "string" && v) return v; }
  return null;
}
