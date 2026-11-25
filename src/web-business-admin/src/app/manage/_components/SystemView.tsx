"use client";

import { Badge, Button, Notice, PageHeader, Skeleton } from "@chilli/ui";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, ChevronDown, CircleX, Database, GitBranch, HeartPulse, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { Card, CardHeader } from "@/components/ui";
import { api, ApiError, auth } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/datetime";
import { useMsg } from "@/lib/i18n";
import type { ReconCheck, Reconciliation, SystemHealth } from "@/lib/types";
import { MANAGE_MSG } from "./shell-messages";

const human = (n: string) => n.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
type Group = "fail" | "warn" | "pass";
const groupOf = (c: ReconCheck): Group => (c.ok ? (c.severity === "warning" && c.sample.length ? "warn" : "pass") : c.severity === "warning" ? "warn" : "fail");

export function SystemView({ embedded = false }: { embedded?: boolean }) {
  const t = useMsg(MANAGE_MSG);
  const router = useRouter();
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [recon, setRecon] = useState<Reconciliation | null>(null);
  const [error, setError] = useState<string | null>(null); // "" = no server text, show the generic line
  const [running, setRunning] = useState(true);

  const run = useCallback(async () => {
    setRunning(true); setError(null);
    const [h, r] = await Promise.allSettled([api.health(), api.reconciliation()]);
    if (h.status === "fulfilled") setHealth(h.value);
    if (r.status === "fulfilled") setRecon(r.value);
    const fail = [h, r].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
    if (fail) setError(fail.reason instanceof ApiError ? fail.reason.message : "");
    setRunning(false);
  }, []);
  useEffect(() => {
    if (!auth.token) { router.replace("/login"); return; }
    void Promise.resolve().then(run);
  }, [run, router]);

  const dbDown = health && !health.database.reachable;
  const fails = recon?.checks.filter((c) => groupOf(c) === "fail") ?? [];
  const warns = recon?.checks.filter((c) => groupOf(c) === "warn") ?? [];
  const passes = recon?.checks.filter((c) => groupOf(c) === "pass") ?? [];
  const state: "ok" | "warn" | "bad" | null = !recon && !health ? null : dbDown || fails.length ? "bad" : warns.length || (health && health.migration.up_to_date === false) ? "warn" : "ok";
  const hero = {
    ok: { icon: <ShieldCheck />, cls: "bg-success-soft text-success-fg", title: t("heroOkTitle"), text: t("heroOkText", { n: recon?.checks.length ?? 0 }) },
    warn: { icon: <ShieldAlert />, cls: "bg-warning-soft text-warning-fg", title: t("heroWarnTitle"), text: t("heroWarnText") },
    bad: { icon: <CircleX />, cls: "bg-danger-soft text-danger-fg", title: dbDown ? t("heroDbTitle") : t("heroBadTitle"), text: dbDown ? t("heroDbText") : t(fails.length === 1 ? "heroBadOne" : "heroBadMany", { n: fails.length }) },
  };

  return (
    <>
      {(() => {
        const rerun = <Button variant="secondary" iconStart={<RefreshCw className={running ? "animate-spin" : ""} />} onClick={() => void run()} disabled={running}>{running ? t("checking") : t("runAgain")}</Button>;
        return embedded
          ? <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-fg-muted">{t("sysDesc")}</p>{rerun}</div>
          : <PageHeader title={t("sysHealth")} description={t("sysDesc")} actions={rerun} />;
      })()}

      {error !== null && <Notice tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => void run()}>{t("retry")}</Button>}>{error || t("runFail")}</Notice>}

      {state === null ? (
        <div role="status" aria-label={t("runningChecks")} className="space-y-4"><Skeleton className="h-32 rounded-xl" /><Skeleton className="h-64 rounded-xl" /></div>
      ) : (
        <div className={cn("space-y-5 transition-opacity", running && "opacity-60")} aria-busy={running}>
          <Card className="flex items-center gap-4 sm:gap-5">
            <span className={cn("grid size-16 shrink-0 place-items-center rounded-2xl [&_svg]:size-8 sm:size-20 sm:[&_svg]:size-10", hero[state].cls)}>{hero[state].icon}</span>
            <div className="min-w-0" aria-live="polite">
              <h2 className="font-display text-xl font-bold text-fg sm:text-2xl">{hero[state].title}</h2>
              <p className="mt-0.5 text-sm text-fg-muted">{hero[state].text}</p>
              {recon && <p className="mt-1 text-xs text-fg-subtle">{t("lastRun", { when: formatDateTime(recon.checked_at) })}</p>}
            </div>
          </Card>

          {health && (
            // Version numbers and database revision are for a technician, not the owner: folded away.
            <details className="group rounded-2xl border border-border bg-surface px-4 py-2">
            <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold text-fg-muted marker:content-none"><ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />Technical details</summary>
            <div className="grid gap-3 pb-2 pt-1 sm:grid-cols-3">
              <Card className="flex items-center gap-3"><Database className="size-5 text-fg-subtle" aria-hidden /><div><p className="text-xs text-fg-subtle">{t("database")}</p><p className="font-semibold">{health.database.reachable ? t("reachable") : t("notReachable")}</p></div></Card>
              <Card className="flex items-center gap-3"><GitBranch className="size-5 text-fg-subtle" aria-hidden />
                <div><p className="text-xs text-fg-subtle">{t("dbVersion")}</p><p className="font-semibold">{health.migration.up_to_date === null ? t("unknown") : health.migration.up_to_date ? t("upToDate") : t("updateNeeded")}</p>
                  {health.migration.revision && <p className="font-mono text-xs text-fg-subtle">{health.migration.revision.slice(0, 12)}</p>}</div></Card>
              <Card className="flex items-center gap-3"><HeartPulse className="size-5 text-fg-subtle" aria-hidden /><div><p className="text-xs text-fg-subtle">{t("app")}</p><p className="font-semibold">v{health.version} · {health.env}</p></div></Card>
            </div>
            </details>
          )}

          {recon && (
            <Card>
              <CardHeader title={t("checksTitle")} description={t("checksCounts", { fail: fails.length, warn: warns.length, pass: passes.length })} />
              <div className="space-y-5">
                {fails.length > 0 && <CheckGroup title={t("needsFixing")} checks={fails} defaultOpen />}
                {warns.length > 0 && <CheckGroup title={t("worthLook")} checks={warns} defaultOpen />}
                <CheckGroup title={t("passed")} checks={passes} />
              </div>
            </Card>
          )}

          <Notice tone="info" title={t("reconTitle")}>
            {t("reconBody")}
          </Notice>
        </div>
      )}
    </>
  );
}

function CheckGroup({ title, checks, defaultOpen }: { title: string; checks: ReconCheck[]; defaultOpen?: boolean }) {
  if (!checks.length) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h3>
      <ul className="divide-y divide-border rounded-xl border border-border">{checks.map((c) => <CheckRow key={c.name} c={c} defaultOpen={defaultOpen} />)}</ul>
    </section>
  );
}

function CheckRow({ c, defaultOpen }: { c: ReconCheck; defaultOpen?: boolean }) {
  const t = useMsg(MANAGE_MSG);
  const g = groupOf(c);
  const [open, setOpen] = useState(!!defaultOpen && c.sample.length > 0);
  const can = c.sample.length > 0;
  const icon = g === "pass" ? <CheckCircle2 className="size-5 text-success" aria-hidden /> : g === "warn" ? <AlertTriangle className="size-5 text-warning" aria-hidden /> : <CircleX className="size-5 text-danger" aria-hidden />;
  return (
    <li>
      <button type="button" disabled={!can} aria-expanded={can ? open : undefined} onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors enabled:hover:bg-surface-2/60 disabled:cursor-default">
        <span className="mt-0.5">{icon}</span>
        <span className="min-w-0 flex-1"><span className="block font-medium text-fg">{human(c.name)}</span><span className="block text-sm text-fg-muted">{c.detail}</span></span>
        <Badge tone={g === "pass" ? "success" : g === "warn" ? "warning" : "danger"}>{g === "pass" ? t("passed") : c.severity === "warning" ? t("warning") : t("error")}</Badge>
        {can && <ChevronDown aria-hidden className={cn("mt-0.5 size-4 shrink-0 text-fg-subtle transition-transform", open && "rotate-180")} />}
      </button>
      {open && can && (
        <div className="border-t border-border bg-surface-2/50 px-4 py-3">
          <p className="mb-2 text-xs text-fg-subtle">{t("examples", { n: c.sample.length })}</p>
          <pre className="max-h-64 overflow-auto rounded-lg bg-surface p-3 font-mono text-xs leading-relaxed scrollbar-thin">{JSON.stringify(c.sample, null, 2)}</pre>
        </div>
      )}
    </li>
  );
}
