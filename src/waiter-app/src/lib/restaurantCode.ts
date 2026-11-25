/** Restaurant code for staff sign-in. Staff (often phone-only) sign in with the 6-character code their manager gave them
 *  (pos-service `restaurant_code`, shown in Manage > Restaurant and on the staff card). The old restaurant UUID still works
 *  when pasted: it goes out as `restaurant_id`. The code is remembered on the device after a successful sign-in. */
export const RESTAURANT_CODE_KEY = "chilli.restaurantCode";

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export type RestaurantInput = { restaurant_code?: string; restaurant_id?: string };

/** What to send for whatever the user typed or pasted. Empty -> nothing (owners with one restaurant need no code). */
export function restaurantInput(raw: string | undefined | null): RestaurantInput {
  const v = (raw ?? "").trim();
  if (!v) return {};
  if (UUID.test(v)) return { restaurant_id: v };
  const code = v.replace(/[\s-]/g, "").toUpperCase();
  return code ? { restaurant_code: code } : {};
}

type Store = Pick<Storage, "getItem" | "setItem">;
const defaultStore = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

export function savedRestaurantCode(store: Store | null = defaultStore()): string {
  try { return restaurantInput(store?.getItem(RESTAURANT_CODE_KEY)).restaurant_code ?? ""; } catch { return ""; }
}
/** Remember the code after a sign-in that worked. `serverCode` (from /auth/me) wins, so a pasted UUID is replaced by the short code. */
export function rememberRestaurantCode(typed: string, serverCode?: string | null, store: Store | null = defaultStore()): void {
  const typedInput = restaurantInput(typed);
  if (!typedInput.restaurant_code && !typedInput.restaurant_id) return; // the user did not use the field: nothing to remember
  const code = restaurantInput(serverCode).restaurant_code ?? typedInput.restaurant_code;
  if (!code) return;
  try { store?.setItem(RESTAURANT_CODE_KEY, code); } catch { /* blocked storage: the field is simply empty next time */ }
}
