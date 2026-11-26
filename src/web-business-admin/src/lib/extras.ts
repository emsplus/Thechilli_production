/**
 * Modifier groups, combos, offers, reservations, staff attendance and the setup checklist (pos-service phase4:
 * docs/MODIFIERS_OFFERS.md and docs/RESERVATIONS_ATTENDANCE_SETUP_API.md). Types and calls only; same auth, refresh and
 * error mapping as `api` (ApiError with the server's `error.code`).
 */
import { apiRequest as request, authedFetch, errorFrom } from "./api";
import type { OrderType } from "./types";

// ---------------------------------------------------------------- modifiers / combos
export interface ModifierOption { id: string; name: string; price_delta_paise: number; is_default: boolean; is_active: boolean; sort_order: number }
export interface ModifierGroup {
  id: string; name: string; min_select: number; max_select: number | null; sort_order: number; is_active: boolean;
  options: ModifierOption[]; item_ids: string[];
}
export interface ModifierOptionInput { id?: string | null; name: string; price_delta_paise: number; is_default: boolean; sort_order?: number | null }
export interface ModifierGroupInput { name: string; min_select: number; max_select: number | null; sort_order?: number; options: ModifierOptionInput[] }
export interface ComboComponent { item_id: string; name?: string; variant_id: string | null; quantity: number }
export interface Combo { item_id: string; name: string; price: string; is_active: boolean; components: ComboComponent[] }

// ---------------------------------------------------------------- offers
export type OfferKind = "percent" | "amount";
export type OfferScope = "bill" | "item" | "category";
export interface OfferInput {
  name: string; kind: OfferKind; value: string; scope: OfferScope; target_ids: string[] | null;
  min_order_value: string; max_discount: string | null; days_of_week: number[] | null;
  start_time: string | null; end_time: string | null; valid_from: string | null; valid_to: string | null;
  order_types: OrderType[] | null; stackable: boolean; priority: number; outlet_id: string | null; is_active: boolean;
}
export interface Offer extends OfferInput { id: string; label: string }
export interface AppliedOffer { offer_id: string; name: string; label: string; amount: string }

// ---------------------------------------------------------------- reservations
export type ReservationStatus = "booked" | "seated" | "cancelled" | "no_show";
export interface Reservation {
  id: string; outlet_id: string; client_uuid: string | null; guest_name: string; phone: string; party_size: number;
  starts_at: string; ends_at: string; duration_minutes: number; local_date: string;
  table_id: string | null; table_label: string | null; status: ReservationStatus; notes: string | null;
  order_id: string | null; seated_at: string | null; cancelled_at: string | null; cancel_reason: string | null;
  reminder_queued_at: string | null; created_by: string; created_at: string;
}
export interface ReservationInput { client_uuid?: string; guest_name: string; phone: string; party_size: number; starts_at: string; duration_minutes?: number; table_id?: string | null; notes?: string | null }
export interface AvailabilityTable { id: string; label: string; seats: number; area: string; fits: boolean; available: boolean; occupied_now: boolean; conflicts: string[] }
export interface Availability { outlet_id: string; starts_at: string; ends_at: string; party_size: number; available_count: number; tables: AvailabilityTable[] }
export interface CommsSettings { whatsapp_enabled: boolean; login_alert_emails: boolean; whatsapp_available: boolean; email_available: boolean }
export interface TableStatus {
  table_id: string; label: string; seats: number; area: OrderType; status: "free" | "occupied" | "bill_requested" | "bill_printed" | "reserved";
  reservation: { id: string; guest_name: string; party_size: number; starts_at: string } | null;
  /** The table's open orders (open / with the kitchen, or billed and waiting for payment). Absent on older servers. */
  orders?: { order_id: string; status: string; waiter_name?: string | null; item_count?: number; subtotal?: string | number; total?: string | number | null;
    bill_requested_at?: string | null; bill_id?: string | null; opened_at?: string | null; token_number?: number | null }[];
}

// ---------------------------------------------------------------- attendance
export interface AttendanceRecord {
  id: string; outlet_id: string; user_id: string; user_name: string; client_uuid: string | null;
  work_date: string; clock_in_at: string; clock_out_at: string | null; open: boolean; worked_minutes: number;
  clock_in_device: string | null; clock_out_device: string | null; source: "self" | "manager";
  edited_at: string | null; edited_by: string | null; edit_reason: string | null; voided: boolean;
}
export interface MyAttendance { open: AttendanceRecord | null; records: AttendanceRecord[] }
export interface ScheduleDay { weekday: number; start_time: string; end_time: string; grace_minutes: number }
export interface Schedule { user_id: string; outlet_id: string | null; days: ScheduleDay[] }
export type AttendanceDayStatus = "present" | "late" | "absent" | "pending" | "off";
export interface AttendanceReport {
  outlet_id: string; timezone: string; from_date: string; to_date: string;
  days: { date: string; user_id: string; user_name: string; status: AttendanceDayStatus; scheduled: boolean; scheduled_start: string | null; scheduled_end: string | null;
    first_in: string | null; last_out: string | null; worked_minutes: number; late_minutes: number; open: boolean; missing_clock_out: boolean; records: number }[];
  users: { user_id: string; user_name: string; days_present: number; days_late: number; days_absent: number; worked_minutes: number; late_minutes: number }[];
}
export interface AttendanceHistoryItem { at: string; action: string; user_id: string | null; user_name: string | null; detail: { reason?: string | null; before?: Record<string, string | null>; after?: Record<string, string | null> } | null }

// ---------------------------------------------------------------- setup checklist
export type SetupStepId = "business" | "outlet" | "tables" | "menu" | "printer" | "tax" | "staff" | "upi" | "delivery";
export interface SetupStep { id: SetupStepId; title: string; description: string; status: "done" | "skipped" | "todo"; done: boolean; skipped: boolean; skipped_at: string | null; detail: Record<string, unknown> }
export interface SetupStatus { steps: SetupStep[]; total: number; done: number; skipped: number; remaining: number; percent: number; complete: boolean; next_step: SetupStepId | null }

const put = <T,>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });
const patch = <T,>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const post = <T,>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const q = (o: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const extras = {
  // modifiers / combos (menu.manage for writes)
  modifierGroups: (includeInactive = false) => request<ModifierGroup[]>(`/menu/modifier-groups${includeInactive ? "?include_inactive=true" : ""}`),
  createModifierGroup: (b: ModifierGroupInput) => post<ModifierGroup>("/menu/modifier-groups", b),
  updateModifierGroup: (id: string, b: ModifierGroupInput) => put<ModifierGroup>(`/menu/modifier-groups/${id}`, b),
  setModifierGroupActive: (id: string, is_active: boolean) => patch<ModifierGroup>(`/menu/modifier-groups/${id}/active`, { is_active }),
  /** One group on many dishes at once: every dish (`all_items`) or the dishes of the given categories (attach or detach, idempotent). */
  applyModifierGroup: (id: string, b: { mode: "attach" | "detach"; all_items?: boolean; category_ids?: string[] }) =>
    post<{ changed: number; total: number }>(`/menu/modifier-groups/${id}/apply`, b),
  setItemModifierGroups: (itemId: string, group_ids: string[]) => put<{ item_id: string; group_ids: string[] }>(`/menu/items/${itemId}/modifier-groups`, { group_ids }),
  combos: () => request<Combo[]>("/menu/combos"),
  setCombo: (itemId: string, components: { item_id: string; variant_id: string | null; quantity: number }[]) => put<Combo>(`/menu/items/${itemId}/combo`, { components }),
  // offers (offers.manage for the full list and writes)
  offers: (includeInactive = true) => request<Offer[]>(`/offers${includeInactive ? "?include_inactive=true" : ""}`),
  activeOffers: () => request<Offer[]>("/offers/active"),
  createOffer: (b: OfferInput) => post<Offer>("/offers", b),
  updateOffer: (id: string, b: OfferInput) => put<Offer>(`/offers/${id}`, b),
  setOfferActive: (id: string, is_active: boolean) => patch<Offer>(`/offers/${id}/active`, { is_active }),
  // reservations (reservations.manage)
  reservations: (date?: string, status?: string) => request<Reservation[]>(`/reservations${q({ date, status })}`),
  availability: (b: { starts_at: string; party_size: number; duration_minutes?: number; exclude_reservation_id?: string }) => request<Availability>(`/reservations/availability${q(b)}`),
  createReservation: (b: ReservationInput) => post<Reservation>("/reservations", b),
  updateReservation: (id: string, b: Partial<ReservationInput>) => patch<Reservation>(`/reservations/${id}`, b),
  seatReservation: (id: string, b: { table_id?: string | null } = {}) => post<Reservation>(`/reservations/${id}/seat`, b),
  cancelReservation: (id: string, reason: string | null) => post<Reservation>(`/reservations/${id}/cancel`, { reason }),
  noShowReservation: (id: string) => post<Reservation>(`/reservations/${id}/no-show`),
  remindReservation: (id: string) => post<{ reservation: Reservation; outbox: { status: string } }>(`/reservations/${id}/remind`, { channel: "whatsapp" }),
  comms: () => request<CommsSettings>("/restaurant/communications"),
  tableStatus: () => request<TableStatus[]>("/tables/status"),
  // attendance
  clockIn: (b: { client_uuid?: string; device?: string; at?: string } = {}) => post<AttendanceRecord>("/attendance/clock-in", b),
  clockOut: (b: { client_uuid?: string; device?: string; at?: string } = {}) => post<AttendanceRecord>("/attendance/clock-out", b),
  myAttendance: () => request<MyAttendance>("/attendance/me"),
  attendanceCurrent: () => request<AttendanceRecord[]>("/attendance/current"),
  attendanceRecords: (f: { from_date?: string; to_date?: string; user_id?: string } = {}) => request<AttendanceRecord[]>(`/attendance/records${q(f)}`),
  createAttendance: (b: { user_id: string; clock_in_at: string; clock_out_at: string | null; reason: string }) => post<AttendanceRecord>("/attendance/records", b),
  editAttendance: (id: string, b: { clock_in_at?: string; clock_out_at?: string | null; reason: string }) => patch<AttendanceRecord>(`/attendance/records/${id}`, b),
  voidAttendance: (id: string, reason: string) => post<AttendanceRecord>(`/attendance/records/${id}/void`, { reason }),
  attendanceHistory: (id: string) => request<AttendanceHistoryItem[]>(`/attendance/records/${id}/history`),
  schedules: () => request<Schedule[]>("/attendance/schedules"),
  saveSchedule: (userId: string, days: ScheduleDay[]) => put<Schedule>(`/attendance/schedules/${userId}`, { outlet_id: null, days }),
  attendanceReport: (from_date: string, to_date: string) => request<AttendanceReport>(`/attendance/report${q({ from_date, to_date })}`),
  async attendanceCsv(from_date: string, to_date: string): Promise<Blob> {
    const res = await authedFetch(`/attendance/report.csv${q({ from_date, to_date })}`);
    if (!res.ok) throw await errorFrom(res, "Could not download the report");
    return res.blob();
  },
  // setup checklist
  setupStatus: () => request<SetupStatus>("/setup/status"),
  skipStep: (id: SetupStepId) => post<SetupStatus>(`/setup/steps/${id}/skip`),
  unskipStep: (id: SetupStepId) => request<SetupStatus>(`/setup/steps/${id}/skip`, { method: "DELETE" }),
  upi: () => request<{ upi_vpa: string | null }>("/restaurant/upi"),
  saveUpi: (upi_vpa: string | null) => put<{ upi_vpa: string | null }>("/restaurant/upi", { upi_vpa }),
};
