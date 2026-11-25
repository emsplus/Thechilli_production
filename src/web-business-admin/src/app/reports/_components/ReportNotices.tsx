import type { ReactNode } from "react";
import { ErrorState } from "@chilli/ui";
import { useLocale, useMsg } from "@/lib/i18n";
import type { ReportMeta } from "@/lib/types";
import { BlockSkeleton, Notice } from "./parts";

const MSG = {
  incomplete: { en: "Incomplete data", hi: "अधूरा डेटा", hinglish: "Adhoora data" },
  unsynced: { en: "Some devices have unsynced sales.", hi: "कुछ डिवाइस की बिक्री सिंक नहीं हुई है।", hinglish: "Kuch devices ki sales sync nahi hui hain." },
  maychange: { en: "Figures may change once every device has synced.", hi: "सभी डिवाइस सिंक होने पर आँकड़े बदल सकते हैं।", hinglish: "Saare devices sync hone par figures badal sakte hain." },
  fail: { en: "Could not load this report", hi: "यह रिपोर्ट लोड नहीं हो सकी", hinglish: "Yeh report load nahi ho payi" },
  loading: { en: "Loading report", hi: "रिपोर्ट लोड हो रही है", hinglish: "Report load ho rahi hai" },
};

/** Honest footer for an insight report: unsynced devices (`data_complete=false`) and the API's own warnings, each once. */
export function ReportNotices({ meta, extra = [] }: { meta: ReportMeta; extra?: string[] }) {
  const t = useMsg(MSG);
  const { locale } = useLocale();
  const notes = [...new Set([...(meta.warnings ?? []), ...extra].filter(Boolean))];
  if (meta.data_complete && notes.length === 0) return null;
  return (
    <div className="mb-4 space-y-2" data-testid="report-notices">
      {!meta.data_complete && <Notice tone="warning" title={t("incomplete")} locale={locale}>{meta.incomplete_reason ?? t("unsynced")} {t("maychange")}</Notice>}
      {notes.map((n) => <Notice key={n} tone="warning" locale={locale}>{n}</Notice>)}
    </div>
  );
}

/** Shared load / error / forbidden shell for the new tabs. */
export function InsightShell({ loading, error, stale, children, onRetry }: { loading: boolean; error?: string; stale?: boolean; children: ReactNode; onRetry?: () => void }) {
  const t = useMsg(MSG);
  const { locale } = useLocale();
  if (error) return <ErrorState title={t("fail")} description={error} onAction={onRetry} locale={locale} />;
  if (loading) return <BlockSkeleton label={t("loading")} rows={4} />;
  return <div className={stale ? "opacity-70 transition-opacity" : "transition-opacity"} aria-busy={stale}>{children}</div>;
}
