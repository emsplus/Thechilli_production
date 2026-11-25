/** Simple 24px outline icons for the bottom tab bar (inline SVG, inherit currentColor via .nav svg). */
const P: Record<string, string> = {
  "/tables": "M4 9h16M6 9v10M18 9v10M3 9l1.5-4h15L21 9M9 14h6",
  "/menu": "M7 3v7a2 2 0 0 0 2 2v9M11 3v7a2 2 0 0 1-2 2M17 21V3c-2.5 1.5-3.5 4-3.5 8h3.5",
  "/cart": "M6 8h12l-1 12H7L6 8ZM9 8V7a3 3 0 0 1 6 0v1",
  "/orders": "M7 3h10a1 1 0 0 1 1 1v17l-3-2-3 2-3-2-3 2V4a1 1 0 0 1 1-1ZM9.5 8h5M9.5 12h5",
  "/more": "M5 12h.01M12 12h.01M19 12h.01",
};
export function NavIcon({ href }: { href: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={P[href]} strokeWidth={href === "/more" ? 3.2 : undefined} /></svg>;
}
