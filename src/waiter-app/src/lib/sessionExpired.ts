/** Plain login-screen message after the server rejected the refresh token. N counts orders, not queue steps. */
export function expiredMessage(unsyncedOrderRefs: string[]): string {
  const n = new Set(unsyncedOrderRefs).size;
  return n > 0 ? `Session expired, sign in to send ${n} order(s)` : "Session expired, sign in again";
}
