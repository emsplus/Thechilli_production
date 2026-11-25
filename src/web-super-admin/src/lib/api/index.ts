import { createHttpClient } from "./client";
import { createApi } from "./endpoints";
import { stepUpCoordinator } from "../step-up-coordinator";

let unauthorizedHandler: (() => void) | null = null;
export const onUnauthorized = (fn: (() => void) | null) => { unauthorizedHandler = fn; };

export const http = createHttpClient({ onUnauthorized: () => { stepUpCoordinator.clear(); unauthorizedHandler?.(); }, stepUp: stepUpCoordinator });
export const sessionHttp = createHttpClient({ baseUrl: "/api/session" });
export const api = createApi(http);
export * from "./client";
export type * from "./types";
