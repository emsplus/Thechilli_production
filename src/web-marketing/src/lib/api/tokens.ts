// Token storage abstraction. Tokens never touch localStorage/sessionStorage.
//  - "bearer" mode (today): marketing-service returns tokens in the JSON body, so they are kept in memory only.
//    A page reload therefore means signing in again; that is the price of not persisting tokens in JS-readable storage.
//  - "cookie" mode (ready, not yet served by the backend): the server sets httpOnly cookies, the client holds no
//    token at all and sends `credentials: "include"`.

export interface Tokens { access: string; refresh: string }

export interface TokenStore {
  readonly mode: "bearer" | "cookie";
  getAccess(): string | null;
  getRefresh(): string | null;
  set(tokens: Tokens | null): void;
}

export class MemoryTokenStore implements TokenStore {
  readonly mode = "bearer" as const;
  #tokens: Tokens | null = null;
  getAccess() { return this.#tokens?.access ?? null; }
  getRefresh() { return this.#tokens?.refresh ?? null; }
  set(tokens: Tokens | null) { this.#tokens = tokens; }
}

/** httpOnly-cookie-ready store: holds nothing; the browser attaches the cookies. */
export class CookieTokenStore implements TokenStore {
  readonly mode = "cookie" as const;
  getAccess() { return null; }
  getRefresh() { return null; }
  set() { /* cookies are set by the server via Set-Cookie */ }
}
