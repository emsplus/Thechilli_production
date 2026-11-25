/** Post-login return path. Only same-origin absolute paths are honoured, never `//host`, `/\host` or a login loop. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /[\u0000-\u001f]/.test(raw)) return "/";
  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login/")) return "/";
  return raw;
}

export function loginUrl(here: string): string {
  const next = safeNext(here);
  return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}
