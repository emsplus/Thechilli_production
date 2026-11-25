"use client";

import { useEffect, useState } from "react";
import { Button, Input, Notice, Select, Sheet } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import { bulkPrice, priceInputProblem, type PriceMode } from "@/lib/bulkPrice";
import { formatCurrency } from "@/lib/money";
import { useCurrency } from "@/lib/taxConfig";
import { useNotify } from "@/lib/useNotify";
import { useLocale, useMsg } from "@/lib/i18n";
import type { Category, MenuItem } from "@/lib/types";
import { BULK_MSG } from "./menu-messages";

export type BulkKind = "price" | "category";

/** The PUT body of an unchanged item with one field replaced (the API replaces the whole item, options included). */
const bodyOf = (i: MenuItem, over: { price?: string; category_id?: string }) => ({
  category_id: over.category_id ?? i.category_id, name: i.name, price: over.price ?? i.price,
  ...(i.tax_kind ? { tax_kind: i.tax_kind } : {}),
  variants: i.variants.map((v) => ({ id: v.id, name: v.name, price_delta: v.price_delta })),
});

/** Change the price of, or move, every selected item in one go. Items are saved one by one; failures are reported, never hidden. */
export function BulkMenuSheet({ kind, onClose, items, cats, onDone }: { kind: BulkKind | null; onClose: () => void; items: MenuItem[]; cats: Category[]; onDone: () => void }) {
  const toast = useNotify();
  const t = useMsg(BULK_MSG);
  const { locale } = useLocale();
  const currency = useCurrency();
  const [mode, setMode] = useState<PriceMode>("percent");
  const [value, setValue] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  useEffect(() => { if (kind) { void Promise.resolve().then(() => { setValue(""); setTarget(""); setShown(false); }); } }, [kind]);

  const problem = kind === "price" ? priceInputProblem(mode, value, locale) : target ? null : t("chooseCategory");
  const preview = kind === "price" && !priceInputProblem(mode, value) ? items.map((i) => ({ i, next: bulkPrice(i.price, mode, value) })) : [];
  const negatives = preview.filter((p) => p.next === null).length;

  async function apply() {
    setShown(true);
    if (problem || negatives > 0) return;
    setBusy(true);
    let failed = 0, lastErr = "";
    for (const i of items) {
      try {
        if (kind === "price") await api.updateItem(i.id, bodyOf(i, { price: bulkPrice(i.price, mode, value)! }));
        else if (i.category_id !== target) await api.updateItem(i.id, bodyOf(i, { category_id: target }));
      } catch (e) { failed++; lastErr = e instanceof ApiError ? e.message : ""; }
    }
    setBusy(false);
    const ok = items.length - failed;
    if (ok > 0) toast.success(kind === "price" ? t(ok === 1 ? "priceChangedOne" : "priceChangedMany", { n: ok }) : t(ok === 1 ? "movedOne" : "movedMany", { n: ok, cat: cats.find((c) => c.id === target)?.name ?? "" }));
    if (failed > 0) toast.error(t(`${kind === "price" ? "failPrice" : "failCategory"}${lastErr ? "Err" : ""}`, { n: failed, err: lastErr }));
    onDone(); onClose();
  }

  return (
    <Sheet side="right" open={kind !== null} onOpenChange={(o) => { if (!o && !busy) onClose(); }}
      title={kind === "price" ? t("titlePrice") : t("titleMove")} description={t(items.length === 1 ? "selectedOne" : "selectedMany", { n: items.length })}
      footer={<><Button disabled={busy} onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void apply()}>{t(items.length === 1 ? "applyOne" : "applyMany", { n: items.length })}</Button></>}>
      <div className="space-y-4">
        {kind === "price" ? (<>
          <Select label={t("howChange")} value={mode} onChange={(e) => setMode(e.target.value as PriceMode)}>
            <option value="percent">{t("modePercent")}</option>
            <option value="add">{t("modeAdd")}</option>
            <option value="set">{t("modeSet")}</option>
          </Select>
          <Input label={mode === "percent" ? t("labelPercent") : mode === "add" ? t("labelAdd") : t("labelSet")} inputMode="decimal" autoComplete="off"
            placeholder={mode === "percent" ? "5" : mode === "add" ? "10" : "120"} value={value} onChange={(e) => setValue(e.target.value)} error={shown ? problem ?? undefined : undefined} />
          {negatives > 0 && <Notice tone="danger">{t(negatives === 1 ? "negOne" : "negMany", { n: negatives })}</Notice>}
          {preview.length > 0 && (
            <ul aria-label={t("newPrices")} className="divide-y divide-border rounded-xl border border-border text-sm">
              {preview.slice(0, 6).map(({ i, next }) => (
                <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2"><span className="min-w-0 [overflow-wrap:anywhere]">{i.name}</span>
                  <span className="ch-money shrink-0" translate="no">{formatCurrency(i.price, currency)} {t("to")} <b>{next === null ? t("belowZero") : formatCurrency(next, currency)}</b></span></li>
              ))}
              {preview.length > 6 && <li className="px-3 py-2 text-fg-muted">{t("andMore", { n: preview.length - 6 })}</li>}
            </ul>
          )}
        </>) : (
          <Select label={t("moveTo")} value={target} onChange={(e) => setTarget(e.target.value)} error={shown ? problem ?? undefined : undefined}>
            <option value="">{t("chooseCategoryOpt")}</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}
      </div>
    </Sheet>
  );
}
