export interface FieldError { field: string; message: string }

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public fieldErrors: FieldError[] = [],
    /** Seconds from Retry-After on a 429. */
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isNetwork() { return this.status === 0; }
  get isRateLimited() { return this.status === 429; }
}

async function toError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  const b = (body ?? {}) as { detail?: unknown; error?: { code?: string; message?: string } };
  let message = b.error?.message ?? (typeof b.detail === "string" ? b.detail : "");
  const fieldErrors: FieldError[] = [];
  if (Array.isArray(b.detail)) {
    for (const d of b.detail as { loc?: unknown[]; msg?: string }[]) {
      const loc = (d.loc ?? []).filter((x) => x !== "body");
      fieldErrors.push({ field: String(loc[loc.length - 1] ?? ""), message: (d.msg ?? "Invalid value").replace(/^Value error, /, "") });
    }
    message = fieldErrors[0]?.message ?? "";
  }
  const ra = Number(res.headers.get("Retry-After"));
  return new ApiError(res.status, message || `Request failed (${res.status})`, b.error?.code, fieldErrors, Number.isFinite(ra) && ra > 0 ? ra : undefined);
}

export interface HttpOptions { fetchImpl?: typeof fetch }

/** Anonymous only: no tokens, no cookies, no credentials. */
export function createHttp(opts: HttpOptions = {}) {
  return async function request<T>(method: string, url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", ...o.headers };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? globalThis.fetch)(url, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined, credentials: "omit" });
    } catch {
      throw new ApiError(0, "Cannot reach the server. Check your connection and try again.", "network");
    }
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  };
}
