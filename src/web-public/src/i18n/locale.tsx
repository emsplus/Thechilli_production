"use client";
import { useEffect, useSyncExternalStore } from "react";
import { en, type CopyKey } from "./en";
import { hi } from "./hi";

export type Lang = "en" | "hi";
/**
 * OWNER DECISION (docs/DECISIONS.md, 2026-10-31): English only. The Hindi catalog and this layer stay in the code,
 * dormant unless built with NEXT_PUBLIC_ENABLE_LANGUAGES=true: no switcher, stored preference ignored, no
 * auto-detection of the browser language.
 */
export const languagesEnabled = (): boolean => ["true", "1"].includes(process.env.NEXT_PUBLIC_ENABLE_LANGUAGES ?? "");
const KEY = "chilli-lang";
const listeners = new Set<() => void>();
let current: Lang = "en";
let loaded = false;

function load() {
  if (loaded || typeof window === "undefined" || !languagesEnabled()) return;
  loaded = true;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "hi" || saved === "en") current = saved;
    else if (navigator.language?.toLowerCase().startsWith("hi")) current = "hi";
  } catch { /* storage blocked: stay on English */ }
}
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const getLang = (): Lang => { load(); return languagesEnabled() ? current : "en"; };
const getSnapshot = getLang;
const getServerSnapshot = (): Lang => "en";

export function setLang(l: Lang) {
  if (!languagesEnabled()) return;
  current = l; loaded = true;
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  listeners.forEach((f) => f());
}
export function useLang(): Lang {
  const l = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => { document.documentElement.lang = l === "hi" ? "hi-IN" : "en-IN"; }, [l]);
  return l;
}

export type Params = Record<string, string | number>;
export function translate(lang: Lang, key: CopyKey, params?: Params): string {
  let s: string = (lang === "hi" ? hi : en)[key] ?? en[key];
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
export function useT() {
  const lang = useLang();
  return (key: CopyKey, params?: Params) => translate(lang, key, params);
}
/** Text node that follows the language switch. Server-rendered in English. */
export function T({ k, params }: { k: CopyKey; params?: Params }) {
  return <>{useT()(k, params)}</>;
}

export function LangSwitch() {
  const lang = useLang();
  const t = useT();
  if (!languagesEnabled()) return null;
  return (
    <div className="langsw" role="group" aria-label={t("lang.label")}>
      {(["en", "hi"] as const).map((l) => (
        <button key={l} type="button" lang={l === "hi" ? "hi" : "en"} aria-pressed={lang === l} onClick={() => setLang(l)}>{translate(l, l === "hi" ? "lang.hi" : "lang.en")}</button>
      ))}
    </div>
  );
}
