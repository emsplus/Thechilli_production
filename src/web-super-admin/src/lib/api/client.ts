import type { ErrorBody } from "./types";
import { actionKey, retryWithStepUp, STEP_UP_HEADER, type StepUpProvider } from "../step-up";

/** A failed call. `status` 0 means the request never reached the server (offline, DNS, CORS). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: { loc: (string | number)[]; msg: string }[];
  readonly retryAfterSeconds?: number;
  constructor(status: number, code: string, message: string, extra?: { details?: ApiError["details"]; retryAfterSeconds?: number }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = extra?.details;
    this.retryAfterSeconds = extra?.retryAfterSeconds;
  }
  get isAuth() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  get isNotFound() { return this.status === 404; }
  /** 403 step_up_required: a fresh two-step code is needed for this action (docs/STEP_UP_UI_STATUS.md). */
  get isStepUpRequired() { return this.status === 403 && this.code === "step_up_required"; }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export function buildQuery(q?: Query): string {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export interface RequestOptions { query?: Query; body?: unknown; signal?: AbortSignal; headers?: Record<string, string>; /** The step-up call itself: never answered with a step-up prompt. */ noStepUp?: boolean }

export interface HttpClient {
  get<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T>;
  /** Raw text body (CSV exports). Same error handling as JSON calls. */
  getText(path: string, query?: Query, signal?: AbortSignal): Promise<string>;
  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  delete<T>(path: string, opts?: RequestOptions): Promise<T>;
}

export interface ClientConfig {
  /** Same-origin BFF prefix. Credentials live in httpOnly cookies set by the BFF: nothing is read or stored here. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Called once per 401 so the app can send the user to the sign-in page. */
  onUnauthorized?: () => void;
  /** Answers 403 step_up_required with a fresh-code prompt and repeats the request once with X-Step-Up-Token. */
  stepUp?: StepUpProvider;
}

export function parseErrorBody(status: number, text: string, retryAfter: string | null, stepUpHeader: string | null = null): ApiError {
  let body: Partial<ErrorBody> | undefined;
  try { body = text ? (JSON.parse(text) as Partial<ErrorBody>) : undefined; } catch { body = undefined; }
  const e = body?.error;
  const ra = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  return new ApiError(status, e?.code ?? (status === 401 ? "unauthorized" : status === 403 ? (stepUpHeader === "true" ? "step_up_required" : "forbidden") : status === 404 ? "not_found" : "http_error"),
    e?.message ?? `Request failed (${status})`, { details: e?.details, retryAfterSeconds: ra });
}

export function createHttpClient(cfg: ClientConfig = {}): HttpClient {
  const base = (cfg.baseUrl ?? "/api/hq").replace(/\/$/, "");
  const doFetch = cfg.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function request<T>(method: string, path: string, o: RequestOptions = {}, raw = false): Promise<T> {
    return retryWithStepUp(actionKey(method, path), (token) => send<T>(method, path, o, raw, token), cfg.stepUp, !o.noStepUp);
  }

  async function send<T>(method: string, path: string, o: RequestOptions, raw: boolean, stepUpToken?: string): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", ...o.headers };
    if (stepUpToken) headers[STEP_UP_HEADER] = stepUpToken;
    let body: string | undefined;
    if (o.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(o.body); }
    // Custom header on every call: a cross-site form post cannot set it, so it doubles as CSRF protection for the BFF.
    headers["X-HQ-CSRF"] = "1";
    let res: Response;
    try {
      res = await doFetch(`${base}${path}${buildQuery(o.query)}`, { method, headers, body, signal: o.signal, credentials: "same-origin", cache: "no-store" });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new ApiError(0, "network", "Cannot reach the server. Check your connection and try again.");
    }
    const text = await res.text();
    if (!res.ok) {
      const err = parseErrorBody(res.status, text, res.headers.get("Retry-After"), res.headers.get("X-Step-Up-Required"));
      if (err.isAuth) cfg.onUnauthorized?.();
      throw err;
    }
    if (raw) return text as T;
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    get: (p, q, signal) => request("GET", p, { query: q, signal }),
    getText: (p, q, signal) => request("GET", p, { query: q, signal }, true),
    post: (p, b, o) => request("POST", p, { ...o, body: b }),
    put: (p, b, o) => request("PUT", p, { ...o, body: b }),
    patch: (p, b, o) => request("PATCH", p, { ...o, body: b }),
    delete: (p, o) => request("DELETE", p, o),
  };
}
