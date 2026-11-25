"use client";

import { LANGUAGES_ENABLED, LOCALES, LOCALE_LABEL, useLocale, type Locale } from "@/lib/i18n";

/** Language picker for the top bar: English, हिन्दी, Hinglish. Native select (44px target, OS picker on phones). */
export function LocaleSwitch() {
  const { locale, setLocale } = useLocale();
  if (!LANGUAGES_ENABLED) return null; // English only unless NEXT_PUBLIC_ENABLE_LANGUAGES=true
  return (
    <select aria-label="Language" title="Language" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}
      className="ch-input ch-select h-11 w-auto max-w-[8.5rem] shrink-0 py-0 text-sm">
      {LOCALES.map((l) => <option key={l} value={l}>{LOCALE_LABEL[l]}</option>)}
    </select>
  );
}
