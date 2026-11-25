"use client";

import { formatDate } from "@/lib/datetime";
import { Badge, Notice } from "@chilli/ui";
import { Card, CardHeader, Money } from "@/components/ui";
import { DataGrid, KpiTile } from "./parts";
import { api } from "@/lib/api";
import { formatMoney, formatCompactMoney } from "@/lib/money";
import type { DishClass } from "@/lib/types";
import { InsightShell, ReportNotices } from "./ReportNotices";
import { pct } from "./LeakageTab";
import { useInsight } from "./useInsight";
import { useTaxWord } from "@/lib/taxWords";
import Link from "next/link";
import { ADD_COSTS_TEXT, costKnown, RECIPES_HREF } from "@/lib/profitView";

const AddCosts = () => <Link href={RECIPES_HREF} className="font-semibold text-primary underline underline-offset-2">{ADD_COSTS_TEXT}</Link>;

type Range = { from: string; to: string; tick: number };
const Empty = ({ children }: { children: string }) => <p className="py-6 text-center text-sm text-fg-muted">{children}</p>;
const day = (iso: string | null) => formatDate(iso);

/** Sales per staff member with the discounts, cancelled orders and refunds each of them handled. */
export function StaffTab({ from, to, tick }: Range) {
  const { data: d, error, loading, stale } = useInsight(api.staffSales, from, to, tick);
  const cur = d?.currency ?? "";
  return (
    <InsightShell loading={loading} error={error} stale={stale}>
      {d && (
        <div data-testid="staff-report">
          <ReportNotices meta={d} extra={d.note ? [d.note] : []} />
          {d.staff.length === 0 ? <Empty>No staff activity in this range.</Empty> : (
            <DataGrid caption="Sales by staff" getKey={(x) => x.user_id} rows={d.staff}
              total={{ user_id: "", name: "Total", role: "", bills: d.totals.bills, gross: d.totals.gross, average_bill: null, items: null, discounts: { count: 0, value: d.totals.discount_value }, voids: null, refunds: null } as unknown as (typeof d.staff)[number]}
              cols={[
                { header: "Staff", render: (x) => <>{x.name}{x.role && <span className="ml-2 text-xs capitalize text-fg-subtle">{x.role}</span>}</> },
                { header: "Bills", end: true, render: (x) => x.bills },
                { header: "Gross sales", end: true, render: (x) => formatMoney(x.gross) },
                { header: "Average bill", end: true, render: (x) => (x.average_bill ? formatMoney(x.average_bill) : x.user_id ? "-" : "") },
                { header: "Items", end: true, render: (x) => x.items ?? "" },
                { header: "Discounts", end: true, render: (x) => (x.user_id ? `${x.discounts.count} · ${formatMoney(x.discounts.value)}` : formatMoney(x.discounts.value)) },
                { header: "Cancelled", end: true, render: (x) => (x.voids ? `${x.voids.count} · ${formatMoney(x.voids.value)}` : "") },
                { header: "Refunds", end: true, render: (x) => (x.refunds ? `${x.refunds.count} · ${formatMoney(x.refunds.value)}` : "") },
              ]} />)}
          <p className="mt-2 text-xs text-fg-subtle">Amounts in {cur || "the restaurant currency"}. Counts and values for discounts, cancelled orders and refunds are shown as count · value.</p>
        </div>)}
    </InsightShell>
  );
}

const CLASS: Record<DishClass, { tone: "success" | "warning" | "info" | "danger"; label: string }> = {
  star: { tone: "success", label: "Star" }, plowhorse: { tone: "warning", label: "Plowhorse" }, puzzle: { tone: "info", label: "Puzzle" }, dog: { tone: "danger", label: "Dog" },
};

/** What each dish costs to make and earns; dishes without a recipe are listed apart because their cost is unknown. */
export function FoodCostTab({ from, to, tick }: Range) {
  const W = useTaxWord();
  const { data: d, error, loading, stale } = useInsight(api.foodCost, from, to, tick);
  const cur = d?.currency ?? "";
  return (
    <InsightShell loading={loading} error={error} stale={stale}>
      {d && (
        <div className="space-y-4" data-testid="food-cost-report">
          <ReportNotices meta={d} />
          {d.dishes.length === 0 && d.dishes_without_recipe.length === 0 ? <Empty>No dishes sold in this range.</Empty> : (
            <>
              <div className="grid grid-cols-2 gap-3 max-sm:[&_.font-display]:text-2xl lg:grid-cols-4 sm:gap-4">
                <KpiTile label="Food cost" value={d.totals.food_cost_percent ? `${Number(d.totals.food_cost_percent)}%` : "-"} hint={`Ingredient cost / revenue (excl. ${W})`} />
                <KpiTile label="Ingredient cost" value={formatCompactMoney(d.totals.ingredient_cost, cur)} hint={`${d.totals.portions} portions`} />
                {costKnown({ ingredient_cost: d.totals.ingredient_cost, revenue_excl_vat: d.totals.revenue_excl_vat })
                  ? <KpiTile label="Gross profit" value={formatCompactMoney(d.totals.gross_margin, cur)} />
                  : <KpiTile label="Gross profit" value="-" hint={<AddCosts />} />}
                <KpiTile label="Dishes costed" value={String(d.totals.dishes_costed)} hint={d.totals.dishes_without_recipe > 0 ? `${d.totals.dishes_without_recipe} without a recipe` : undefined} />
              </div>
              {d.dishes.length > 0 && (
                <DataGrid caption="Food cost by dish" getKey={(x) => x.item} rows={d.dishes}
                  cols={[
                    { header: "Dish", render: (x) => x.item },
                    { header: "Sold", end: true, render: (x) => x.quantity },
                    { header: `Revenue (excl. ${W})`, end: true, render: (x) => formatMoney(x.revenue_excl_vat) },
                    { header: "Cost / portion", end: true, render: (x) => (x.cost_known && x.cost_per_portion ? formatMoney(x.cost_per_portion) : <span className="text-fg-subtle">cost unknown</span>) },
                    { header: "Food cost %", end: true, render: (x) => pct(x.food_cost_percent) },
                    { header: "Margin / portion", end: true, render: (x) => (x.margin_per_portion ? formatMoney(x.margin_per_portion) : "-") },
                    { header: "Class", render: (x) => (x.classification ? <Badge tone={CLASS[x.classification].tone}>{CLASS[x.classification].label}</Badge> : <span className="text-fg-subtle">-</span>) },
                  ]} />)}
              {(d.dishes_more ?? 0) > 0 && <p className="text-xs text-fg-subtle">+{d.dishes_more} more dishes not shown. The PDF lists the main ones too.</p>}
              {d.classification_note && <p className="text-xs text-fg-subtle">{d.classification_note}</p>}
              {d.cost_method && <p className="text-xs text-fg-subtle">Cost method: {d.cost_method}.</p>}
              {d.dishes_without_recipe.length > 0 && (
                <Card data-testid="no-recipe-list">
                  <CardHeader title="No recipe: cost unknown" description={`Sold ${formatMoney(d.totals.revenue_without_recipe)} (excl. ${W}) with no cost counted, so food cost above looks lower than it is.`} />
                  <DataGrid caption="Dishes without a recipe" getKey={(x) => x.item} rows={d.dishes_without_recipe}
                    cols={[
                      { header: "Dish", render: (x) => x.item },
                      { header: "Sold", end: true, render: (x) => x.quantity },
                      { header: `Revenue (excl. ${W})`, end: true, render: (x) => formatMoney(x.revenue_excl_vat) },
                      { header: "Note", render: (x) => (x.has_recipe ? `Ingredients without a cost: ${(x.ingredients_without_cost ?? []).join(", ") || "-"}` : "No recipe") },
                    ]} />
                  {(d.dishes_without_recipe_more ?? 0) > 0 && <p className="mt-2 text-xs text-fg-subtle">+{d.dishes_without_recipe_more} more.</p>}
                </Card>)}
            </>)}
        </div>)}
    </InsightShell>
  );
}

/** Profit and loss as a waterfall: net sales, less ingredient cost = gross profit, less expenses = operating profit. */
export function PnlTab({ from, to, tick }: Range) {
  const W = useTaxWord();
  const { data: d, error, loading, stale } = useInsight(api.profitAndLoss, from, to, tick);
  const cur = d?.currency ?? "";
  const row = (label: string, value: string, o: { strong?: boolean; sub?: string; minus?: boolean } = {}) => (
    <div className={`flex items-baseline justify-between gap-3 py-2.5 ${o.strong ? "border-t border-border font-semibold text-fg" : "text-fg-muted"}`}>
      <dt>{o.minus ? "Less: " : ""}{label}{o.sub && <span className="ml-2 text-xs font-normal text-fg-subtle">{o.sub}</span>}</dt>
      <dd className={o.strong ? "font-display text-lg font-bold" : ""}><Money value={value} currency={cur} tone={o.strong ? "auto" : undefined} /></dd>
    </div>
  );
  return (
    <InsightShell loading={loading} error={error} stale={stale}>
      {d && (
        <div className="space-y-4" data-testid="pnl-report">
          <ReportNotices meta={d} extra={d.note ? [d.note] : []} />
          {d.bills === 0 && Number(d.expenses.total) === 0 ? <Empty>No sales or expenses in this range.</Empty> : (
            <Card>
              <CardHeader title="Profit and loss" description={`${d.bills} ${d.bills === 1 ? "bill" : "bills"} · amounts excl. ${W}`} />
              <dl className="divide-y divide-border/60 text-sm">
                {row("Net sales", d.net_sales_excl_vat, { sub: Number(d.refunds_excl_vat) > 0 ? `after refunds of ${formatMoney(d.refunds_excl_vat)}` : undefined })}
                {row("Ingredient cost", d.ingredient_cost, { minus: true })}
                {costKnown(d)
                  ? row("Gross profit", d.gross_profit, { strong: true, sub: d.gross_margin_percent ? `${Number(d.gross_margin_percent)}% margin` : undefined })
                  : <div className="flex items-baseline justify-between gap-3 border-t border-border py-2.5 font-semibold text-fg" data-testid="pnl-profit-unknown"><dt>Gross profit</dt><dd className="text-sm font-normal"><AddCosts /></dd></div>}
                {d.expenses.by_category.map((c) => row(c.category, c.amount, { minus: true, sub: `${c.count} ${c.count === 1 ? "expense" : "expenses"}` }))}
                {d.expenses.by_category.length === 0 && row("Expenses", d.expenses.total, { minus: true })}
                {row("Operating profit", d.operating_profit, { strong: true, sub: costKnown(d) && d.operating_margin_percent ? `${Number(d.operating_margin_percent)}% margin` : undefined })}
              </dl>
              {d.expenses.vat_excluded && <p className="mt-2 text-xs text-fg-subtle">Expenses are shown without {W}.</p>}
              <p className="mt-3 text-xs text-fg-subtle">{W} is not part of profit: output {formatMoney(d.vat.output_vat)}, input {formatMoney(d.vat.input_vat)}, net due {formatMoney(d.vat.net_vat_due)}.</p>
            </Card>)}
          {d.items_without_recipe.length > 0 && <Notice tone="warning" title="Items without a recipe">{d.items_without_recipe.join(", ")}. Their cost is not counted, so profit looks higher than it is.</Notice>}
          {d.ingredients_without_cost.length > 0 && <Notice tone="warning" title="Ingredients without a cost">{d.ingredients_without_cost.join(", ")}. Confirm a purchase invoice for them to get a cost.</Notice>}
        </div>)}
    </InsightShell>
  );
}

/** Who comes back: customer counts, repeat rate and the top customers by spend. */
export function CustomersTab({ from, to, tick }: Range) {
  const { data: d, error, loading, stale } = useInsight(api.customerInsights, from, to, tick);
  return (
    <InsightShell loading={loading} error={error} stale={stale}>
      {d && (
        <div className="space-y-4" data-testid="customers-report">
          <ReportNotices meta={d} extra={d.note ? [d.note] : []} />
          {d.customers === 0 && d.bills_without_customer === 0 ? <Empty>No bills in this range.</Empty> : (
            <>
              <div className="grid grid-cols-2 gap-3 max-sm:[&_.font-display]:text-2xl lg:grid-cols-4 sm:gap-4">
                <KpiTile label="Customers" value={String(d.customers)} hint={`${d.bills_with_customer} bills with a customer`} />
                <KpiTile label="New customers" value={String(d.new_customers)} hint="First visit in this range" />
                <KpiTile label="Returning" value={String(d.returning_customers)} hint={`${pct(d.returning_rate_percent)} of customers`} />
                <KpiTile label="Bills with a customer" value={d.identified_share_percent ? `${Number(d.identified_share_percent)}%` : "-"}
                  hint={`${d.bills_without_customer} bills without one`} />
              </div>
              {d.top_customers.length === 0 ? <Empty>No named customers in this range. Attach a customer to a bill in Chilli Agent to see them here.</Empty> : (
                <DataGrid caption="Top customers" getKey={(c) => `${c.name}-${c.phone}`} rows={d.top_customers}
                  cols={[
                    { header: "Customer", render: (c) => <>{c.name ?? c.phone ?? "-"}{c.name && c.phone && <span className="ml-2 text-xs text-fg-subtle">{c.phone}</span>}</> },
                    { header: "Visits", end: true, render: (c) => c.visits },
                    { header: "Spend", end: true, render: (c) => formatMoney(c.spend) },
                    { header: "Average bill", end: true, render: (c) => (c.average_bill ? formatMoney(c.average_bill) : "-") },
                    { header: "Last visit", render: (c) => day(c.last_visit) },
                    { header: "Type", render: (c) => (c.returning ? <Badge tone="success">Returning</Badge> : <Badge tone="neutral">New</Badge>) },
                  ]} />)}
              <p className="text-xs text-fg-subtle">Repeat rate {pct(d.repeat_rate_percent)}.</p>
            </>)}
        </div>)}
    </InsightShell>
  );
}
