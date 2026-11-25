"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { htmlLang, t as dsT, type Locale } from "@chilli/ui";

/** English, Hindi (Devanagari) or Hinglish (Hindi in Latin letters). One choice for the whole app, kept on this device. */
export type { Locale };
export const LOCALES: Locale[] = ["en", "hi", "hinglish"];
export const LOCALE_LABEL: Record<Locale, string> = { en: "English", hi: "हिन्दी", hinglish: "Hinglish" };
const KEY = "pos.locale";

/**
 * The UI is English only for now (docs/DECISIONS.md). Hindi and Hinglish stay in the catalogs and switch on with
 * NEXT_PUBLIC_ENABLE_LANGUAGES=true at build time. Off (the default): the locale is always "en", nothing is auto-detected
 * from the browser or device, and a stored non-English choice is ignored.
 */
export const LANGUAGES_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LANGUAGES === "true" || process.env.NEXT_PUBLIC_ENABLE_LANGUAGES === "1";

/** The locale actually used for a stored choice. Pure, so it is unit-tested. */
export function resolveLocale(stored: string | null | undefined, enabled: boolean = LANGUAGES_ENABLED): Locale {
  if (!enabled) return "en";
  return stored === "hi" || stored === "hinglish" ? stored : "en";
}

interface Ctx { locale: Locale; setLocale: (l: Locale) => void }
const LocaleCtx = createContext<Ctx>({ locale: "en", setLocale: () => {} });

let session: Locale | null = null; // survives when storage is blocked
function read(): Locale {
  if (!LANGUAGES_ENABLED) return "en";
  if (session) return session;
  try { return resolveLocale(localStorage.getItem(KEY)); } catch { return "en"; }
}

const EVT = "pos-locale-change";
function subscribe(cb: () => void) {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => { window.removeEventListener(EVT, cb); window.removeEventListener("storage", cb); };
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  // Server snapshot is "en", so the first client render matches the server; the stored choice applies right after hydration.
  const locale = useSyncExternalStore<Locale>(subscribe, read, () => "en");
  useEffect(() => { document.documentElement.lang = LANGUAGES_ENABLED ? htmlLang[locale] : htmlLang.en; }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    if (!LANGUAGES_ENABLED) return;
    session = l;
    try { localStorage.setItem(KEY, l); } catch { /* private mode: applies for this session */ }
    window.dispatchEvent(new Event(EVT));
  }, []);
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleCtx.Provider value={value}>{children}</LocaleCtx.Provider>;
}

export function useLocale(): Ctx { return useContext(LocaleCtx); }

/** One message in the three languages. Missing hi/hinglish falls back to English, so a screen is never blank. */
export interface Msg { en: string; hi?: string; hinglish?: string }
export type Catalog = Record<string, Msg>;

/** Resolve `{n}` style params. */
function fill(s: string, params?: Record<string, string | number>) {
  return params ? s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`)) : s;
}

/** Plain function form (non-React code, tests). */
export function msg(locale: Locale, m: Msg, params?: Record<string, string | number>): string {
  return fill(m[locale] ?? m.en, params);
}

/**
 * Per-screen translator: `const t = useMsg(CATALOG); t("title")`. Keys not in the catalog fall through to the
 * design-system catalog (`action.save`, `common.loading`, ...), then to the key itself.
 */
export function useMsg<C extends Catalog>(catalog: C) {
  const { locale } = useLocale();
  return useCallback((key: string, params?: Record<string, string | number>) => {
    const m = catalog[key];
    return m ? msg(locale, m, params) : dsT(locale, key, params);
  }, [catalog, locale]);
}
