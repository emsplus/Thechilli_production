import { charcoal, contrastRatio, darkColors, lightColors } from "@chilli/tokens";
import type { DeliverySettings } from "./deliveryApi";
import { qrMatrix, qrPath } from "./qr";

/** Pure logic of the "Your ordering link" card (Manage > Delivery). The screen is src/app/manage/_components/OrderLinkCard.tsx. */

// ---- Which state the card is in ---------------------------------------------------------------------------------
export type LinkView = "legacy" | "off" | "on" | "on_no_url";

const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\/\S+$/.test(u);

/**
 * `legacy`: the server has no switch (older pos-service): the old read-only link. `off`: the owner's switch is off.
 * `on`: switch on and the server gave a link. `on_no_url`: switch on, but no link now (the online ordering service did not answer or says it is off).
 */
export function linkView(s: Pick<DeliverySettings, "public_order_enabled" | "public_order_url">): LinkView {
  if (typeof s.public_order_enabled !== "boolean") return "legacy";
  if (!s.public_order_enabled) return "off";
  return isHttp(s.public_order_url) ? "on" : "on_no_url";
}

// ---- Failures of PUT /delivery/settings for the link part --------------------------------------------------------
export type LinkFailureKind = "off" | "not_connected" | "unavailable" | "offline" | "other";
export interface LinkFailure {
  kind: LinkFailureKind;
  /** Plain words for the owner. For a 502 it is the server's own sentence ("...Your other settings were saved. Please try again in a minute."). */
  message: string;
  /** The saved settings carried by a 502 body: use them instead of the stale screen state. */
  settings?: DeliverySettings;
}

const LINK_OFF_TEXT = "The link is off. Turn it on first, then you can make a new link or change its colour.";
const FALLBACK = "We could not change the link. Please try again.";

/** Reads an ApiError (status, code, message, data) without importing it, so it stays unit-testable. */
export function linkFailure(e: unknown): LinkFailure {
  const x = (e && typeof e === "object" ? e : {}) as { status?: unknown; code?: unknown; message?: unknown; data?: unknown };
  const message = typeof x.message === "string" && x.message ? x.message : FALLBACK;
  if (x.status === 0) return { kind: "offline", message: "No connection. Try again when online." };
  if (x.status === 409 && x.code === "public_order_link_off") return { kind: "off", message: LINK_OFF_TEXT };
  if (x.status === 502 && x.code === "delivery_service_unavailable") {
    const raw = x.data && typeof x.data === "object" ? (x.data as { settings?: unknown }).settings : undefined;
    const settings = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as DeliverySettings) : undefined;
    // Same code for three cases; the server's sentence tells them apart ("not connected yet", "does not know this restaurant yet", "could not reach").
    const notConnected = /not connected|does not know this restaurant/i.test(message);
    return { kind: notConnected ? "not_connected" : "unavailable", message, settings };
  }
  return { kind: "other", message };
}

// ---- Share --------------------------------------------------------------------------------------------------------
export const SHARE_TEXT = "Order from us online:";

/** WhatsApp link for browsers without the Web Share API: opens the chat picker with the text and the link. */
export function whatsappShareUrl(link: string, text = SHARE_TEXT): string {
  return `https://wa.me/?text=${encodeURIComponent(`${text} ${link}`)}`;
}

export function canNativeShare(nav: { share?: unknown } | undefined): boolean {
  return !!nav && typeof nav.share === "function";
}

// ---- Brand colour -------------------------------------------------------------------------------------------------
const HEX6 = /^#[0-9A-Fa-f]{6}$/;
export const isBrandColor = (v: string) => HEX6.test(v);

/** What the owner typed, as the server wants it: trimmed, `#` added to six hex digits, upper case. Anything else is returned trimmed. */
export function normalizeBrandColor(input: string): string {
  const t = input.trim();
  const h = /^[0-9A-Fa-f]{6}$/.test(t) ? `#${t}` : t;
  return HEX6.test(h) ? h.toUpperCase() : t;
}

export interface BrandColorCheck {
  /** "empty": nothing typed (default look). "invalid": not #RRGGBB. "ok": usable. */
  state: "empty" | "invalid" | "ok";
  hex?: string;
  /** Label colour with the better contrast on this colour (white or charcoal, from the design tokens). */
  label?: string;
  /** Contrast of that label on the colour, e.g. 4.8. */
  labelRatio?: number;
  /** An AA problem (the label on this colour cannot be read), in plain words; null when fine. */
  warning: string | null;
  /** A heads-up that is not a problem: the colour is nudged where the page uses it as small text. */
  note: string | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * AA check (WCAG 2.2, 4.5:1 for text). The page puts a label on the colour (a button) and may also use it as text on the white and
 * the dark surface; delivery-service nudges the colour where it is text, so only a label problem is a real warning.
 */
export function brandColorCheck(input: string): BrandColorCheck {
  const t = normalizeBrandColor(input);
  if (!t) return { state: "empty", warning: null, note: null };
  if (!HEX6.test(t)) return { state: "invalid", warning: null, note: null };
  const onWhite = contrastRatio(lightColors["on-primary"], t), onDark = contrastRatio(charcoal[900], t);
  const label = onWhite >= onDark ? lightColors["on-primary"] : charcoal[900];
  const labelRatio = Math.max(onWhite, onDark);
  let warning: string | null = null, note: string | null = null;
  if (labelRatio < 4.5) warning = `Text on this colour is hard to read (${round1(labelRatio)}:1; 4.5:1 is the minimum). Pick a darker or lighter colour.`;
  else if (contrastRatio(t, lightColors.surface) < 4.5 || contrastRatio(t, darkColors.surface) < 4.5)
    note = "Buttons look fine. Where your page uses this colour for small text, it is made a little darker or lighter so it stays readable.";
  return { state: "ok", hex: t, label, labelRatio: round1(labelRatio), warning, note };
}

/** The message under the field. */
export const BRAND_COLOR_ERROR = "Use six digits after #, for example #0B6E4F.";

// ---- QR (print) ---------------------------------------------------------------------------------------------------
/** The QR is always dark on white, in both themes, so a printed or scanned copy works. Colours are design tokens. */
export const QR_DARK = charcoal[900];
export const QR_LIGHT = charcoal[0];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A standalone SVG of the QR for the link (4-module quiet zone, `<title>` = the link), to download and print. */
export function qrSvgMarkup(link: string, px = 1024): string {
  const m = qrMatrix(link);
  const n = m.length + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img"><title>${esc(link)}</title>`
    + `<rect width="${n}" height="${n}" fill="${QR_LIGHT}"/><path d="${qrPath(m)}" fill="${QR_DARK}"/></svg>`;
}

/** File name for a downloaded QR, from the link's slug when it has one: `ordering-link-qr-k3f9x2qd7mwa.png`. */
export function qrFileName(link: string, ext: "svg" | "png"): string {
  const slug = /\/r\/([A-Za-z0-9_-]{3,64})\/?$/.exec(link)?.[1];
  return `ordering-link-qr${slug ? `-${slug}` : ""}.${ext}`;
}
