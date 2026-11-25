/**
 * Business types for the sign-up step "What do you run? (choose one or more)" (docs/BUSINESS_TYPES.md).
 * PLACEHOLDER catalogue: the contract says the wizard builds its cards from pos-service `GET /business-types`
 * ({id, label, description, capabilities}); the public site does not call pos-service yet, so the ids, labels and
 * descriptions are copied from the doc. Replace with the live catalogue when it is exposed to the public site.
 */
export const BUSINESS_TYPE_IDS = ["restaurant", "cloud_kitchen", "hotel_kitchen"] as const;
export type BusinessTypeId = (typeof BUSINESS_TYPE_IDS)[number];

export interface BusinessTypeOption { id: BusinessTypeId; label: string; description: string; hint?: string }
export const BUSINESS_TYPE_OPTIONS: readonly BusinessTypeOption[] = [
  { id: "restaurant", label: "Restaurant or cafe", description: "Guests eat in: tables, dine-in orders and reservations, plus takeaway." },
  { id: "cloud_kitchen", label: "Cloud kitchen", description: "Delivery-only or pickup kitchen: takeaway and delivery orders, no tables." },
  { id: "hotel_kitchen", label: "Hotel kitchen", description: "A hotel's food service, set up like a cloud kitchen.", hint: "Also select Restaurant if the hotel has a dine-in restaurant." },
];
