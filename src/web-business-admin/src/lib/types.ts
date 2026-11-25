export type OrderType = "indoor" | "outdoor" | "takeaway" | "delivery";
export type PaymentMethod = "cash" | "card" | "other" | "upi";
/** Payments as returned on a bill: a replacement invoice is settled from the original through a `credit_note` payment. */
export type BillPaymentMethod = PaymentMethod | "credit_note";

export type TaxKind = "hot_food" | "cold_food" | "standard";
/** India only: the server refuses any other country (422). */
export type CountryCode = "IN";
export interface Restaurant {
  name: string; trn: string | null; address?: string | null; currency: string; timezone: string;
  /** Display name of the zone, e.g. "India (IST)" (pos-service). Absent on older servers: use lib/timezoneLabel. */
  timezone_label?: string | null;
  country?: string; currency_symbol?: string; tax_number_label?: string; prices_include_tax?: boolean; vat_registered?: boolean;
  service_charge_percent?: string; max_cashier_discount_percent?: string;
  phone?: string | null; z_report_next_number?: number;
  /** Days after the sale date during which a finalized bill can be corrected (0 = off). */
  bill_amend_days?: number;
  /** Kitchen lateness target in minutes (5-120, default 15), stored per restaurant by pos-service. */
  kitchen_target_minutes?: number;
  /** Kitchen status tracking (pos-service docs/KOT_ONLY_KITCHEN.md): "kot_only" (default) or "track" (Preparing / Ready / Served). */
  kitchen_status_mode?: "kot_only" | "track";
  /** KOT-only kitchen screen: a ticket stays in the live list this many minutes (5-120, default 20), then moves to "Earlier tickets". */
  kitchen_display_minutes?: number;
  /** Staff sign-in code: staff type it with their phone / username / email and password (pos-service docs/STAFF_WIRING_CHECK.md). */
  login_code?: string | null;
  business_types?: string[]; capabilities?: Partial<import("./business").BizCaps> | null;
  /** code -> available: granted by super admin AND switched on by the owner (pos-service services/feature_access.py). Absent on an older server = everything allowed. */
  features?: Record<string, boolean> | null;
}
/** GET /billing/tax-config: everything needed to display money and ESTIMATE a bill offline. */
export interface TaxConfig {
  country: string; currency: string; currency_symbol: string; timezone: string;
  prices_include_tax: boolean; vat_registered: boolean; tax_number_label: string;
  service_charge_percent: string; max_cashier_discount_percent: string;
  rates: { code: "standard" | "zero" | string; name: string; rate_percent: string }[];
  rules: { eat_in: string; takeaway: Record<string, string>; eat_in_order_types: string[]; service_charge?: string; not_vat_registered?: string };
}
export interface DiscountInput { type: "percent" | "amount"; value: string; reason: string }
export interface TaxBreakdownRow { code: string; rate_percent: string; net: string; vat: string; gross: string; /** India GST engine: the CGST / SGST (or IGST) halves of `vat`. */ cgst?: string | null; sgst?: string | null; igst?: string | null }
export interface BillPreview {
  lines: { description: string; quantity: number; unit_price: string; line_total: string; discount: string; gross: string; net: string; vat: string; tax_code: string; rate_percent: string }[];
  discount_amount: string; discount_reason: string | null; service_charge_amount: string; service_charge_percent: string;
  subtotal: string; tax_amount: string; total: string; tax_breakdown: TaxBreakdownRow[];
  currency: string; prices_include_tax: boolean; vat_registered: boolean; country: string;
  /** Automatic offers in this preview (phase4); `discount_amount` = offers + manual. */
  offers?: { offer_id: string; name: string; label: string; amount: string }[]; offer_amount?: string;
  /** India GST engine: total = subtotal + tax_amount + round_off. */
  round_off?: string; place_of_supply?: string | null;
}
export interface Category { id: string; name: string; sort_order: number; is_active: boolean }
export interface Variant { id: string; name: string; price_delta: string; is_default?: boolean }
export interface MenuItem { id: string; category_id: string; name: string; price: string; tax_kind?: TaxKind; is_active: boolean; variants: Variant[];
  /** Order rules (pos-service docs/ORDER_RULES.md; absent on older servers): sold out for today; the option the server applies
   *  when a line names none (null = none); the dish may be ordered without an option ("Regular" row only then). */
  sold_out?: boolean; default_variant_id?: string | null; base_orderable?: boolean; image_url?: string | null; thumb_url?: string | null;
  /** Modifier groups attached in order (pos-service phase4; absent on older servers = none). */ modifier_group_ids?: string[]; is_combo?: boolean;
  /** GST of the dish (gst_5, gst_18, none; null = the restaurant default). */ gst_rate_code?: string | null; hsn?: string | null;
  /** FSSAI mark (veg | non_veg | egg; null = not marked) and a one-line description (<= 280 chars). Absent on older servers. */
  description?: string | null; is_veg?: boolean | null; food_type?: string | null }
/** food_type / description on create / update / PATCH: omitted = unchanged, null = cleared. */
export interface MenuMetaInput { food_type?: "veg" | "non_veg" | "egg" | null; description?: string | null }
export interface DiningTable { id: string; label: string; seats: number; area: OrderType; is_active?: boolean }
export interface OrderLine { id: string; item_id: string; item_name: string; unit_price: string; quantity: number; note: string | null; variant_id?: string | null }
export interface Order { id: string; client_uuid: string; order_type: OrderType; table_id: string | null; customer_id?: string | null; status: string; lines: OrderLine[]; subtotal: string; cancel_reason?: string | null; cancelled_at?: string | null;
  /** Set when a waiter asked for the bill (waiter app "Request bill"), cleared when the bill is made. */
  bill_requested_at?: string | null; token_number?: number | null; created_at?: string;
  /** "merged": joined into another order (not a cancellation). Older servers only send status cancelled + the reason "Merged into order <id>". */
  kind?: string | null; merged_into_number?: string | number | null; merged_into_order_id?: string | null }
/** `print`: what the kitchen printer did with this ticket (pos-service phase4/order-rules; absent on older servers). */
export interface Kot { id: string; order_id: string; number: number; status: string; created_at?: string;
  /** KOT-only kitchen: when the ticket was dismissed / finished (null while it is still on the screen). */ done_at?: string | null;
  /** Same content as the printed slip: the order's token and note. */ token_number?: number | null; order_note?: string | null;
  /** Lines as sent: modifiers ("Spice level: Medium") and combo components only when the dish has them. */
  payload: { item: string; qty: number; note: string | null; modifiers?: string[]; components?: { item: string; qty: number }[] }[];
  print?: { status: "queued" | "sent" | "printed" | "failed" | "no_printer"; message?: string | null; error?: string | null; needs_reprint?: boolean; unrouted_items?: string[]; hub_online?: boolean } | null;
  needs_reprint?: boolean }
/** GET /tables/status row. */
export interface TableStatus { table_id: string; label: string; seats: number; area: OrderType; status: "free" | "occupied" | "bill_requested" | "bill_printed" | "reserved";
  orders: { order_id: string; status: string; subtotal: string | number; item_count: number; kot_sent: boolean; token_number?: number | null; bill_requested_at?: string | null;
    waiter_name?: string | null; opened_at?: string | null; bill_id?: string | null; total?: string | number | null }[];
  reservation?: { id: string; guest_name: string; party_size: number; starts_at: string } | null }
/** GET /bill-requests row (oldest first). kind "bill_request" (also what an older server sends): an open order whose waiter asked for
 * the bill. "payment_reminder": a BILLED, unpaid order, the waiter asks the counter to take the payment (bill_id / invoice_number /
 * balance_due / table_area filled; requested_by_name = the waiter who asked). */
export interface BillRequest { kind?: "bill_request" | "payment_reminder"; bill_id?: string | null; invoice_number?: string | null; balance_due?: string | null; table_area?: string | null; order_id: string; table_id: string | null; table_label: string | null; token_number: number | null; requested_at: string;
  requested_by: string | null; requested_by_name: string | null; waiter_id: string | null; waiter_name: string | null; item_count: number; subtotal: string; note: string | null }
export interface Payment { id: string; method: BillPaymentMethod; amount: string }
export interface Refund { id: string; credit_note_number: string; amount: string; tax_amount: string; reason: string; kind?: "refund" | "amendment"; payout_amount?: string; payout_method?: string | null }
export interface Bill {
  id: string; order_id: string; invoice_number: string; seller_name: string; seller_trn: string | null;
  currency: string; tax_name: string; tax_rate_percent: string; subtotal: string; tax_amount: string; total: string;
  country?: string; prices_include_tax?: boolean; vat_registered?: boolean; discount_amount?: string; discount_reason?: string | null;
  service_charge_amount?: string; service_charge_percent?: string; tax_breakdown?: TaxBreakdownRow[] | null;
  /** India GST engine: total = subtotal + tax + round_off. */ round_off?: string;
  lines: { id?: string; item_id?: string | null; description: string; quantity: number; unit_price: string; line_total: string; tax_code?: string | null; tax_rate_percent?: string | null; net_amount?: string | null; vat_amount?: string | null; gross_amount?: string | null }[];
  payments: Payment[]; refunds: Refund[]; paid: string; balance_due: string;
  customer_name?: string | null; customer_phone?: string | null; table_label?: string | null; order_type?: string | null; cashier_name?: string | null;
  /** Amendments: the bill's own date (a replacement keeps the original's) vs when the record was posted. */
  status?: "active" | "superseded" | "voided"; sale_at?: string | null; finalized_at?: string | null; amended_at?: string | null; amend_reason?: string | null;
  superseded_by?: string | null; superseded_by_number?: string | null; amends?: string | null; amends_number?: string | null; amends_credit_note?: string | null;
  amendment_chain?: string[];
  offer_amount?: string; offers?: { applied: { offer_id: string; name: string; label: string; amount: string }[]; manual_amount: string; manual_reason: string | null } | null;
}
export interface AmendLinkInfo { id: string; invoice_number: string; status: "active" | "superseded" | "voided"; total: string; sale_at: string; posted_at: string }
export interface AmendOptions {
  amendable: boolean; reason_if_not: string | null; window_ends_at: string | null; amend_days: number; current_version_id: string;
  chain: AmendLinkInfo[]; refundable_by_method: Record<"cash" | "card" | "other", string>;
}
export interface AmendLineInput { bill_line_id?: string | null; item_id: string; variant_id?: string | null; quantity: number; unit_price_override?: string | null; override_reason?: string | null }
export interface AmendRequest { lines: AmendLineInput[]; discount?: DiscountInput | null; service_charge?: boolean; table_id?: string | null }
export interface AmendPreview {
  lines: (BillPreview["lines"][number] & { bill_line_id: string | null; item_id: string; kept: boolean; price_source: "original" | "menu" | "override"; override_reason: string | null })[];
  discount_amount: string; discount_reason: string | null; discount: DiscountInput | null;
  service_charge_amount: string; service_charge_percent: string; service_charge: BillPreview["lines"][number] | null;
  subtotal: string; tax_amount: string; total: string; tax_breakdown: TaxBreakdownRow[];
  currency: string; prices_include_tax: boolean; vat_registered: boolean; country: string; sale_at: string;
  table_label: string | null; order_type: string | null;
  diff: { old_total: string; new_total: string; delta: string; old_vat: string; new_vat: string; vat_delta: string; paid: string; refund_due: string; balance_due: string };
  stock_impact: { item_id: string; item_name: string; delta_base_quantity: string; unit: string }[];
  refundable_by_method: Record<"cash" | "card" | "other", string>;
}
export interface AmendResult {
  replacement: Bill;
  credit_note: { id: string; credit_note_number: string; bill_id: string; invoice_number: string; amount: string; tax_amount: string; reason: string; replacement_bill_id: string; replacement_invoice_number: string };
  refund: { amount: string; method: string; credit_note_number: string } | null;
}
export interface ShareLink { url: string; expires_at: string; filename: string }

export interface LastReceived { at: string; quantity: string; unit_cost: string | null; invoice_id: string | null; invoice_number: string | null; supplier_name: string | null }
export interface ReorderEmailInfo { id: string; status: "queued" | "sent" | "failed"; kind: "auto" | "manual"; at: string }
export interface InventoryItem {
  id: string; name: string; base_unit: "g" | "ml" | "pcs"; reorder_level: string; balance: string; low_stock: boolean; is_active?: boolean; last_received?: LastReceived | null;
  /** "Usual supplier": gets the re-order email. */
  supplier_id?: string | null; supplier_name?: string | null; supplier_manual?: boolean;
  /** How much to ask for (base unit); null = use `suggested_quantity`. */
  reorder_quantity?: string | null; suggested_quantity?: string; reorder_email?: ReorderEmailInfo | null;
}
export interface BulkItemPayload { name: string; base_unit: "g" | "ml" | "pcs"; reorder_level: string; opening_quantity?: string; opening_unit?: string; unit_cost?: string }
export interface BulkCreateResult { created: InventoryItem[]; existing: InventoryItem[]; movements: number; replayed: boolean }
export interface Supplier { id: string; name: string; trn: string | null; phone: string | null; email?: string | null; contact_name?: string | null; auto_reorder?: boolean; is_active?: boolean }
export interface EmailSettings { configured: boolean; auto_enabled: boolean; window_hours: number }
export interface ReorderLine { item_id: string; name: string; unit: string; balance: string; quantity: string }
export interface ReorderPreview { to: string | null; subject: string; body_text: string; items: ReorderLine[]; can_send: boolean; reason: string | null }
export interface SupplierEmail {
  id: string; supplier_id: string; supplier_name: string | null; to_email: string; subject: string; body_text: string; items: ReorderLine[]; note: string | null;
  kind: "auto" | "manual"; status: "queued" | "sent" | "failed"; error: string | null; attempts: number; created_at: string; sent_at: string | null;
}
export interface RecipeDraft {
  menu_item_id: string; menu_item_name: string;
  ingredients: { item_id: string; name: string; unit: string; quantity: string }[];
  missing: { name: string; base_unit: "g" | "ml" | "pcs"; quantity: string }[];
  warnings: string[];
}
export interface PackInfo {
  /** "hint": the description says what one unit holds ("(2 pcs)") but the printed quantity and price were kept as printed. */
  status: "ok" | "asis" | "uncertain" | "hint";
  /** What ONE invoiced unit adds to stock, when read from the description only (never applied automatically). */
  per_unit?: { quantity: string; unit: string } | null;
  /** "4 cases x 6 x 2.55 kg" */
  text: string | null;
  /** Units in the invoiced quantity (12 bottles), for items counted in pieces. */
  count_total: string | null;
  /** The same stock as a measure (20 l), when the line was read as a count. */
  measure: { quantity: string; unit: string } | null;
  options: { label: string; quantity: string; unit: string; count_total?: string }[];
  invoiced: { quantity: string | null; unit: string; unit_price: string | null };
  pack_count: string | null; unit_size: string | null; unit_size_unit: string | null; pack_text: string | null;
  /** Set when the printed price x quantity did not match the printed line amount, so the price was restated from the amount. */
  price_note?: string | null;
}
export interface PurchaseLine {
  id?: string; description: string; item_id: string | null; quantity: string; unit: string; unit_price: string; line_total?: string; confidence?: string | null;
  pack?: PackInfo | null; needs_check?: boolean; check_reason?: string | null; exclude_from_stock?: boolean; item_code?: string | null; vat_code?: string | null; vat_rate?: string | null;
}
export interface StockAdded { item_id: string; item_name: string; quantity: string; unit: "g" | "ml" | "pcs"; balance_before: string; balance_after: string }
/** Header / footer details of the scanned bill, as printed (display only). */
export interface BillInfo {
  currency: string | null; supplier_address: string | null; supplier_phone: string | null; supplier_email: string | null;
  time: string | null; table: string | null; order_type: string | null; payment: string | null; amount_in_words: string | null;
  tax_lines: { label: string; rate: string | null; amount: string }[];
  warnings?: string[] | null;
}
export interface Purchase {
  id: string; supplier_id: string | null; status: "uploaded" | "extracted" | "failed" | "confirmed";
  invoice_number: string | null; invoice_date: string | null; total: string | null; net?: string | null; vat?: string | null;
  supplier_name_raw?: string | null; supplier_vat_number?: string | null; document_type?: "stock_purchase" | "expense" | "other";
  confidence: string | null; error: string | null; lines: PurchaseLine[];
  created_at?: string | null; updated_at?: string | null; retry_extraction_allowed?: boolean;
  stock_added?: StockAdded[];
  bill?: BillInfo | null;
  /** Server notes on the reading, e.g. a bill printed in another currency ("... not INR: needs manual conversion"). */
  warnings?: string[] | null;
}
export interface Recipe { id: string; menu_item_id: string; version: number; ingredients: { item_id: string; quantity: string }[] }

export interface ReportMeta { has_amendments?: boolean; amendments_count?: number; metric: string; from_date: string | null; to_date: string | null; timezone: string; currency: string; currency_symbol?: string; country?: string; prices_include_tax?: boolean; data_complete: boolean; incomplete_reason: string | null; note?: string; warnings?: string[] }
export interface DailySales extends ReportMeta {
  days: { date: string; bills: number; subtotal: string; vat: string; gross_total: string; discounts?: string; service_charge?: string; refunds: string; net_total: string }[];
  totals: { bills: number; subtotal: string; vat: string; gross_total: string; discounts?: string; service_charge?: string; refunds: string; net_total: string; vat_by_rate?: TaxBreakdownRow[] };
}
export interface ItemSales extends ReportMeta { items: { item: string; quantity: number; revenue_excl_vat: string }[] }
export interface OrderSummary extends ReportMeta { billed_by_order_type: { order_type: string; bills: number; total: string }[]; total_billed: string; billed_orders: number; average_bill_value: string }
export interface PurchaseSummary extends ReportMeta { suppliers: { supplier: string; invoices: number; total: string }[]; total: string }
export interface Profitability extends ReportMeta { revenue_excl_vat: string; ingredient_cost: string; gross_profit: string; gross_margin_percent: string | null; items_without_recipe: string[]; ingredients_without_cost: string[]; cost_method: string }
export interface Consent { channel: "whatsapp" | "sms" | "email"; granted: boolean; source: string; recorded_at: string }
/** `name` and `phone` are each optional (at least one is set); `display_name` = name, else phone. */
export interface Customer { id: string; name: string | null; phone: string | null; display_name: string; email: string | null; notes: string | null; consents: Consent[]; orders: number; total_spent: string; last_visit: string | null }
export interface HistoryBill { invoice_number: string; finalized_at: string; total: string; items: string[] }
export interface Alert { id: string; kind: string; item_id: string; status: string; message: string; balance: string; created_at: string; resolved_at: string | null }
/** A PDF the assistant prepared: `url` is an API-relative path (`/api/v1/reports/pdf?...`) fetched with the session, never a plain link. */
export interface ChatAttachment { kind: string; title: string; from: string; to: string; filename: string; url: string }
export interface ChatReply { conversation_id: string; answer: string; tools_used: { name: string; args: Record<string, unknown> | null; metric: string | null; data_complete: boolean | null; error: string | null }[]; attachments?: ChatAttachment[] }
export interface ConversationSummary { id: string; title: string; created_at: string }
export interface ConversationDetail extends ConversationSummary { messages: { role: "user" | "model"; content: string; tool_calls: ChatReply["tools_used"] | null; attachments?: ChatAttachment[]; created_at: string }[] }

export type MovementKind = "purchase" | "sale" | "adjustment" | "wastage" | "count" | "purchase_return" | "expiry_writeoff";
export interface MovementSource {
  kind: MovementKind; label: string; invoice_id: string | null; invoice_number: string | null; supplier_name: string | null;
  bill_id: string | null; bill_invoice_number: string | null; user_name: string | null; reason: string | null;
}
export interface Movement { source?: MovementSource | null; id: string; item_id: string; movement_type: MovementKind; quantity: string; unit_cost: string | null; note: string | null; ref_id: string | null; created_at: string | null; ref_type?: string | null; reason_code?: string | null }
export interface CountResult { item_id: string; expected: string; counted: string; difference: string }
export interface AuditEntry { id: string; created_at: string; action: string; entity: string; entity_id: string | null; detail: unknown; user_id: string | null; user_email: string | null; user_name: string | null }
export interface AuditPage { items: AuditEntry[]; next_cursor: string | null }
export interface SystemHealth { status: "ok" | "degraded"; version: string; env: string; database: { reachable: boolean }; migration: { revision: string | null; head: string | null; up_to_date: boolean | null }; checked_at: string }
export interface ReconCheck { name: string; ok: boolean; severity: "error" | "warning"; detail: string; sample: unknown[] }
export interface Reconciliation { ok: boolean; checked_at: string; warnings: number; checks: ReconCheck[] }

// Manage panel
export type Role = "owner" | "manager" | "cashier" | "waiter" | "kitchen";
export interface Me { id: string; /** Optional for staff added by phone or username. */ email: string | null; phone?: string | null; username?: string | null;
  /** The restaurant's sign-in code (restaurant code + phone / username + password) and name. */ restaurant_code?: string | null; restaurant_name?: string | null;
  /** The password was a one-time password: ask for a new one. */ must_change_password?: boolean; full_name: string; role: Role; is_active: boolean;
  /** Restaurant rules (pos-service docs/ORDER_RULES.md): a dine-in order needs its kitchen ticket before the bill. Absent = true. */ order_rules?: { require_kot_before_bill?: boolean; kitchen_status_mode?: "kot_only" | "track"; kitchen_display_minutes?: number } | null; /** Effective permissions from the server (pos-service app/core/permissions.py). UIs gate on these, not on role names. */ permissions?: string[];
  /** Tenant entitlements from platform-core via pos-service (null/absent when enforcement is off). Absent feature code = allowed. */
  entitlements?: { status?: string; plan?: { code: string; name: string } | null; outlet_limit?: number | null; features?: Record<string, { enabled: boolean; limit: number | null }>; version?: string; source?: string; warning?: string | null } | null;
  entitlement_warning?: string | null; read_only?: boolean;
  /** Chilli balance block (pos-service docs/CHILLI_WALLET.md); null / absent = not known: nothing is shown or blocked. */
  billing?: import("./billing").BillingBlock | null;
  /** Business types and their capabilities (docs/BUSINESS_TYPES.md); absent on older servers = a restaurant. */
  business_types?: string[]; capabilities?: Partial<import("./business").BizCaps> | null;
  /** code -> available: granted by super admin AND switched on by the owner (pos-service services/feature_access.py). Absent on an older server = everything allowed. */
  features?: Record<string, boolean> | null }
/** `custom_role_id`: set while a custom role replaces the built-in role (pos-service docs/ROLES_API.md). */
export interface StaffMember extends Me { created_at: string; custom_role_id?: string | null }
/** A role from GET /roles (assumed shape). System roles have `is_system: true` and cannot be edited or deleted. */
export interface RoleDef { id: string; key?: string; name: string; is_system: boolean; is_active?: boolean; editable?: boolean; permissions: string[]; user_count?: number;
  /** `outlets.effect` is a ready-to-show sentence about which outlets holders can reach. */
  permission_snapshot?: { count: number; outlets?: { access_all: boolean; effect: string } } }
export interface PermissionCatalogue { areas: { key: string; label: { en: string; hi?: string }; permissions: { key: string; label: { en: string; hi?: string }; note?: { en: string; hi?: string } | null; grantable: boolean }[] }[] }
export interface UserOutletAccess { outlet_ids: string[]; access_all: boolean; effective_outlet_ids: string[]; note?: string }
export interface RoleInput { name: string; permissions: string[] }
export interface Outlet { id: string; name: string; code: string; invoice_prefix: string; is_default: boolean; is_active: boolean; address?: string | null; phone?: string | null; trn?: string | null; currency: string; timezone: string; country: string }
export interface OutletInput { name: string; code: string; invoice_prefix: string; address?: string | null; phone?: string | null; trn?: string | null; timezone?: string | null }
export interface OutletPatch { name?: string; address?: string | null; phone?: string | null; trn?: string | null; timezone?: string | null; is_active?: boolean }
export interface ManageSummary { menu_items: number; categories: number; tables: number; inventory_items: number; suppliers: number; staff_active: number; staff_inactive: number; open_alerts: number; items_without_recipe: number; low_stock: number }
export interface RecipeVersion { id: string; version: number; effective_from: string; effective_to: string | null; is_current: boolean; ingredients: { item_id: string; name: string; unit: string; quantity: string }[] }

// End of day (X / Z reports)
export interface ZChannelCategory { category: string; items: number; disc: string; sales: string }
export interface ZChannel { key: "table" | "takeaway" | "online" | string; heading: string; label: string; orders: number; categories: ZChannelCategory[]; sub_total: { items: number; disc: string; sales: string } }
export interface ZVatRow { code: string; rate_percent: string; base: string; vat: string }
export interface ZCorrectionItem {
  credit_note: string; original_invoice: string; replacement_invoice: string; reason: string;
  original_total: string; new_total: string; delta_total: string; original_vat: string; new_vat: string; vat_delta: string; base_delta: string;
  by_rate: { code: string; rate_percent: string; base_delta: string; vat_delta: string }[];
  payout: { method: string; amount: string } | null; sale_at: string; created_at: string;
}
/** Bills corrected (credit note + replacement) in this period. Absent on Z reports closed before corrections existed. */
export interface ZCorrections {
  count: number; items: ZCorrectionItem[];
  reversed: { base: string; vat: string; total: string }; replacements: { base: string; vat: string; total: string }; delta: { base: string; vat: string; total: string };
  payments: { method: string; amount: string }[];
}
export interface ZReportData {
  kind: "X" | "Z"; empty: boolean;
  restaurant: { name: string; address: string | null; phone: string | null; country: string; tax_number_label: string; tax_number: string | null; currency: string; currency_symbol: string; timezone: string; prices_include_tax: boolean; vat_registered: boolean };
  till: string;
  period: { from: string; to: string; from_local: string; to_local: string; timezone: string };
  channels: ZChannel[];
  grand_total: { orders: number; items: number; disc: string; sales: string };
  deductions: {
    item_discount: string;
    bill_discounts: { count: number; amount: string; by_reason: { reason: string; count: number; amount: string }[] };
    gross_returns: { count: number; amount: string; amount_incl_tax: string; items: { credit_note: string; invoice: string; amount: string; reason: string; created_at: string }[] };
    amendment_reversals?: { count: number; amount: string };
    card_commission: string;
    other_charges: { service_charge: { count: number; amount: string }; delivery_charge: { count: number; amount: string }; total: string };
    net_sales: string; vat: string | null;
    /** New server: money RECEIVED (payments minus refunds paid). Older server: the billed figure (no `billed_total`). */
    total_takings: string;
    /** New server only: what was invoiced, unpaid bills included. */
    billed_total?: string;
    takings?: { payments: string; refunds_paid: string; billed_not_received: string };
  };
  deposits: { sub_total: string };
  summary: {
    gross_sales: string; net_sales: string; service_charge: { count: number; amount: string }; delivery_charge: { count: number; amount: string }; total_charges: string;
    payments: { method: string; count: number; amount: string }[]; total_payments: string;
    vat: { shown: boolean; rows: ZVatRow[]; returns: { base: string; vat: string } | null; corrections?: { base: string; vat: string } | null; total: { base: string; vat: string } | null };
    voids: { count: number; amount: string }; deposit_sales: string;
  };
  corrections?: ZCorrections;
  voids: { count: number; amount: string; orders: { order_ref: string; order_id: string; order_type: string; cancelled_at: string; reason: string | null; amount: string }[] };
  open_items: { open_orders: { count: number; amount: string }; unpaid_bills: { count: number; balance: string } };
  checks: { categories_add_up_to_total: boolean; takings_match_bill_totals: boolean; vat_matches_bills: boolean; vat_base_equals_net_sales: boolean; net_equals_payments_plus_outstanding: boolean; single_price_mode: boolean; all_ok: boolean };
  warnings: string[];
  checks_info: { payments_minus_takings: string; note: string; bills_without_tax_breakdown: number; bills_total: string; billed_total?: string;
    /** New server only: why payments differ from the amount billed, cause by cause. */
    payments_gap?: { difference: string; causes: { code: string; label?: string; count: number; amount: string }[]; unexplained: string; explained: boolean } };
  id: string | null; number: number | null; number_label: string | null; closed_by: { id: string; name: string } | null; generated_at: string; created_at?: string;
  /** X reports only. */
  completeness?: { data_complete: boolean; incomplete_reason: string | null };
  /** X reports, new server: what the next close covers. `first_close`: the first ever, covering every day since the first sale. */
  close_period?: { from: string; from_local?: string; days: number; first_close: boolean };
}
export interface ZReportSummary { id: string; number: number; number_label: string; period_from: string; period_to: string; orders: number; net_sales: string; total_takings: string; empty: boolean; closed_by_name: string | null; created_at: string }
export interface ZReportPage { items: ZReportSummary[]; next_cursor: string | null }
export interface CategorySalesRow { category: string; quantity: number; before_discount: string; discount: string; net: string; vat: string; gross: string; share_percent: string }
export interface CategorySales extends ReportMeta {
  categories: CategorySalesRow[];
  by_channel: { channel: string; label: string; orders: number; categories: CategorySalesRow[]; totals: { quantity: number; before_discount: string; discount: string; net: string; vat: string; gross: string } }[];
  totals: { quantity: number; before_discount: string; discount: string; net: string; vat: string; gross: string; service_charge: string };
}

export const EXPENSE_CATEGORIES = ["Utilities", "Telecom", "Rent", "Cleaning", "Packaging", "Repairs", "Other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export interface Expense { id: string; supplier_id: string | null; supplier_name: string; invoice_number: string | null; expense_date: string; category: ExpenseCategory; net: string; vat: string; gross: string; note: string | null; invoice_id: string | null; created_at?: string | null }
export interface ExpenseBucket { key: string; count: number; net: string; vat: string; gross: string }
export interface ExpenseSummary { months: ExpenseBucket[]; categories: ExpenseBucket[]; total: ExpenseBucket }

/** GET /menu/voice-aliases: a phrase the live voice ordering learnt from staff ("chicken tikki" -> Chicken Tikka). `phrase` is
 * voiceParse.ts aliasPhrase's key; `item_active` false = the dish is archived (the till ignores the phrase meanwhile). */
export interface VoiceAlias { id: string; phrase: string; menu_item_id: string; item_name: string; item_active: boolean; variant_id: string | null; variant_name: string | null; uses: number; created_by: string | null; created_at: string; updated_at: string }
/** POST /ai/voice-order: what the model heard, already checked against this restaurant's active menu. No prices. */
export interface VoiceLine { item_id: string; item_name: string; variant_id: string | null; variant_name: string | null; quantity: number; note: string | null; heard_text: string; confidence: number; needs_review: boolean; issues: string[]; /** no option said: the dish's default (cheapest) */ defaulted?: boolean }
export interface VoiceOrder {
  transcript: string | null; lines: VoiceLine[]; unmatched: string[];
  /** `phone` is E.164 (by the restaurant's country) or null; `phone_heard` is the raw text for the user to fix. */
  customer: { name: string | null; phone: string | null; phone_heard: string | null };
  order_type: OrderType | null; table_label: string | null; table_id: string | null;
  /** "bill number 2" (1-99) or "new bill"; absent on replies from older servers. */
  bill_no?: number | null; new_bill?: boolean;
  /** Phrases that fit several dishes: staff pick one (absent on replies from older servers). */
  clarifications?: { heard_text: string; reason: string; options: { item_id: string; item_name: string }[]; quantity: number | null; note: string | null }[];
  /** Till command said at the end ("place order", "send to kitchen", "cancel"); the till checks and runs it. */
  command?: "place" | "kot" | "clear" | null;
  /** The AI model was asked (the on-server parser was not sure, or audio). */
  model_used?: boolean;
}

// ---- Restaurant printing (print hub + ESC/POS printers)
export type PrinterRole = "counter" | "kitchen" | "other";
export type PrinterConnection = "lan" | "system";
export type PrinterCodepage = "pc858" | "cp1252" | "cp437" | "none";
export type PrinterStatus = "online" | "offline" | "unknown";
export interface PrinterConfig {
  id: string; name: string; role: PrinterRole; connection: PrinterConnection; host: string | null; port: number; system_name: string | null;
  columns: number; codepage: PrinterCodepage; copies: number; cut: boolean; is_active: boolean; auto_bill: boolean; auto_kot: boolean;
  kot_category_ids: string[]; created_at: string; status: PrinterStatus;
}
export type PrinterInput = Omit<PrinterConfig, "id" | "created_at" | "status">;
export interface PrintHub { id: string; name: string; last_seen_at: string | null; version: string | null; os: string | null; system_printers: string[]; printer_status: Record<string, string>; created_at: string; online: boolean }
/** `code`: 10 upper-case letters and digits (older servers issued 6 digits; both display fine). */
export interface HubPairing { code: string; expires_at: string }
export type PrintJobKind = "bill" | "kot" | "test";
export type PrintJobStatus = "queued" | "sent" | "printed" | "failed";
export interface PrintJob {
  id: string; printer_id: string; printer_name: string | null; kind: PrintJobKind; ref_id: string | null; copy_no: number; reprint_no: number;
  status: PrintJobStatus; attempts: number; last_error: string | null; created_by: string | null; created_at: string; sent_at: string | null; printed_at: string | null;
}

// Insight reports (owner / manager). Money is exact decimal strings; every one carries the ReportMeta fields plus `warnings`.
export type ReportPdfKind = "sales_summary" | "item_sales" | "category_sales" | "purchases" | "profit_and_loss" | "food_cost" | "leakage" | "staff_sales" | "customers" | "stock";
export type InsightName = "leakage" | "staff-sales" | "food-cost" | "profit-and-loss" | "customers";
export type FlagSeverity = "high" | "medium" | "low";
export interface LeakByStaff { name: string; count: number; amount: string; sales?: string; percent_of_sales?: string | null }
export interface LeakByReason { name: string; count: number; amount: string }
export interface LeakageReport extends ReportMeta {
  discounts: {
    count: number; total: string; sales_before_discount: string; percent_of_sales: string | null; by_staff: LeakByStaff[]; by_reason: LeakByReason[];
    biggest: { invoice: string; amount: string; percent: string | null; staff: string | null; reason: string | null; sale_date: string }[];
  };
  voids: {
    count: number; value: string; before_kitchen: { count: number; value: string };
    after_kitchen: { count: number; value: string; orders: { order_ref: string; amount: string; staff: string | null; reason: string | null; cancelled_at: string }[] };
    by_staff: { name: string; count: number; amount: string; after_kitchen_count: number; after_kitchen_amount: string }[]; by_reason: LeakByReason[];
  };
  refunds: {
    count: number; value: string; percent_of_sales: string | null; by_staff: LeakByStaff[]; by_reason: LeakByReason[];
    biggest: { credit_note?: string | null; invoice: string; amount: string; staff: string | null; reason: string | null }[];
  };
  corrections: { count: number; value: string; by_staff: LeakByStaff[]; by_reason: LeakByReason[]; biggest: unknown[]; payout_to_customers: string; net_change: string };
  unpaid_bills: { count: number; balance: string; min_age_days: number; bills: { invoice: string; total: string; balance: string; part_paid: boolean; age_days: number; customer: string | null }[] };
  payments_vs_takings: { payments: string; takings: string; difference: string; note: string | null; billed_total?: string; total_takings?: string;
    causes?: { difference?: string; causes: { code: string; label?: string; count: number; amount: string }[]; unexplained?: string; explained?: boolean } };
  stock: {
    total_loss_value: string; by_type: { type: string; movements: number; value: string }[];
    items: { item: string; unit: string; quantity: string; value: string; types: string[] }[];
    usage_gap: { available: boolean; theoretical_usage_value?: string | null; stock_counts?: number | null; count_variance_value?: string | null; note: string | null };
  };
  flags: { severity: FlagSeverity; code: string; message: string }[];
  warnings: string[];
}
export interface StaffSalesReport extends ReportMeta {
  staff: { user_id: string; name: string; role: string; bills: number; gross: string; average_bill: string | null; items: number; discounts: { count: number; value: string }; orders_created: number; voids: { count: number; value: string }; refunds: { count: number; value: string } }[];
  totals: { bills: number; gross: string; discount_value: string };
  warnings: string[];
}
export type DishClass = "star" | "plowhorse" | "puzzle" | "dog";
export interface FoodCostReport extends ReportMeta {
  dishes: { item: string; has_recipe: boolean; cost_known: boolean; quantity: number; revenue_excl_vat: string; revenue_per_portion: string | null; cost_per_portion: string | null; food_cost_percent: string | null; margin_per_portion: string | null; total_cost: string | null; total_margin: string | null; classification: DishClass | null }[];
  dishes_more?: number;
  dishes_without_recipe: { item: string; has_recipe: boolean; quantity: number; revenue_excl_vat: string; cost_known?: boolean; ingredients_without_cost?: string[] }[];
  dishes_without_recipe_more?: number;
  totals: { dishes_costed: number; dishes_without_recipe: number; portions: number; revenue_excl_vat: string; ingredient_cost: string; gross_margin: string; food_cost_percent: string | null; revenue_without_recipe: string };
  warnings: string[]; cost_method?: string; classification_note?: string | null;
}
export interface ProfitLossReport extends ReportMeta {
  net_sales_excl_vat: string; bills: number; refunds_excl_vat: string; ingredient_cost: string; gross_profit: string; gross_margin_percent: string | null;
  expenses: { by_category: { category: string; count: number; amount: string }[]; total: string; vat_excluded?: boolean };
  operating_profit: string; operating_margin_percent: string | null; items_without_recipe: string[]; ingredients_without_cost: string[];
  vat: { output_vat: string; input_vat: string; net_vat_due: string; authority: string | null };
  warnings: string[];
}
export interface CustomerInsights extends ReportMeta {
  customers: number; new_customers: number; returning_customers: number; repeat_rate_percent: string | null; returning_rate_percent: string | null;
  bills_with_customer: number; bills_without_customer: number; identified_share_percent: string | null;
  top_customers: { name: string | null; phone: string | null; visits: number; spend: string; average_bill: string | null; last_visit: string | null; returning: boolean }[];
  warnings: string[];
}

/** A cash drawer session (docs/CASH_SESSIONS.md). Amounts are Decimal strings; variance = counted - expected (negative = short). */
export interface CashSession { id: string; cashier_id?: string; outlet_id?: string; status: "open" | "closed"; opened_at: string; opening_float: string; closed_at?: string | null; cashier_name?: string | null;
  expected_cash?: string | null; counted_cash?: string | null; variance?: string | null; variance_reason?: string | null;
  breakdown?: { cash_payments: string; cash_voids: string; cash_refunds: string; cash_correction_payouts: string; by_method?: Record<string, string> } }

/** Response of POST /bills/{id}/void (loose on purpose: only `refund_due` is read, extra fields ignored). */
export interface VoidResult { id?: string; status?: string; invoice_number?: string; refund_due?: { amount: string; by_method?: Record<string, string>; note?: string } | null }

/** POST /auth/users answer: the new staff member and their sign-in details. `temporary_password` / `invite.url` are shown ONCE. */
export interface StaffCreated extends StaffMember { restaurant_code: string; login_identifier: string; temporary_password: string | null;
  invite: { sent: boolean; url: string; expires_at: string } | null; outlet_ids: string[] }
export interface StaffInput { full_name: string; role: Role; email?: string | null; phone?: string | null; username?: string | null;
  password?: string | null; outlet_ids?: string[]; send_invite?: boolean }
/** What a staff member needs to sign in, shown once to the owner (new staff, one-time password). */
export interface StaffCredentials { full_name: string; restaurant_code: string; login_identifier: string; temporary_password?: string | null; invite_url?: string | null; invite_sent?: boolean }

/** One row of GET /restaurant/features (Manage > Features): `granted` = super admin allows it, `switched_on` = the owner's switch, `available` = both. */
export interface FeatureAccess { code: string; label: string; group: "order_types" | "billing" | "modules"; group_label: string; description: string; granted: boolean; switched_on: boolean; available: boolean }
