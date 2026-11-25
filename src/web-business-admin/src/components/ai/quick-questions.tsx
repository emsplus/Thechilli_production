"use client";

import { useState } from "react";
import { Boxes, ChefHat, ChevronDown, ReceiptText, ShieldAlert, TrendingUp, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/** Tap-to-send questions in the six areas the owner works in (plain English and simple Hinglish; the PDF ones make the assistant prepare a report). */
export const QUESTION_GROUPS: { id: string; title: string; icon: LucideIcon; questions: string[] }[] = [
  { id: "sales", title: "Sales & Billing", icon: ReceiptText, questions: ["How much did I sell today?", "Which dishes sell best this week?", "Sales by category this month", "Sales report PDF for last week"] },
  { id: "stock", title: "Inventory & Purchase", icon: Boxes, questions: ["Which items are low on stock?", "How much did I spend on purchases this month?", "How much did I buy from each supplier this week?", "Purchases report PDF (last 30 days)"] },
  { id: "kitchen", title: "Kitchen Operations & Food Cost", icon: ChefHat, questions: ["Which dish has the highest food cost?", "Which dishes have no recipe yet?", "Food cost report PDF (last 30 days)"] },
  { id: "finance", title: "Finance & Profitability", icon: TrendingUp, questions: ["What is my profit this month?", "What was my gross profit this week?", "Profit and loss PDF for this month", "GST summary PDF for this quarter"] },
  { id: "people", title: "Staff & Customer Management", icon: Users, questions: ["Show sales by staff member", "Who are my best customers?", "How many customers came back this month?", "Staff sales report PDF this week"] },
  { id: "leak", title: "AI Analytics & Revenue Leakage", icon: ShieldAlert, questions: ["Is money leaking anywhere? Check discounts and cancelled orders", "Which staff gave the most discounts?", "Which bills are still unpaid?", "Leakage report PDF for this month"] },
];

/** The six areas as a compact accordion (one open at a time); every question is a chip that sends its text. */
export function QuickQuestions({ onPick, className }: { onPick: (q: string) => void; className?: string }) {
  const [open, setOpen] = useState<string>(QUESTION_GROUPS[0].id);
  return (
    <div className={cn("w-full text-left", className)}>
      {QUESTION_GROUPS.map((g) => {
        const on = open === g.id;
        return (
          <section key={g.id} className="border-b border-border last:border-b-0">
            <h4>
              <button type="button" aria-expanded={on} aria-controls={`qq-${g.id}`} onClick={() => setOpen(on ? "" : g.id)}
                className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-1 py-2 text-left text-sm font-semibold text-fg transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring">
                <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-soft-fg [&_svg]:size-4"><g.icon /></span>
                <span className="min-w-0 flex-1">{g.title}</span>
                <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-fg-subtle transition-transform", on && "rotate-180")} />
              </button>
            </h4>
            {on && (
              <div id={`qq-${g.id}`} className="flex flex-wrap gap-2 pb-3 pl-1">
                {g.questions.map((q) => (
                  <button key={q} type="button" onClick={() => onPick(q)}
                    className="min-h-11 rounded-full border border-border-strong bg-surface px-3.5 py-2 text-left text-sm font-medium text-fg transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring">{q}</button>))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The same six areas as a slim strip above the message box, so the ideas stay one tap away after every question
 * (the big list above only shows while the chat is empty). Tapping an area opens its questions right above the strip;
 * tapping a question sends it and closes the list.
 */
export function QuickBar({ onPick, disabled }: { onPick: (q: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState("");
  const group = QUESTION_GROUPS.find((g) => g.id === open);
  return (
    <div className="mb-2">
      {group && (
        <div id="quick-bar-list" role="group" aria-label={`${group.title}: questions`} className="mb-2 flex max-h-[34dvh] flex-wrap gap-2 overflow-y-auto scrollbar-thin">
          {group.questions.map((q) => (
            <button key={q} type="button" disabled={disabled} onClick={() => { setOpen(""); onPick(q); }}
              className="min-h-11 rounded-full border border-border-strong bg-surface px-3.5 py-2 text-left text-sm font-medium text-fg transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">{q}</button>))}
        </div>
      )}
      <div role="group" aria-label="Ask about" className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
        {QUESTION_GROUPS.map((g) => (
          <button key={g.id} type="button" aria-pressed={open === g.id} aria-controls={open === g.id ? "quick-bar-list" : undefined} disabled={disabled} onClick={() => setOpen(open === g.id ? "" : g.id)}
            className={cn("inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 [&_svg]:size-3.5",
              open === g.id ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border-strong bg-surface text-fg-muted hover:bg-surface-2")}>
            <g.icon aria-hidden />{g.title}
          </button>))}
      </div>
    </div>
  );
}
