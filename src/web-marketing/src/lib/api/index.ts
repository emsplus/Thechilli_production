import { createApi } from "./client";
import { CookieTokenStore, MemoryTokenStore, type TokenStore } from "./tokens";

export const MOCK_MODE = process.env.NEXT_PUBLIC_API_MOCK === "1";
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";

/**
 * Cookie mode: the browser talks only to the same-origin BFF (/api/mkt), which holds the tokens in httpOnly cookies, so a reload
 * keeps the session. It is the default against the real API; the in-browser mock defaults to bearer (memory tokens).
 * Override with NEXT_PUBLIC_AUTH_MODE=cookie|bearer.
 */
export const COOKIE_MODE = (process.env.NEXT_PUBLIC_AUTH_MODE ?? (MOCK_MODE ? "bearer" : "cookie")) === "cookie";
export const tokenStore: TokenStore = COOKIE_MODE ? new CookieTokenStore() : new MemoryTokenStore();

let sessionExpired: () => void = () => {};
export const onSessionExpired = (fn: () => void) => { sessionExpired = fn; };

let mockFetch: typeof fetch | undefined;
const lazyMockFetch: typeof fetch = async (input, init) => {
  mockFetch ??= (await import("@/mocks/handler")).createMockFetch();
  return mockFetch(input, init);
};

export const api = createApi({
  baseUrl: COOKIE_MODE ? "/api/mkt" : MOCK_MODE ? "/api/v1" : API_BASE_URL,
  tokens: tokenStore,
  fetchImpl: MOCK_MODE && !COOKIE_MODE ? lazyMockFetch : undefined, // cookie mode: the mock (if any) runs inside the BFF
  onSessionExpired: () => sessionExpired(),
});
export { ApiError } from "./http";
export type { Api } from "./client";
