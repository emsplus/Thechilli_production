"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { Check, Pencil, Trash2 } from "lucide-react";
import { Badge, Button, IconButton, Input, Skeleton } from "@chilli/ui";
import { useNotify } from "@/lib/useNotify";
import { useMsg } from "@/lib/i18n";
import { api, ApiError } from "@/lib/api";
import { useLoader } from "@/lib/useLoader";
import { hiddenSuggestions, hideSuggestion, menuSuggestions, type Suggestion } from "@/lib/dishSuggest";
import { dishLessons, forgetDish, onDishLessons } from "@/lib/dishLearn";
import type { MenuItem } from "@/lib/types";
import { MENU_MSG } from "./menu-messages";

const fetchItems = () => api.items();
const FIRST = 8;
const NO_LESSONS: ReturnType<typeof dishLessons> = [];

/**
 * Suggested pronunciations per dish (dishSuggest.ts: generated on this device from the dish names, cached per menu) and the
 * phrases this device learnt from staff corrections (dishLearn.ts). Accept = the restaurant's learnt phrases for every till
 * (PUT /menu/voice-aliases); edit = change the text first; delete = hidden from this list on this device.
 */
export function SuggestedPronunciations({ onAccepted }: { onAccepted?: () => void }) {
  const t = useMsg(MENU_MSG);
  const toast = useNotify();
  const { data, loading } = useLoader(fetchItems);
  const dishes = useMemo(() => (data ?? []).filter((i: MenuItem) => i.is_active !== false), [data]);
  const sugg = useMemo(() => menuSuggestions(dishes), [dishes]);
  const [hidden, setHidden] = useState(() => hiddenSuggestions());
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lessons = useSyncExternalStore(onDishLessons, dishLessons, () => NO_LESSONS);
  const nameOf = useMemo(() => new Map(dishes.map((d) => [d.id, d.name])), [dishes]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return dishes.map((d) => ({ d, list: (sugg.get(d.id) ?? []).filter((x) => !hidden.has(`${d.id}|${x.text}`)) }))
      .filter((r) => r.list.length && (!s || r.d.name.toLowerCase().includes(s) || r.list.some((x) => x.text.includes(s))));
  }, [dishes, sugg, hidden, q]);
  const shown = all || q ? rows : rows.slice(0, FIRST);

  const hide = (id: string, text: string) => { hideSuggestion(id, text); setHidden(hiddenSuggestions()); };
  async function accept(d: MenuItem, text: string, original: string) {
    const phrase = text.trim();
    if (!phrase) return;
    setBusy(`${d.id}|${original}`);
    try {
      await api.learnVoiceAlias({ phrase, menu_item_id: d.id, variant_id: null });
      hide(d.id, original);
      setEditing(null);
      toast.success(t("suggestAccepted", { phrase, item: d.name }));
      onAccepted?.();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : t("suggestFail")); }
    finally { setBusy(null); }
  }
  const kind = (k: Suggestion["kind"]) => t(k === "devanagari" ? "kindDevanagari" : k === "hinglish" ? "kindHinglish" : "kindOther");

  return (
    <div className="mt-6 space-y-6">
      {lessons.length > 0 && (
        <section aria-labelledby="device-lessons">
          <h3 id="device-lessons" className="text-sm font-semibold text-fg">{t("deviceTitle")}</h3>
          <p className="mb-2 text-sm text-fg-muted">{t("deviceIntro")}</p>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
            {lessons.map((l) => (
              <li key={l.phrase} data-testid="device-lesson" className="flex items-center gap-3 px-3 py-2 sm:px-4">
                <p className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]"><span className="font-semibold text-fg">“{l.phrase}”</span> <span className="text-fg-muted">→ {nameOf.get(l.itemId) ?? l.itemId}</span></p>
                <IconButton label={t("deviceForget", { phrase: l.phrase })} icon={<Trash2 />} variant="ghost" onClick={() => forgetDish(l.phrase)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="suggest-title">
        <h3 id="suggest-title" className="text-sm font-semibold text-fg">{t("suggestTitle")}</h3>
        <p className="mb-2 text-sm text-fg-muted">{t("suggestIntro")}</p>
        {loading ? <Skeleton height={120} /> : (
          <>
            <div className="mb-2 sm:max-w-xs"><Input label={t("suggestSearch")} type="search" placeholder={t("suggestSearch")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
            {rows.length === 0 ? <p className="text-sm text-fg-muted">{t("suggestNone")}</p> : (
              <ul aria-label={t("suggestTitle")} className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
                {shown.map(({ d, list }) => (
                  <li key={d.id} data-testid="suggest-dish" className="px-3 py-2.5 sm:px-4">
                    <p className="font-semibold text-fg">{d.name}</p>
                    <ul className="mt-1.5 flex flex-wrap gap-2">
                      {list.map((x) => {
                        const key = `${d.id}|${x.text}`;
                        if (editing?.key === key) {
                          return (
                            <li key={key} className="flex w-full flex-wrap items-end gap-2">
                              <div className="min-w-0 flex-1 basis-48"><Input label={t("suggestEdit", { phrase: x.text })} value={editing.text} onChange={(e) => setEditing({ key, text: e.target.value })} /></div>
                              <Button size="sm" loading={busy === key} onClick={() => void accept(d, editing.text, x.text)}>{t("suggestSave")}</Button>
                              <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>{t("suggestCancel")}</Button>
                            </li>
                          );
                        }
                        return (
                          <li key={key} data-testid="suggestion" className="flex items-center gap-1 rounded-xl border border-border bg-surface-2 py-0.5 pl-3 pr-1">
                            <span className="text-sm text-fg" lang={x.kind === "devanagari" ? "hi" : undefined}>{x.text}</span>
                            <Badge>{kind(x.kind)}</Badge>
                            <IconButton label={t("suggestAccept", { phrase: x.text, item: d.name })} icon={<Check />} variant="ghost" disabled={busy === key} onClick={() => void accept(d, x.text, x.text)} />
                            <IconButton label={t("suggestEdit", { phrase: x.text })} icon={<Pencil />} variant="ghost" onClick={() => setEditing({ key, text: x.text })} />
                            <IconButton label={t("suggestDelete", { phrase: x.text })} icon={<Trash2 />} variant="ghost" onClick={() => hide(d.id, x.text)} />
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            {!all && !q && rows.length > FIRST && <Button className="mt-2" size="sm" variant="secondary" onClick={() => setAll(true)}>{t("suggestShowAll", { n: rows.length })}</Button>}
          </>
        )}
      </section>
    </div>
  );
}
