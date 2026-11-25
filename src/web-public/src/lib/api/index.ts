import { createApi } from "./client";

export const MOCK_MODE = process.env.NEXT_PUBLIC_API_MOCK === "1";
export const PLATFORM_URL = process.env.NEXT_PUBLIC_PLATFORM_API_URL ?? "http://localhost:8400/api/v1";
export const MARKETING_URL = process.env.NEXT_PUBLIC_MARKETING_API_URL ?? "http://localhost:8000/api/v1";

let mockFetch: typeof fetch | undefined;
const lazyMockFetch: typeof fetch = async (input, init) => {
  mockFetch ??= (await import("@/mocks/handler")).createMockFetch();
  return mockFetch(input, init);
};

export const api = createApi({
  platformUrl: MOCK_MODE ? "/mock/platform/api/v1" : PLATFORM_URL,
  marketingUrl: MOCK_MODE ? "/mock/marketing/api/v1" : MARKETING_URL,
  fetchImpl: MOCK_MODE ? lazyMockFetch : undefined,
});
export { ApiError } from "./http";
export type { Api } from "./client";
