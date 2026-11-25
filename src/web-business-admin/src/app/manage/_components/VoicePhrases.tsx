"use client";

import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Badge, Button, EmptyState, IconButton, Input, Notice, Skeleton } from "@chilli/ui";
import { useAsk } from "@/lib/useAsk";
import { useNotify } from "@/lib/useNotify";
import { useMsg } from "@/lib/i18n";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useLoader } from "@/lib/useLoader";
import type { VoiceAlias } from "@/lib/types";
import { MENU_MSG } from "./menu-messages";
import { SuggestedPronunciations } from "./SuggestedPronunciations";

const fetchAliases = () => api.voiceAliases();

/**
 * Phrases the voice ordering learnt from staff: when a spoken dish was not matched (or matched wrongly) and staff picked
 * the right one before adding the order, the till remembers it. A wrong lesson is removed here.
 */
export function VoicePhrases() {
  const [ask, askNode] = useAsk();
  const toast = useNotify();
  const t = useMsg(MENU_MSG);
  const { data, error, loading, reload } = useLoader(fetchAliases);
  const [q, setQ] = useState("");
  const all = useMemo(() => data ?? [], [data]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return all.filter((a) => !s || a.phrase.includes(s) || a.item_name.toLowerCase().includes(s));
  }, [all, q]);

  async function forget(a: VoiceAlias) {
    if (!(await ask({ title: t("forgetTitle", { phrase: a.phrase }), description: t("forgetDesc", { item: a.item_name }), confirmLabel: t("forget"), destructive: true }))) return;
    try { await api.deleteVoiceAlias(a.id); toast.success(t("forgotten", { phrase: a.phrase })); void reload(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : t("removeFail")); }
  }

  return (
    <>
      {askNode}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 basis-64 text-sm text-fg-muted">{t("voiceIntro")}</p>
        {all.length > 0 && <div className="min-w-0 flex-1 basis-48 sm:max-w-xs"><Input label={t("searchPhrases")} type="search" placeholder={t("searchPhrases")} value={q} onChange={(e) => setQ(e.target.value)} /></div>}
      </div>
      {error && <div className="mb-4"><Notice tone="danger" title={t("loadPhrasesFail")} action={<Button size="sm" onClick={() => void reload()}>{t("retry")}</Button>}>{error}</Notice></div>}
      {loading ? (
        <Skeleton height={160} />
      ) : all.length === 0 ? (
        <EmptyState title={t("nothingLearnt")} description={t("nothingLearntDesc")} />
      ) : shown.length === 0 ? (
        <EmptyState title={t("noPhrases")} description={t("tryDifferent")} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <ul aria-label={t("learntPhrases")} className="divide-y divide-border">
            {shown.map((a) => (
              <li key={a.id} data-testid="voice-phrase" className={cn("flex items-center gap-3 px-3 py-2.5 sm:px-4", !a.item_active && "opacity-75")}>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-fg [overflow-wrap:anywhere]">“{a.phrase}”</p>
                  <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
                    {t(a.uses === 1 ? "usedOne" : "usedMany", { who: `${a.item_name}${a.variant_name ? ` · ${a.variant_name}` : ""}`, n: a.uses })}
                    {!a.item_active && <span className="ml-2"><Badge>{t("dishArchived")}</Badge></span>}
                  </p>
                </div>
                <IconButton label={t("forgetLabel", { phrase: a.phrase })} icon={<Trash2 />} onClick={() => void forget(a)} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <SuggestedPronunciations onAccepted={() => void reload()} />
    </>
  );
}
