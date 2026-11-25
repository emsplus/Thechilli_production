"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Monitor, Plus, Trash2 } from "lucide-react";
import { Badge, Button, IconButton, Notice } from "@chilli/ui";
import { Card, CardHeader, EmptyState, Skeleton, toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/datetime";
import { useMsg } from "@/lib/i18n";
import type { HubPairing, PrintHub } from "@/lib/types";
import { HUB_MSG } from "./devices-messages";
import { useManage } from "./manage-context";

/** Pairing codes are 10 upper-case letters and digits (older servers: 6 digits). Shown in two groups; the DOM text stays the raw code. */
const halves = (code: string): [string, string] => { const n = Math.ceil(code.length / 2); return [code.slice(0, n), code.slice(n)]; };

const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** The print hub(s): the small program on the counter PC that carries jobs from this site to the printers. */
export function PrintHubCard({ hubs, loading, error, reload, onPairingChange }: {
  hubs: PrintHub[] | null; loading: boolean; error: string | null; reload: () => Promise<void>;
  /** Tells the tab a pairing code is on screen, so it can refresh the hub list quickly. */
  onPairingChange: (showing: boolean) => void;
}) {
  const t = useMsg(HUB_MSG);
  const confirm = useConfirm();
  const { me } = useManage();
  const canManage = me.permissions ? me.permissions.includes("printing.manage") : true;
  const [pairing, setPairing] = useState<HubPairing | null>(null);
  const [startCount, setStartCount] = useState(0);
  const [creating, setCreating] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  useEffect(() => { onPairingChange(pairing !== null); }, [pairing, onPairingChange]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000); // countdown and "last seen"
    return () => clearInterval(t);
  }, []);
  // The hub used the code: it shows up in the list, so the code is no longer needed.
  useEffect(() => {
    if (pairing && hubs && hubs.length > startCount) { void Promise.resolve().then(() => { setPairing(null); toast.success(t("connected")); }); }
  }, [hubs, pairing, startCount, t]);

  const left = pairing ? new Date(pairing.expires_at).getTime() - now : 0;
  const expired = pairing !== null && left <= 0;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const command = pairing ? `print-hub pair ${origin} ${pairing.code}` : "";

  async function connect() {
    setCreating(true);
    try {
      const p = await api.newHubPairing();
      setStartCount(hubs?.length ?? 0); setNow(Date.now()); setCopied(false); setPairing(p);
    } catch (e) { toast.error(e instanceof ApiError ? e.message : t("pairFail")); }
    finally { setCreating(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); toast.success(t("cmdCopied")); }
    catch { window.prompt(t("copyCmdPrompt"), command); }
  }
  async function copyCode() {
    if (!pairing) return;
    try { await navigator.clipboard.writeText(pairing.code); setCodeCopied(true); toast.success(t("codeCopied")); setTimeout(() => setCodeCopied(false), 2000); }
    catch { window.prompt(t("copyCodePrompt"), pairing.code); }
  }
  async function remove(h: PrintHub) {
    if (!(await confirm({ title: t("removeTitle", { name: h.name }), description: t("removeDesc"), confirmLabel: t("removeConfirm"), tone: "danger" }))) return;
    try { await api.revokeHub(h.id); toast.success(t("removed", { name: h.name })); await reload(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : t("removeFail")); }
  }

  return (
    <Card data-testid="print-hub-card">
      <CardHeader title={t("title")} description={t("desc")}
        action={canManage ? <Button variant="secondary" iconStart={<Plus />} loading={creating} onClick={() => void connect()}>{t("connect")}</Button> : undefined} />
      {error && <Notice tone="danger" className="mb-3">{error}</Notice>}

      {pairing && (
        <div data-testid="pairing" className="mb-4 rounded-2xl border border-primary/30 bg-primary-soft/50 p-4">
          {expired ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-fg">{t("expired")}</p>
              <Button size="sm" variant="secondary" loading={creating} onClick={() => void connect()}>{t("newCode")}</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
                <p data-testid="pairing-code" aria-label={t("pairingAria", { code: pairing.code.split("").join(" ") })} className="tnum font-mono text-3xl font-extrabold tracking-[0.14em] text-primary-soft-fg sm:text-5xl">
                  <span aria-hidden className="mr-[0.6em] inline-block">{halves(pairing.code)[0]}</span><span aria-hidden className="inline-block">{halves(pairing.code)[1]}</span>
                </p>
                <IconButton variant="secondary" label={t("copyCode")} icon={codeCopied ? <Check /> : <Copy />} onClick={() => void copyCode()} />
                <p data-testid="pairing-countdown" className="tnum pb-1.5 text-sm text-fg-muted">{t("expiresIn", { time: mmss(left) })}</p>
              </div>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-muted">
                <li>{t("step1")}</li>
                <li>{t("step2")}</li>
              </ol>
              <div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 ring-1 ring-border">
                <code data-testid="pairing-command" className="min-w-0 flex-1 break-all font-mono text-sm text-fg">{command}</code>
                <IconButton variant="secondary" label={t("copyCommand")} icon={copied ? <Check /> : <Copy />} onClick={() => void copy()} />
              </div>
              <p className="text-xs text-fg-muted">{t("codeNote")}</p>
            </div>
          )}
        </div>
      )}

      {loading && !hubs ? <Skeleton className="h-20 rounded-xl" />
        : hubs && hubs.length > 0 ? (
          <ul className="divide-y divide-border">
            {hubs.map((h) => (
              <li key={h.id} data-testid="hub-row" className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Monitor aria-hidden className="size-5 text-fg-subtle" />
                  <span className="min-w-0 flex-1 truncate font-semibold text-fg">{h.name}{h.os ? <span className="font-normal text-fg-muted"> ({h.os}{h.version ? ` ${h.version}` : ""})</span> : null}</span>
                  <span data-testid="hub-status"><Badge tone={h.online ? "success" : "danger"}>{h.online ? t("online") : t("offline")}</Badge></span>
                  {canManage && <IconButton variant="secondary" label={t("removeAria", { name: h.name })} icon={<Trash2 />} onClick={() => void remove(h)} />}
                </div>
                <p className="mt-1 pl-8 text-sm text-fg-muted">{h.last_seen_at ? t(!h.online ? "lastSeenOff" : "lastSeen", { when: relativeTime(h.last_seen_at, now) }) : t("neverSeen")}</p>
                <p className="mt-1 pl-8 text-sm text-fg-muted">
                  {h.system_printers.length > 0 ? <>{t("queuesOnPc")} {h.system_printers.map((q) => { const st = h.printer_status?.[q]; return <Badge key={q} tone={st === "online" ? "success" : st === "offline" ? "danger" : "neutral"} className="ml-1">{q}{st ? ` (${st === "online" || st === "offline" ? t(`q_${st}`) : st})` : ""}</Badge>; })}</> : t("noQueues")}
                </p>
              </li>
            ))}
          </ul>
        ) : !pairing && (
          <EmptyState icon={<Monitor />} title={t("emptyTitle")}
            hint={t("emptyHint")}
            action={canManage ? <Button variant="primary" iconStart={<Plus />} loading={creating} onClick={() => void connect()}>{t("connect")}</Button> : undefined} />
        )}
    </Card>
  );
}
