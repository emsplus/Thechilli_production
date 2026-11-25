"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, FileDown, RefreshCw } from "lucide-react";
import { Button, IconButton, Input, Notice, Sheet, Skeleton, Switch } from "@chilli/ui";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { useMsg } from "@/lib/i18n";
import { QR_DARK, QR_LIGHT } from "@/lib/orderLink";
import { qrMatrix, qrPath } from "@/lib/qr";
import { saveBlob } from "@/lib/qrExport";
import { cardPng, sheetPdf, type CardKind, type CardSpec } from "@/lib/qrSheet";
import { qrFileName, tableQr, type QrOverview } from "@/lib/tableQr";
import { useAsk } from "@/lib/useAsk";
import { useNotify } from "@/lib/useNotify";
import { QR_MSG } from "./qr-messages";

/** A small on-screen QR (dark on white in every theme, like the ordering link card). */
function QrThumb({ url, label, size = 88, testId }: { url: string; label: string; size?: number; testId?: string }) {
  const m = useMemo(() => { try { return qrMatrix(url); } catch { return null; } }, [url]);
  if (!m) return null;
  const n = m.length + 8;
  return (
    <svg role="img" aria-label={label} data-testid={testId} data-url={url} viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" className="shrink-0 rounded-md border border-border">
      <rect width={n} height={n} fill={QR_LIGHT} />
      <path d={qrPath(m)} fill={QR_DARK} />
    </svg>
  );
}

/**
 * Manage > Tables > "QR codes": per table a menu QR and a review QR (PNG card each, open, regenerate), the restaurant-wide pair,
 * A4 PDF sheets for every table, and the switches (menu QR / reviews on, Google review link) for owners and managers.
 */
export function TableQrPanel({ open, onClose, canSettings, commonWhenNoTables = false }: { open: boolean; onClose: () => void; canSettings: boolean; commonWhenNoTables?: boolean }) {
  const tr = useMsg(QR_MSG);
  const toast = useNotify();
  const [ask, askNode] = useAsk();
  const [data, setData] = useState<QrOverview | null>(null);
  const [error, setError] = useState<{ msg: string; plan: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [google, setGoogle] = useState("");
  const [googleErr, setGoogleErr] = useState<string | null>(null);
  const [withGeneral, setWithGeneral] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await tableQr.overview();
      setData(d); setGoogle(d.google_review_url ?? "");
    } catch (e) {
      const plan = e instanceof ApiError && e.code === "feature_not_entitled";
      setError({ msg: plan ? tr("notInPlan") : e instanceof ApiError ? e.message : tr("loadFail"), plan });
    }
  }, [tr]);
  useEffect(() => { if (open) void Promise.resolve().then(load); }, [open, load]);

  // A restaurant without tables (cloud kitchen, takeaway) gets ONE common QR: the menu page carries the "Rate your visit" button.
  const common = commonWhenNoTables && !!data && data.tables.length === 0;
  const host = useMemo(() => { try { return data ? new URL(data.base_url).host : ""; } catch { return ""; } }, [data]);
  const spec = (kind: CardKind, label: string | null, url: string): CardSpec => ({ restaurant: data?.restaurant_name ?? "", label, kind, url });

  async function png(kind: CardKind, label: string | null, url: string) {
    setBusy(`png-${kind}-${label ?? "general"}`);
    try { saveBlob(await cardPng(spec(kind, label, url)), qrFileName(kind, label, "png")); }
    catch { toast.error(tr("pdfFail")); }
    finally { setBusy(null); }
  }

  async function pdf(kind: CardKind) {
    if (!data) return;
    const cards = [...(withGeneral ? [spec(kind, null, data.general[kind === "menu" ? "menu_url" : "review_url"])] : []),
      ...data.tables.map((t) => spec(kind, t.label, kind === "menu" ? t.menu_url : t.review_url))];
    setBusy(`pdf-${kind}`);
    try {
      const blob = await sheetPdf(cards, { title: `${kind === "menu" ? "Menu" : "Review"} QR codes`, onPage: (page, of) => setProgress(tr("making", { page, of })) });
      saveBlob(blob, `${kind}-qr-all-tables.pdf`);
      toast.success(tr("pdfReady", { n: cards.length }));
    } catch { toast.error(tr("pdfFail")); }
    finally { setBusy(null); setProgress(null); }
  }

  async function regenerate(tableId: string | null, label: string) {
    if (!(await ask({ title: tr("regenTitle", { label }), description: tr("regenDesc", { label }), confirmLabel: tr("regenerate"), destructive: true }))) return;
    setBusy(`regen-${tableId ?? "general"}`);
    try {
      if (tableId) await tableQr.regenerateTable(tableId); else await tableQr.regenerateGeneral();
      toast.success(tr("regenDone", { label }));
      await load();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : tr("regenFail")); }
    finally { setBusy(null); }
  }

  async function save(b: Parameters<typeof tableQr.saveSettings>[0]) {
    setGoogleErr(null);
    try {
      const s = await tableQr.saveSettings(b);
      setData((d) => (d ? { ...d, ...s } : d)); setGoogle(s.google_review_url ?? "");
      toast.success(tr("saved"));
    } catch (e) {
      const m = e instanceof ApiError ? e.message : tr("saveFail");
      if ("google_review_url" in b) setGoogleErr(m); else toast.error(m);
    }
  }

  const row = (key: string, label: string, title: string, tableId: string | null, links: { menu_url: string; review_url: string }, when?: string | null) => (
    <li key={key} className="rounded-xl border border-border bg-surface p-3" data-testid={`qr-row-${tableId ?? "general"}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-fg">{title}</p>
        {when && <p className="text-xs text-fg-muted">{tr("regenerated", { when: formatDateTime(when) })}</p>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["menu", "review"] as const).map((kind) => {
          const url = kind === "menu" ? links.menu_url : links.review_url;
          const what = tr(kind === "menu" ? "menuQr" : "reviewQr");
          return (
            <div key={kind} className="flex items-center gap-3">
              <QrThumb url={url} label={tr("qrOf", { what, label: title })} testId={`qr-${kind}-${tableId ?? "general"}`} />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-semibold text-fg">{what}</p>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="secondary" iconStart={<Download />} loading={busy === `png-${kind}-${label || "general"}`}
                    aria-label={tr("downloadPng", { what, label: title })} onClick={() => void png(kind, label || null, url)}>{tr("png")}</Button>
                  <a href={url} target="_blank" rel="noopener noreferrer" aria-label={tr("openWhat", { what, label: title })}
                    className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-primary underline-offset-2 hover:underline">
                    <ExternalLink aria-hidden className="size-4" />{tr("open")}</a>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-end">
        <IconButton label={tr("regenerateWhat", { label: title })} icon={<RefreshCw />} onClick={() => void regenerate(tableId, title)} disabled={busy !== null} />
      </div>
    </li>
  );

  return (
    <Sheet side="right" open={open} onOpenChange={(o) => { if (!o) onClose(); }} title={tr(common ? "commonSheetTitle" : "sheetTitle")} description={tr(common ? "commonSheetDesc" : "sheetDesc")}
      footer={<Button onClick={onClose}>{tr("close")}</Button>}>
      {askNode}
      {error ? (
        <Notice tone={error.plan ? "warning" : "danger"} title={error.plan ? undefined : tr("loadFail")} action={error.plan ? undefined : <Button size="sm" onClick={() => void load()}>{tr("retry")}</Button>}>{error.msg}</Notice>
      ) : !data ? (
        <div role="status" aria-label={tr("loadFail")} className="space-y-3"><Skeleton height={120} /><Skeleton height={120} /></div>
      ) : (
        <div className="space-y-5" data-testid="table-qr-panel">
          {host && <p className="text-sm text-fg-muted">{tr("opensAt", { host })}</p>}
          {canSettings && (
            <section className="space-y-3 rounded-xl border border-border bg-surface-2 p-3">
              <Switch label={tr("menuOn")} checked={data.menu_enabled} onChange={(e) => void save({ menu_enabled: e.target.checked })} />
              <Switch label={tr("reviewsOn")} checked={data.reviews_enabled} onChange={(e) => void save({ reviews_enabled: e.target.checked })} />
              <p className="text-xs text-fg-muted">{tr("offHint")}</p>
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void save({ google_review_url: google.trim() }); }}>
                <div className="min-w-0 flex-1"><Input label={tr("googleLink")} hint={tr("googleHint")} error={googleErr ?? undefined} value={google} inputMode="url" autoComplete="off"
                  placeholder="https://g.page/r/…/review" onChange={(e) => setGoogle(e.target.value)} /></div>
                <Button type="submit" variant="secondary">{tr("save")}</Button>
              </form>
            </section>
          )}
          {common ? (
            <section aria-labelledby="qr-common" data-testid="qr-common">
              <h3 id="qr-common" className="mb-1 text-sm font-semibold uppercase tracking-wide text-fg-muted">{tr("commonTitle")}</h3>
              <p className="mb-3 text-xs text-fg-muted">{tr("commonHint")}</p>
              {!data.reviews_enabled && <Notice tone="warning">{tr("commonReviewsOff")}</Notice>}
              <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface p-3">
                <QrThumb url={data.general.menu_url} label={tr("commonTitle")} size={160} testId="qr-menu-general" />
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" iconStart={<Download />} loading={busy === "png-menu-general"} disabled={busy !== null}
                      aria-label={tr("downloadPng", { what: tr("commonTitle"), label: "" })} onClick={() => void png("menu", null, data.general.menu_url)}>{tr("png")}</Button>
                    <a href={data.general.menu_url} target="_blank" rel="noopener noreferrer" aria-label={tr("openWhat", { what: tr("commonTitle"), label: "" })}
                      className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-primary underline-offset-2 hover:underline">
                      <ExternalLink aria-hidden className="size-4" />{tr("open")}</a>
                    <IconButton label={tr("regenerateWhat", { label: tr("commonTitle") })} icon={<RefreshCw />} onClick={() => void regenerate(null, tr("commonTitle"))} disabled={busy !== null} />
                  </div>
                </div>
              </div>
            </section>
          ) : (<>
          <section aria-labelledby="qr-print">
            <h3 id="qr-print" className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">{tr("printAll")}</h3>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" iconStart={<FileDown />} loading={busy === "pdf-menu"} disabled={busy !== null || (data.tables.length === 0 && !withGeneral)} onClick={() => void pdf("menu")}>{tr("menuPdf")}</Button>
              <Button variant="secondary" iconStart={<FileDown />} loading={busy === "pdf-review"} disabled={busy !== null || (data.tables.length === 0 && !withGeneral)} onClick={() => void pdf("review")}>{tr("reviewPdf")}</Button>
            </div>
            <div className="mt-2"><Switch label={tr("includeGeneral")} checked={withGeneral} onChange={(e) => setWithGeneral(e.target.checked)} /></div>
            {progress && <p role="status" className="mt-2 text-sm text-fg-muted">{progress}</p>}
          </section>
          <section aria-labelledby="qr-general">
            <h3 id="qr-general" className="mb-1 text-sm font-semibold uppercase tracking-wide text-fg-muted">{tr("general")}</h3>
            <p className="mb-2 text-xs text-fg-muted">{tr("generalHint")}</p>
            <ul>{row("general", "", tr("general"), null, data.general)}</ul>
          </section>
          <section aria-labelledby="qr-tables">
            <h3 id="qr-tables" className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">{tr("tables")}</h3>
            {data.tables.length === 0 ? <p className="text-sm text-fg-muted">{tr("noTables")}</p> : (
              <ul className="space-y-3">{data.tables.map((t) => row(t.table_id, t.label, tr("tableN", { label: t.label }), t.table_id, t, t.regenerated_at))}</ul>
            )}
          </section>
          </>)}
        </div>
      )}
    </Sheet>
  );
}
