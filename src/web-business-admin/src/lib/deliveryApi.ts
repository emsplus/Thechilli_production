import { apiRequest as request } from "./api";
import type { BusinessType } from "./business";
import type { BizCaps } from "./business";
import type { Restaurant } from "./types";

/** pos-service delivery admin (docs/DELIVERY_API.md, "Staff endpoints"). Money in settings is rupees as text; in orders, paise. */
export interface DeliverySettings {
  enabled: boolean; accept_before_kot: boolean; delivery_fee: string; free_delivery_above: string | null; min_order: string;
  radius_km: string | null; hours: Record<string, string[][]> | null; webhook_url: string | null; has_webhook_secret: boolean;
  /** Returned ONCE when the secret is created or rotated. */
  webhook_secret?: string;
  /** The owner's switch for the public ordering link (docs/DELIVERY_ADMIN.md). Absent on a server that predates the link: the screen then keeps the old read-only link. */
  public_order_enabled?: boolean;
  /** The public ordering page for customers: only while the switch is on and the delivery service says the link is on, else null. */
  public_order_url?: string | null;
  /** True when a service token is stored. The token itself is write-only and never returned. */
  public_order_token_set?: boolean;
}
/** The write side of the public ordering link on `PUT /delivery/settings` (pos-service docs/DELIVERY_API.md, "Public ordering link"). */
export interface PublicLinkChange {
  public_order_enabled?: boolean;
  /** New link: the old URL and QR stop working at once. 409 `public_order_link_off` while the link is off. */
  rotate_public_order_link?: boolean;
  /** `#RRGGBB`; "" clears. 409 while the link is off, 422 when malformed. */
  public_order_brand_color?: string;
  /** Write only; "" clears. Never read back, never logged. */
  public_order_service_token?: string;
}
export type DeliveryStatus = "placed" | "accepted" | "preparing" | "ready" | "out_for_delivery" | "delivered" | "cancelled";
export interface DeliveryOrder {
  order_id: string; order_code: string; status: DeliveryStatus; version: number; subtotal: number; delivery_fee: number; tax: number; total: number;
  channel: string | null; payment_mode: string | null; claimed_paid: boolean; payment_confirmed: boolean;
  customer: { name: string | null; wa_number: string | null }; address: { text: string | null };
}
export interface BusinessTypeInfo { id: BusinessType; label: string; description: string; capabilities?: Partial<BizCaps> }

const put = <T,>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });
const post = <T,>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const delivery = {
  settings: () => request<DeliverySettings>("/delivery/settings"),
  saveSettings: (b: Partial<Pick<DeliverySettings, "enabled" | "accept_before_kot" | "webhook_url">> & { rotate_webhook_secret?: boolean } & PublicLinkChange) => put<DeliverySettings>("/delivery/settings", b),
  orders: (status?: DeliveryStatus) => request<DeliveryOrder[]>(`/delivery/admin/orders${status ? `?status=${status}` : ""}`),
  accept: (orderId: string) => post<DeliveryOrder>(`/delivery/admin/orders/${orderId}/accept`),
  confirmPayment: (orderId: string) => post<DeliveryOrder>(`/delivery/admin/orders/${orderId}/confirm-payment`),
};

/** Business types (docs/BUSINESS_TYPES.md): the catalogue is public; the change is owner-only (settings.owner). */
export const businessTypes = {
  catalogue: () => request<BusinessTypeInfo[]>("/business-types"),
  set: (types: BusinessType[], reason?: string) => put<Restaurant>("/restaurant/business-types", { business_types: types, ...(reason ? { reason } : {}) }),
};

/** The customer ordering link: the server's when it has one, else the build-time template NEXT_PUBLIC_DELIVERY_ORDER_URL ("{restaurant_id}" is filled in). */
export function orderLinkOf(s: Pick<DeliverySettings, "public_order_url"> | null, restaurantId: string | null, template = process.env.NEXT_PUBLIC_DELIVERY_ORDER_URL ?? ""): string | null {
  if (s?.public_order_url && /^https?:\/\//.test(s.public_order_url)) return s.public_order_url;
  if (!template || !restaurantId || !/^https?:\/\//.test(template)) return null;
  return template.includes("{restaurant_id}") ? template.replace("{restaurant_id}", encodeURIComponent(restaurantId)) : template;
}
