import type { TokenStore } from "./tokens";
import type { DuplicateOut, TokenOut } from "./types";

export interface FieldError { field: string; message: string }

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public fieldErrors: FieldError[] = [],
    /** Set on 409 from POST/PATCH /leads: possible duplicates. */
    public duplicates?: DuplicateOut[],
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isNotFound() { return this.status === 404; }
  get isForbidden() { return this.status === 403; }
  get isNetwork() { return this.status === 0; }
}

export interface HttpOptions {
  baseUrl: string;
  tokens: TokenStore;
  fetchImpl?: typeof fetch;
  /** Called when a refresh fails: the UI should go to /login. */
  onSessionExpired?: () => void;
}

type Query = Record<string, string | number | boolean | undefined | null>;
export interface RequestOptions { query?: object; body?: unknown; auth?: boolean; raw?: { data: Blob | ArrayBuffer; contentType: string }; blob?: boolean }

function qs(query?: object): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query as Query)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function toError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  const b = (body ?? {}) as { detail?: unknown; error?: { code?: string; message?: string } };
  let message = b.error?.message ?? (typeof b.detail === "string" ? b.detail : "") ?? "";
  const fieldErrors: FieldError[] = [];
  let duplicates: ApiError["duplicates"];
  if (Array.isArray(b.detail)) {
    for (const d of b.detail as { loc?: unknown[]; msg?: string }[]) {
      const loc = (d.loc ?? []).filter((x) => x !== "body");
      fieldErrors.push({ field: String(loc[loc.length - 1] ?? ""), message: (d.msg ?? "Invalid value").replace(/^Value error, /, "") });
    }
    message = fieldErrors[0]?.message ?? "Check the form and try again";
  } else if (b.detail && typeof b.detail === "object") {
    const d = b.detail as { message?: string; duplicates?: ApiError["duplicates"] };
    message = d.message ?? message;
    duplicates = d.duplicates;
  }
  return new ApiError(res.status, message || `Request failed (${res.status})`, b.error?.code, fieldErrors, duplicates);
}

export function createHttp(opts: HttpOptions) {
  const f = (...a: Parameters<typeof fetch>) => (opts.fetchImpl ?? globalThis.fetch)(...a);
  const cookie = opts.tokens.mode === "cookie";
  let refreshing: Promise<boolean> | null = null;

  async function send(method: string, path: string, o: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    if (o.raw) headers["Content-Type"] = o.raw.contentType;
    if (cookie) headers["X-CSRF"] = "1"; // cross-site requests cannot set custom headers without a preflight we never allow
    const access = opts.tokens.getAccess();
    if (o.auth !== false && access) headers.Authorization = `Bearer ${access}`;
    try {
      return await f(`${opts.baseUrl}${path}${qs(o.query)}`, {
        method, headers, body: o.raw ? o.raw.data : o.body !== undefined ? JSON.stringify(o.body) : undefined,
        credentials: cookie ? "include" : "omit",
      });
    } catch {
      throw new ApiError(0, "Cannot reach the server. Check your connection and try again.", "network");
    }
  }

  /** Single-flight refresh: concurrent 401s share one refresh call (refresh tokens rotate, replay revokes sessions). */
  function refresh(): Promise<boolean> {
    refreshing ??= (async () => {
      const refreshToken = opts.tokens.getRefresh();
      if (!cookie && !refreshToken) return false;
      try {
        const res = await send("POST", "/auth/refresh", { auth: false, body: cookie ? {} : { refresh_token: refreshToken } });
        if (!res.ok) return false;
        const t = (await res.json()) as TokenOut;
        if (!cookie) opts.tokens.set({ access: t.access_token, refresh: t.refresh_token });
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => { refreshing = null; }, 0);
      }
    })();
    return refreshing;
  }

  async function request<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    let res = await send(method, path, o);
    if (res.status === 401 && o.auth !== false && !path.startsWith("/auth/")) {
      if (await refresh()) res = await send(method, path, o);
      else {
        opts.tokens.set(null);
        opts.onSessionExpired?.();
      }
    }
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    return (o.blob ? await res.blob() : await res.json()) as T;
  }

  return { request, refresh };
}
export type Http = ReturnType<typeof createHttp>;
