"use client";
import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Keyboard focus for sheets and dialogs (D18 of docs/testing/BREAK_UI_REPORT.md, in the waiter app): Escape / Close / Add used to drop
 * focus on <body> (a keyboard or switch user starts again from the top of the page) and Tab walked out of a modal sheet into the page behind it.
 */

/**
 * Where Tab should go inside a dialog with `count` focusable controls when `current` has the focus (-1 = nothing inside it).
 * Returns the index to focus, `-1` for "the dialog itself" (no controls) or `null` = let the browser move on (it stays inside).
 */
export function tabTarget(count: number, current: number, shift: boolean): number | null {
  if (count === 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  if (!shift && current === count - 1) return 0;
  if (shift && current === 0) return count - 1;
  return null;
}

/**
 * Open dialogs, oldest first. Only the topmost one handles Tab and Esc: two dialogs mounted together (a sheet over a sheet) used to fight
 * over the focus (the lower one pulled it back to itself) and Esc closed both (L2 of docs/testing/INDEPENDENT_REVIEW_REPORT.md).
 */
export function createDialogStack<T>() {
  const items: T[] = [];
  return {
    push(t: T) { items.push(t); },
    remove(t: T) { const i = items.lastIndexOf(t); if (i >= 0) items.splice(i, 1); },
    isTop(t: T) { return items.length > 0 && items[items.length - 1] === t; },
    get size() { return items.length; },
  };
}
const openDialogs = createDialogStack<object>();

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
export const focusablesIn = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden");

/**
 * Wire a dialog: focus moves into it on open (unless a control inside already took it, like an autoFocus search box), Escape closes,
 * `trap` keeps Tab / Shift+Tab inside, and when it closes the focus returns to the control that opened it (if that is still on screen).
 * The dialog element needs tabIndex={-1} so it can take the focus when it has no controls yet.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void, opts: { trap?: boolean } = {}): void {
  const trap = opts.trap ?? true;
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  // Read while rendering: the click that opened the dialog has not moved the focus yet (an autoFocus field does, during commit).
  const [opener] = useState<HTMLElement | null>(() => (typeof document !== "undefined" && document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null));
  const [me] = useState(() => ({}));
  useEffect(() => {
    const el = ref.current;
    openDialogs.push(me);
    if (el && !el.contains(document.activeElement)) el.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!openDialogs.isTop(me)) return; // a dialog above this one owns Tab and Esc
      if (e.key === "Escape") { close.current(); return; }
      if (e.key !== "Tab" || !trap || !el) return;
      const items = focusablesIn(el);
      const t = tabTarget(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (t === null) return;
      e.preventDefault();
      (t === -1 ? el : items[t]).focus();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); openDialogs.remove(me); if (opener?.isConnected) opener.focus(); };
  }, [ref, trap, opener, me]);
}
