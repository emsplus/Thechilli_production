"use client";
import { useEffect, type ReactNode } from "react";

export type PadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "back";

/** Pure: the entered digits after one key. Digits past `max` are ignored. */
export function padInput(value: string, key: PadKey, max: number): string {
  if (key === "back") return value.slice(0, -1);
  return value.length >= max ? value : value + key;
}

const ROWS: PadKey[][] = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]];

/** Filled / empty dots: never the digits themselves. `slots` = how many to draw (the MPIN length, or 6 while choosing one). */
export function PinDots({ filled, slots, error }: { filled: number; slots: number; error?: boolean }) {
  return (
    <div className={`pindots${error ? " shake" : ""}`} role="img" aria-label={`${filled} of ${slots} digits entered`}>
      {Array.from({ length: slots }, (_, i) => <i key={i} data-on={i < filled ? "1" : undefined} />)}
    </div>
  );
}

/**
 * Big numeric keypad (72 px keys, well over the 44 px minimum). Bottom-left holds the Face ID / fingerprint button when
 * there is one. Hardware keyboards work too (digits, Backspace).
 */
export function Keypad({ value, max, onChange, disabled, extra }: { value: string; max: number; onChange: (v: string) => void; disabled?: boolean; extra?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (disabled) return;
      if (/^\d$/.test(e.key)) onChange(padInput(value, e.key as PadKey, max));
      else if (e.key === "Backspace") onChange(padInput(value, "back", max));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [value, max, onChange, disabled]);
  const press = (k: PadKey) => { if (!disabled) onChange(padInput(value, k, max)); };
  return (
    <div className="keypad" role="group" aria-label="Number keypad">
      {ROWS.flat().map((k) => <button key={k} type="button" className="key" disabled={disabled} onClick={() => press(k)}>{k}</button>)}
      <div className="key-slot">{extra}</div>
      <button type="button" className="key" disabled={disabled} onClick={() => press("0")}>0</button>
      <button type="button" className="key key-back" disabled={disabled || !value} aria-label="Delete last digit" onClick={() => press("back")}>
        <svg viewBox="0 0 24 24" aria-hidden><path d="M9 5h11v14H9l-6-7z" /><path d="M12 9l5 6M17 9l-5 6" /></svg>
      </button>
    </div>
  );
}
