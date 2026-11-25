"use client";

import { Badge, Button, Dialog, IconButton, Input, Notice, Select, Skeleton } from "@chilli/ui";
import { useCallback, useMemo, useState } from "react";
import { Download, FileText, Pencil, Plus, ReceiptText } from "lucide-react";
import { Card, EmptyState, Money, toast } from "@/components/ui";
import { DataGrid, KpiTile } from "@/app/reports/_components/parts";
import { api, ApiError } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { formatDate, formatMonthYear } from "@/lib/datetime";
import { addDecimal, isDecimal } from "@/lib/decimal";
import { sumMoney, formatCompactMoney } from "@/lib/money";
import { useCurrency } from "@/lib/taxConfig";
import { EXPENSE_CATEGORIES, type Expense, type ExpenseCategory, type Purchase } from "@/lib/types";
import { useLoader } from "@/lib/useLoader";
import { useManage } from "./manage-context";
import { useTaxWord } from "@/lib/taxWords";

const em = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

export function guessCategory(text: string): ExpenseCategory {
  const t = text.toLowerCase();
  if (/broadband|telephone|phone|mobile|internet|virgin|bt\b|vodafone|o2|ee\b/.test(t)) return "Telecom";
  if (/electric|gas|water|energy|utilit|british gas|octopus/.test(t)) return "Utilities";
  if (/\brent\b|lease|landlord/.test(t)) return "Rent";
  if (/clean|hygiene|waste|pest/.test(t)) return "Cleaning";
  if (/packag|takeaway container|carrier/.test(t)) return "Packaging";
  if (/repair|maintenance|plumb|engineer/.test(t)) return "Repairs";
  return "Other";
}

/** Add or edit an expense; from an invoice review it is prefilled from what was read and files the scan under it. */
export function ExpenseDialog({ open, onOpenChange, invoice, expense, supplierName = "", supplierId = null, date = "", number = "", onSaved, net: netOverride, vat: vatOverride, currency, beforeSave }: {
  open: boolean; onOpenChange: (o: boolean) => void; invoice?: Purchase; expense?: Expense; supplierName?: string; supplierId?: string | null; date?: string; number?: string; onSaved: () => void | Promise<void>;
  /** The review screen's live amounts (lines edited there); default is what the bill printed. */
  net?: string; vat?: string;
  /** Currency printed on the bill when it is not the restaurant's. */
  currency?: string;
  /** Runs before the expense is created (the review screen saves the edited lines with the invoice). */
  beforeSave?: () => Promise<void>;
}) {
  const W = useTaxWord();
  const linesNet = invoice ? sumMoney(invoice.lines.map((l) => l.line_total ?? "0")) : "";
  const [name, setName] = useState(expense?.supplier_name ?? supplierName);
  const [num, setNum] = useState(expense?.invoice_number ?? number);
  const [day, setDay] = useState(expense?.expense_date ?? date);
  const [cat, setCat] = useState<ExpenseCategory>(expense?.category ?? guessCategory(`${supplierName} ${invoice?.lines.map((l) => l.description).join(" ") ?? ""}`));
  const [net, setNet] = useState(expense?.net ?? netOverride ?? invoice?.net ?? (invoice?.total && invoice.vat ? sumMoney([invoice.total, `-${invoice.vat}`]) : linesNet));
  const [vat, setVat] = useState(expense?.vat ?? vatOverride ?? invoice?.vat ?? "0.00");
  const [note, setNote] = useState(expense?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const gross = isDecimal(net) && isDecimal(vat) ? addDecimal(net, vat) : null;

  async function submit() {
    if (!name.trim()) { setErr("Enter who the bill is from"); return; }
    if (!day) { setErr("Choose the invoice date"); return; }
    if (!isDecimal(net) || !isDecimal(vat)) { setErr(`Net and ${W} must be amounts such as 74.29`); return; }
    setBusy(true); setErr(null);
    const body = { supplier_id: supplierId, supplier_name: name.trim(), invoice_number: num.trim() || null, expense_date: day, category: cat, net, vat, note: note.trim() || null };
    try {
      if (!expense) await beforeSave?.();
      if (expense) await api.updateExpense(expense.id, body); else await api.createExpense({ ...body, invoice_id: invoice?.id ?? null });
      toast.success(expense ? "Expense updated" : "Expense recorded. No stock was added.");
      await onSaved(); onOpenChange(false);
    } catch (e) { setErr(em(e, "Could not save the expense")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={expense ? "Edit expense" : invoice ? "Record as expense" : "Add expense"}
      description={invoice ? "Keeps the amounts with the scanned invoice. Nothing is added to stock." : "A bill that is not stock: utilities, telecom, rent, cleaning."}
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="expense-form" loading={busy}>{expense ? "Save changes" : "Record expense"}</Button></>}>
      <form id="expense-form" noValidate className="space-y-3 py-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label="From" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Airtel Business" />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Invoice number" value={num} onChange={(e) => setNum(e.target.value)} />
          <Input label="Date" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </div>
        <Select label="Category" value={cat} onChange={(e) => setCat(e.target.value as ExpenseCategory)}>{EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select>
        <div className="grid grid-cols-3 gap-3">
          <Input label="Net" inputMode="decimal" value={net} onChange={(e) => setNet(e.target.value)} />
          <Input label={W} inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} />
          <div className="flex flex-col gap-1.5"><span className="text-sm font-semibold text-fg">Total</span><p className="tnum flex h-11 items-center font-display text-lg font-bold">{gross ? <Money value={gross} currency={currency} /> : "-"}</p></div>
        </div>
        <Input label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </form>
    </Dialog>
  );
}

const monthLabel = (k: string) => formatMonthYear(k);

/** Manage > Suppliers & Purchases > Expenses: bills that are not stock, with monthly and category totals and a CSV export. */
export function ExpensesView() {
  const W = useTaxWord();
  const { goto } = useManage();
  const currency = useCurrency();
  const [month, setMonth] = useState("");
  const range = useMemo(() => {
    if (!month) return {};
    const [y, m] = month.split("-").map(Number);
    return { from: `${month}-01`, to: `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}` };
  }, [month]);
  const fetchAll = useCallback(async () => { const [list, summary] = await Promise.all([api.expenses(range), api.expenseSummary(range)]); const all = month ? await api.expenseSummary() : summary; return { list, summary, months: all.months }; }, [range, month]);
  const { data, error, loading, reload } = useLoader(fetchAll);
  const [dlg, setDlg] = useState<{ open: boolean; nonce: number; expense?: Expense }>({ open: false, nonce: 0 });

  const csv = () => data && downloadCsv(`expenses${month ? `-${month}` : ""}.csv`, [["Date", "Supplier", "Category", "Invoice number", "Net", W, "Total", "Note"],
    ...data.list.map((e) => [e.expense_date, e.supplier_name, e.category, e.invoice_number ?? "", e.net, e.vat, e.gross, e.note ?? ""])]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">Bills that are not stock: broadband, energy, rent, cleaning. They never change your stock.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" iconStart={<Download />} disabled={!data?.list.length} onClick={csv}>Download CSV</Button>
          <Button variant="primary" iconStart={<Plus />} onClick={() => setDlg((d) => ({ open: true, nonce: d.nonce + 1 }))}>Add expense</Button>
        </div>
      </div>
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {loading ? <Skeleton className="h-40 w-full rounded-2xl" /> : !data || (data.months.length === 0 && !month) ? (
        <Card><EmptyState icon={<ReceiptText />} title="No expenses yet" hint="Scan a utility or service bill and choose “Record as expense”, or add one by hand." action={<Button variant="primary" iconStart={<Plus />} onClick={() => setDlg((d) => ({ open: true, nonce: d.nonce + 1 }))}>Add expense</Button>} /></Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <Select label="Period" value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="">All time</option>{data.months.map((m) => <option key={m.key} value={m.key}>{monthLabel(m.key)}</option>)}
            </Select>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label={`Total (with ${W})`} value={formatCompactMoney(data.summary.total.gross, currency)} />
            <KpiTile label="Net" value={formatCompactMoney(data.summary.total.net, currency)} />
            <KpiTile label={W} value={formatCompactMoney(data.summary.total.vat, currency)} />
            <KpiTile label="Bills" value={String(data.summary.total.count)} />
          </div>
          {data.summary.categories.length > 0 && <ul aria-label="By category" className="mb-4 flex flex-wrap gap-2">{data.summary.categories.map((c) => <li key={c.key}><Badge tone="neutral">{c.key}: <Money value={c.gross} /></Badge></li>)}</ul>}
          <DataGrid caption="Expenses" getKey={(e) => e.id} rows={data.list}
            cols={[
              { header: "Date", render: (e) => formatDate(e.expense_date) },
              { header: "From", render: (e) => <span className="font-medium">{e.supplier_name}{e.note && <span className="block text-xs font-normal text-fg-subtle">{e.note}</span>}</span> },
              { header: "Category", render: (e) => <Badge tone="info">{e.category}</Badge> },
              { header: "Invoice", render: (e) => e.invoice_number ?? "-" },
              { header: "Net", end: true, render: (e) => <Money value={e.net} showCurrency={false} /> },
              { header: W, end: true, render: (e) => <Money value={e.vat} showCurrency={false} /> },
              { header: "Total", end: true, render: (e) => <strong><Money value={e.gross} showCurrency={false} /></strong> },
              { header: "Actions", end: true, render: (e) => (
                <span className="whitespace-nowrap">
                  {e.invoice_id && <IconButton label={`Open invoice ${e.invoice_number ?? ""}`} icon={<FileText />} onClick={() => goto("suppliers", "invoices", { invoice: e.invoice_id!, from: "expenses" })} />}
                  <IconButton label={`Edit expense from ${e.supplier_name}`} icon={<Pencil />} onClick={() => setDlg((d) => ({ open: true, nonce: d.nonce + 1, expense: e }))} />
                </span>) },
            ]} />
        </>
      )}
      <ExpenseDialog key={dlg.nonce} open={dlg.open} onOpenChange={(o) => setDlg((d) => ({ ...d, open: o }))} expense={dlg.expense} onSaved={() => { void reload(); }} />
    </>
  );
}
