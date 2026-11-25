"use client";

import { useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Copy, Download, KeyRound, Link2, RefreshCw, Share2 } from "lucide-react";
import { Badge, Button, Input, Notice, Switch } from "@chilli/ui";
import { Card, CardHeader, toast } from "@/components/ui";
import { auth } from "@/lib/api";
import { delivery, orderLinkOf, type DeliverySettings, type PublicLinkChange } from "@/lib/deliveryApi";
import { BRAND_COLOR_ERROR, QR_DARK, QR_LIGHT, SHARE_TEXT, brandColorCheck, canNativeShare, linkFailure, linkView, qrFileName, whatsappShareUrl, type LinkFailure } from "@/lib/orderLink";
import { qrPngBlob, qrSvgBlob, saveBlob } from "@/lib/qrExport";
import { qrMatrix, qrPath } from "@/lib/qr";
import { useAsk } from "@/lib/useAsk";
import { useCan } from "@/lib/useRole";

export async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); } catch { toast.error(`Could not copy. Select the ${what.toLowerCase()} and copy it.`); }
}

/** QR code of the ordering link (dark on white in both themes, 4-module quiet zone: readable on a printed table card). Drawn here from the link, no network. */
export function LinkQr({ url, size = 176 }: { url: string; size?: number }) {
  const m = useMemo(() => { try { return qrMatrix(url); } catch { return null; } }, [url]);
  if (!m) return null;
  const n = m.length + 8;
  return (
    <svg role="img" aria-label="QR code of the ordering link" data-testid="order-qr" viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" className="shrink-0 rounded-lg border border-border">
      <rect width={n} height={n} fill={QR_LIGHT} />
      <path d={qrPath(m)} fill={QR_DARK} />
    </svg>
  );
}

const LINK_BTN = "inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-primary-soft-fg hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-ring";

/**
 * "Your ordering link" (Manage > Delivery): the owner's switch for the public ordering page, the link with Copy and Share, the QR for print,
 * "Make a new link", an optional brand colour, and (Advanced) the write-only service token.
 * pos-service: GET/PUT /delivery/settings (docs/DELIVERY_API.md, "Public ordering link"); every call below is that one PUT.
 * `onSettings` receives the saved settings of every answer, including the ones a 502 carries (the rest of the request was saved).
 */
export function OrderLinkCard({ settings: s, onSettings, onReload }: { settings: DeliverySettings; onSettings: (s: DeliverySettings) => void; onReload: () => void }) {
  const { can, biz } = useCan();
  const [ask, askNode] = useAsk();
  const [busy, setBusy] = useState<string | null>(null);
  const [issue, setIssue] = useState<LinkFailure | null>(null);
  const [color, setColor] = useState("");
  const [savedColor, setSavedColor] = useState("");
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [adv, setAdv] = useState(false);
  const last = useRef<(() => Promise<boolean>) | null>(null);

  const view = linkView(s);
  const link = view === "legacy" ? orderLinkOf(s, auth.restaurantId) : view === "on" ? (s.public_order_url ?? null) : null;
  const check = brandColorCheck(color);
  const native = typeof navigator !== "undefined" && canNativeShare(navigator);
  const tokenKnown = typeof s.public_order_token_set === "boolean";

  /** One PUT for the link. Failures are shown in the card; the saved settings of a 502 replace the screen's. */
  function run(what: string, body: PublicLinkChange, done: string): Promise<boolean> {
    const go = async () => {
      setBusy(what); setIssue(null);
      try {
        onSettings(await delivery.saveSettings(body));
        toast.success(done);
        return true;
      } catch (e) {
        const f = linkFailure(e);
        if (f.settings) onSettings(f.settings);
        setIssue(f);
        if (f.kind === "not_connected") setAdv(true);
        if (f.kind === "off") onReload();
        return false;
      } finally { setBusy(null); }
    };
    last.current = go;
    return go();
  }

  async function newLink() {
    const yes = await ask({ title: "Make a new link?", confirmLabel: "Make a new link", destructive: true,
      description: "Your old link and QR code stop working right away. Anything printed or posted with them will show \"not found\", so share the new one." });
    if (yes) await run("rotate", { rotate_public_order_link: true }, "New link is ready");
  }

  async function shareNative(url: string) {
    try { await navigator.share({ title: "Order online", text: SHARE_TEXT, url }); }
    catch (e) { if (!(e instanceof DOMException && e.name === "AbortError")) toast.error("Could not open sharing. Copy the link instead."); }
  }

  async function download(url: string, kind: "svg" | "png") {
    try { saveBlob(kind === "svg" ? qrSvgBlob(url) : await qrPngBlob(url), qrFileName(url, kind)); }
    catch { toast.error("Could not make the QR file. Try again."); }
  }

  const retry = (label = "Try again") => <div className="mt-2"><Button size="sm" className="min-h-11" iconStart={<RefreshCw />} loading={busy !== null} onClick={() => void last.current?.()}>{label}</Button></div>;

  if (!can("delivery.manage")) return null;

  const hint = view === "on" ? "On: anyone with the link can place a delivery order." : view === "on_no_url" ? "On, but the link is not available right now." : "Off: the link and QR code show \"not found\".";

  return (
    <Card data-testid="order-link-card">
      <CardHeader title="Your ordering link" description={`One link for Instagram, WhatsApp status, a poster or ${biz.tables ? "a table card" : "the packaging"}. Customers order delivery from it.`} />

      {view !== "legacy" && (
        <Switch label="Online ordering link" hint={hint} checked={s.public_order_enabled === true} disabled={busy !== null} data-testid="order-link-enabled"
          onChange={(e) => void run("toggle", { public_order_enabled: e.target.checked }, e.target.checked ? "Ordering link is on" : "Ordering link is off")} />
      )}

      {issue && issue.kind === "not_connected" && (
        <Notice tone="info" className="mt-3" title="Not connected to the online ordering service">
          <span data-testid="order-link-not-connected">The online ordering service hosts your public page. Support connects it for your restaurant, and then this switch works. If support gave you a service token, add it under Advanced. Your other delivery settings are saved.</span>
          {retry()}
        </Notice>
      )}
      {issue && issue.kind === "unavailable" && (
        <Notice tone="warning" className="mt-3" title="The link was not changed"><span data-testid="order-link-error">{issue.message}</span>{retry("Retry")}</Notice>
      )}
      {issue && (issue.kind === "offline" || issue.kind === "other") && (
        <Notice tone="danger" className="mt-3"><span data-testid="order-link-error">{issue.message}</span>{retry("Retry")}</Notice>
      )}
      {issue && issue.kind === "off" && (
        <Notice tone="info" className="mt-3"><span data-testid="order-link-off-notice">{issue.message}</span></Notice>
      )}

      {view === "off" && !issue && (
        <p data-testid="order-link-off" className="mt-3 rounded-xl bg-surface-2 px-4 py-3 text-sm text-fg-muted">Your link is off. Turn it on to get your link and QR code.</p>
      )}
      {view === "on_no_url" && (
        <Notice tone="info" className="mt-3" title="Your link is not available right now">
          <span data-testid="order-link-no-url">The switch is on, but the online ordering service did not give us the link. Check again in a minute.</span>
          <div className="mt-2"><Button size="sm" className="min-h-11" iconStart={<RefreshCw />} onClick={onReload}>Check again</Button></div>
        </Notice>
      )}
      {view === "legacy" && !link && (
        <Notice tone="info">Your ordering link appears here once the delivery service is connected for this restaurant. Ask support to connect it.</Notice>
      )}

      {link && (
        <div className="mt-4 space-y-5">
          <div className="flex flex-col gap-4 md:max-xl:flex-row md:max-xl:items-start">
            <div className="flex flex-col items-start gap-2">
              <LinkQr url={link} />
              {view !== "legacy" && (
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" className="min-h-11" iconStart={<Download />} onClick={() => void download(link, "png")}>PNG</Button>
                  <Button size="sm" variant="ghost" className="min-h-11" iconStart={<Download />} onClick={() => void download(link, "svg")}>SVG</Button>
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <p data-testid="order-link" className="break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm text-fg">{link}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" iconStart={<Copy />} onClick={() => void copy(link, "Ordering link")}>Copy link</Button>
                {view !== "legacy" && (native
                  ? <Button iconStart={<Share2 />} onClick={() => void shareNative(link)}>Share</Button>
                  : <a href={whatsappShareUrl(link)} target="_blank" rel="noopener noreferrer" className="ch-btn ch-btn--secondary ch-btn--md whitespace-nowrap"><Share2 aria-hidden className="size-4" />Share on WhatsApp</a>)}
                <a href={link} target="_blank" rel="noopener noreferrer" className={LINK_BTN}><Link2 aria-hidden className="size-4" />Open</a>
              </div>
              <p className="text-xs text-fg-muted">The QR code is the same link. Download it for a poster or {biz.tables ? "a table card" : "the packaging"}.</p>
            </div>
          </div>

          {view === "on" && (
            <>
              <section aria-labelledby="order-link-colour-h" className="space-y-3 border-t border-border pt-4">
                <h4 id="order-link-colour-h" className="text-sm font-semibold text-fg">Brand colour (optional)</h4>
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (check.state === "ok") void run("colour", { public_order_brand_color: check.hex }, "Colour saved").then((ok) => { if (ok) setSavedColor(check.hex!); }); }}>
                  <div className="min-w-0">
                    <Input label="Colour code" inputMode="text" autoComplete="off" spellCheck={false} placeholder="#0B6E4F" maxLength={7} value={color} data-testid="order-link-colour"
                      onChange={(e) => setColor(e.target.value)}
                      error={check.state === "invalid" ? BRAND_COLOR_ERROR : undefined}
                      hint="Colours your ordering page. Leave empty for the default look. Saved colours are not shown here again." />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" loading={busy === "colour"} disabled={busy !== null || check.state !== "ok" || check.hex === savedColor}>Save colour</Button>
                    {(savedColor || color) && (
                      <Button variant="ghost" disabled={busy !== null} onClick={() => void run("colour", { public_order_brand_color: "" }, "Back to the default colour").then((ok) => { if (ok) { setColor(""); setSavedColor(""); } })}>Use default colour</Button>
                    )}
                  </div>
                </form>
                {check.state === "ok" && (
                  <div data-testid="order-link-colour-preview" className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
                    <span aria-hidden className="inline-flex min-h-11 items-center rounded-xl px-5 text-sm font-semibold" style={{ backgroundColor: check.hex, color: check.label }}>Order now</span>
                    <span className="text-sm text-fg-muted">Preview. Label contrast {check.labelRatio}:1.</span>
                  </div>
                )}
                {check.note && !check.warning && <Notice tone="info"><span data-testid="order-link-colour-note">{check.note}</span></Notice>}
                {check.warning && <Notice tone="warning"><span data-testid="order-link-colour-warning">{check.warning}</span></Notice>}
              </section>

              <section className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Button iconStart={<RefreshCw />} loading={busy === "rotate"} disabled={busy !== null} onClick={() => void newLink()}>Make a new link</Button>
                <p className="min-w-0 flex-1 basis-56 text-sm text-fg-muted">Use this if the link got to the wrong people. The old link and QR stop working.</p>
              </section>
            </>
          )}
        </div>
      )}

      <p data-testid="order-link-pickup-hint" className="mt-4 text-sm text-fg-muted">Delivery only for now: customers cannot choose pickup from this link yet.</p>

      {view !== "legacy" && tokenKnown && (
        <details className="group mt-4 border-t border-border pt-2" open={adv} onToggle={(e) => setAdv((e.currentTarget as HTMLDetailsElement).open)} data-testid="order-link-advanced">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm font-semibold text-fg [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" />Advanced</summary>
          <div className="space-y-3 pb-1 pt-2">
            {s.public_order_token_set && !replacing ? (
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone="success"><Check aria-hidden className="size-3.5" />Service token saved</Badge>
                <Button size="sm" variant="ghost" className="min-h-11" iconStart={<KeyRound />} onClick={() => setReplacing(true)}>Replace token</Button>
              </div>
            ) : (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const t = token.trim(); if (t) void run("token", { public_order_service_token: t }, "Service token saved").then((ok) => { if (ok) { setToken(""); setReplacing(false); } }); }}>
                <div className="min-w-0">
                  <Input label={replacing ? "New service token" : "Service token"} type="password" autoComplete="off" spellCheck={false} value={token} data-testid="order-link-token"
                    onChange={(e) => setToken(e.target.value)}
                    hint="From support. It is saved encrypted and never shown again." />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={busy === "token"} disabled={busy !== null || !token.trim()}>Save token</Button>
                  {replacing && <Button variant="ghost" disabled={busy !== null} onClick={() => { setReplacing(false); setToken(""); }}>Cancel</Button>}
                </div>
              </form>
            )}
          </div>
        </details>
      )}
      {askNode}
    </Card>
  );
}
