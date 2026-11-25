"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Boxes, CheckCircle2, ChefHat, Printer, ReceiptText, ShieldAlert } from "lucide-react";
import { Card, CardHeader, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { addDays, todayIn } from "@/lib/datetime";
import { useMsg } from "@/lib/i18n";
import type { ManageSummary } from "@/lib/types";
import { MANAGE_MSG } from "./shell-messages";

/** Text and button label are message keys, translated when drawn (so a language switch needs no refetch). */
interface Item { key: string; count: number; text: string; params: Record<string, number>; cta: string; href: string; icon: ReactNode }
const oneMany = (n: number, base: string) => `${base}${n === 1 ? "One" : "Many"}`;

/**
 * "Needs attention": the few things worth a look today, each with a count and a button to the right place. Every source loads on its
 * own (a failing request just drops its line), over the last 7 days for reports and the last day for print jobs.
 */
export function NeedsAttentionCard({ summary, timezone }: { summary: ManageSummary | null; timezone: string | undefined }) {
  const t = useMsg(MANAGE_MSG);
  const [found, setFound] = useState<Record<string, Item> | null>(null);
  const ready = !!summary, hasStock = (summary?.inventory_items ?? 0) > 0; // not the whole summary object: it is replaced on every refresh

  useEffect(() => {
    if (!ready || !timezone) return;
    let off = false;
    const to = todayIn(timezone), from = addDays(to, -6);
    const got: Record<string, Item> = {};
    const add = (i: Item) => { if (i.count > 0) got[i.key] = i; };
    void Promise.allSettled([
      api.leakage(from, to).then((d) => {
        add({ key: "unpaid", count: d.unpaid_bills.count, text: oneMany(d.unpaid_bills.count, "naUnpaid"), params: { n: d.unpaid_bills.count }, cta: "ctaUnpaid", href: "/reports?tab=leakage", icon: <ReceiptText /> });
        const high = d.flags.filter((f) => f.severity === "high").length, med = d.flags.filter((f) => f.severity === "medium").length;
        add({ key: "leakage", count: high + med, text: high && med ? "naLeakBoth" : high ? oneMany(high, "naLeakHigh") : oneMany(med, "naLeakMed"), params: high && med ? { high, med } : { n: high || med }, cta: "ctaLeakage", href: "/reports?tab=leakage", icon: <ShieldAlert /> });
      }),
      Promise.all([api.printJobs({ limit: 50 }), api.printers()]).then(([jobs, printers]) => {
        const ids = new Set(printers.map((p) => p.id)), since = Date.now() - 86_400_000;
        const failed = jobs.filter((j) => j.status === "failed" && ids.has(j.printer_id) && new Date(j.created_at).getTime() >= since).length;
        add({ key: "print", count: failed, text: oneMany(failed, "naPrint"), params: { n: failed }, cta: "ctaPrinters", href: "/manage?tab=printers", icon: <Printer /> });
      }),
      hasStock ? api.foodCost(from, to).then((d) => {
        const n = d.dishes_without_recipe.length + (d.dishes_without_recipe_more ?? 0);
        add({ key: "recipes", count: n, text: oneMany(n, "naRecipe"), params: { n }, cta: "ctaAddRecipes", href: "/manage?tab=recipes", icon: <ChefHat /> });
      }) : Promise.resolve(),
    ]).then(() => { if (!off) setFound(got); });
    return () => { off = true; };
  }, [ready, hasStock, timezone]);

  const items: Item[] = [];
  if (summary && summary.low_stock > 0) items.push({ key: "stock", count: summary.low_stock, text: oneMany(summary.low_stock, "attnStock"), params: { n: summary.low_stock }, cta: "ctaSeeStock", href: "/manage?tab=inventory", icon: <Boxes /> });
  for (const k of ["unpaid", "leakage", "print", "recipes"]) if (found?.[k]) items.push(found[k]);
  const shown = items.slice(0, 5);
  const loading = !summary || !found;

  return (
    <Card data-testid="needs-attention">
      <CardHeader title={t("naTitle")} description={loading ? undefined : shown.length ? t("naDesc") : undefined} />
      {loading ? <div className="space-y-2"><Skeleton className="h-14 rounded-xl" /><Skeleton className="h-14 rounded-xl" /></div>
        : shown.length === 0 ? (
          <p className="flex items-center gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm font-medium text-success-fg"><CheckCircle2 aria-hidden className="size-5 shrink-0" />{t("naNone")}</p>
        ) : (
          <ul className="space-y-2">
            {shown.map((a) => (
              <li key={a.key}>
                <Link href={a.href} replace={a.href.startsWith("/manage")} scroll={false} className="flex items-center gap-3 rounded-xl bg-warning-soft/60 px-3 py-3 text-sm transition-colors hover:bg-warning-soft focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning-fg [&_svg]:size-[1.1rem]">{a.icon}</span>
                  <span className="min-w-0 flex-1 text-fg">{t(a.text, a.params)}</span>
                  <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-warning-fg">{t(a.cta)}<ArrowRight aria-hidden className="size-4" /></span>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}
