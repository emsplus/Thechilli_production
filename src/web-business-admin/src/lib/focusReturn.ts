/**
 * Keyboard users: closing a dialog or sheet (Esc, Cancel, a click outside) must put focus back on the control that opened it, not leave
 * it on <body> so the next Tab starts again at the top of the page (QA D18). The dialogs are controlled (no Radix Trigger), so nothing
 * returned focus. This remembers the last control the user used outside any dialog and, when a dialog leaves the page while focus is on
 * <body>, gives focus back to that control. It never steals focus: if something else already has it (or another dialog is open), it does nothing.
 */
const DIALOG = '[role="dialog"],[role="alertdialog"]';
const INTERACTIVE = 'button,a[href],input,select,textarea,summary,[role="button"],[role="tab"],[role="menuitem"],[tabindex]';

export function installFocusReturn(doc: Document = document): () => void {
  let last: HTMLElement | null = null;
  const remember = (t: EventTarget | null) => {
    if (!(t instanceof HTMLElement) || t === doc.body || t.closest(DIALOG)) return;
    const el = t.closest<HTMLElement>(INTERACTIVE) ?? t;
    if (el !== doc.body) last = el;
  };
  const onFocusIn = (e: FocusEvent) => remember(e.target);
  const onClick = (e: MouseEvent) => remember(e.target); // Safari / iOS do not focus a button on click
  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("click", onClick, true);

  const giveBack = () => {
    const a = doc.activeElement;
    if (a && a !== doc.body && a !== doc.documentElement) return; // focus is somewhere real: leave it
    if (doc.querySelector(DIALOG)) return; // another dialog still open
    const el = last;
    if (!el || !el.isConnected || (el as HTMLButtonElement).disabled || el.closest("[hidden],[inert]")) return;
    el.focus({ preventScroll: true });
  };
  const hasDialog = (n: Node) => n instanceof Element && (n.matches(DIALOG) || !!n.querySelector(DIALOG));
  const mo = new MutationObserver((records) => {
    for (const r of records) for (const n of Array.from(r.removedNodes)) if (hasDialog(n)) { setTimeout(giveBack, 0); return; }
  });
  mo.observe(doc.body, { childList: true, subtree: true });
  return () => { doc.removeEventListener("focusin", onFocusIn, true); doc.removeEventListener("click", onClick, true); mo.disconnect(); };
}
