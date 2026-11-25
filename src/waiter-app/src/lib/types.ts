import type { OrderType } from "./queue/types";
export type { OrderType };

/** Subset of pos-service response schemas the waiter app reads (app/schemas/common.py). Decimals arrive as strings. */
export interface Category { id: string; name: string; sort_order: number; is_active: boolean }
export interface Variant { id: string; name: string; price_delta: string }
export interface MenuItem { id: string; category_id: string; name: string; price: string; is_active: boolean; variants: Variant[]; thumb_url?: string | null; image_url?: string | null;
  /** Ordered modifier groups (pos-service docs/MODIFIERS_OFFERS.md); absent / [] on items without (and on older servers). */
  modifier_group_ids?: string[]; is_combo?: boolean;
  /** Marked sold out for today at the counter (pos-service ItemOut.sold_out; the server refuses it on an order). Absent on older servers. */
  sold_out?: boolean }
export interface ModifierOption { id: string; name: string; price_delta_paise: number; is_default: boolean; is_active: boolean; sort_order: number }
export interface ModifierGroup { id: string; name: string; min_select: number; max_select: number | null; sort_order: number; is_active: boolean; options: ModifierOption[] }
/** Modifier snapshot on a server order line. */
export interface LineModifier { group_id: string; group: string; option_id: string; name: string; price_delta_paise: number }
export interface ActiveOffer { id: string; name: string; label: string; kind: "percent" | "amount"; value: string; scope: "bill" | "item" | "category"; min_order_value: string }
export interface AppliedOffer { offer_id: string; name: string; label: string; amount: string }
export interface BillPreview { subtotal: string; total: string; discount_amount: string; offers?: AppliedOffer[]; offer_amount?: string }
export interface DiningTable { id: string; label: string; seats: number; area: OrderType; is_active: boolean }
export interface OrderLine { id: string; item_id: string; item_name: string; /** The option (Half / Full): only the id is stored on the order line, the name comes from the menu. */ variant_id?: string | null; variant_name?: string | null; unit_price: string; quantity: number; note: string | null; modifiers?: LineModifier[] | null }
export type ServerOrderStatus = "open" | "sent_to_kitchen" | "billed" | "cancelled";
export interface ServerOrder { id: string; client_uuid: string; order_type: OrderType; table_id: string | null; status: ServerOrderStatus; lines: OrderLine[]; subtotal: string; created_at: string | null;
  /** Present on pos-service with the waiter API (docs/WAITER_API.md there); absent on older servers. */
  token_number?: number | null; note?: string | null; bill_requested_at?: string | null; merged_into_order_id?: string | null }
export type KotStatus = "pending" | "preparing" | "ready" | "served" | "cancelled";
export interface Kot { id: string; order_id: string; number: number; status: KotStatus; created_at: string | null }
export interface Me { id: string; email: string; /** The restaurant's 6-character staff sign-in code (absent on older servers). */ restaurant_code?: string | null; full_name: string; role: string; outlet_id?: string | null; outlets?: OutletInfo[]; permissions?: string[];
  /** Business type of the restaurant (docs/BUSINESS_TYPES.md): which screens and order types apply. Absent on older servers = restaurant. */
  business_types?: string[]; capabilities?: Record<string, unknown> | null; order_types?: string[];
  /** Restaurant rules: `kitchen_status_mode` "kot_only" (default: the order just goes to the kitchen) or "track" (Preparing / Ready / Served). */
  order_rules?: { require_kot_before_bill?: boolean; kitchen_status_mode?: "kot_only" | "track" } | null }
export interface Restaurant { name: string; currency: string; currency_symbol: string }
export interface OutletInfo { id: string; name: string; code: string; is_default: boolean; is_active: boolean }
