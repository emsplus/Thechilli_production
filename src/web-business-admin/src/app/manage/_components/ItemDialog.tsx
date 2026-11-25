"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, X } from "lucide-react";
import { Button, IconButton, Input, Notice, Select, Sheet, Textarea } from "@chilli/ui";
import { useNotify } from "@/lib/useNotify";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useMsg } from "@/lib/i18n";
import { api, ApiError, mediaUrl } from "@/lib/api";
import { uploadMessage } from "@/lib/image";
import { currencyMark, formatCurrency } from "@/lib/money";
import { useTaxConfig } from "@/lib/taxConfig";
import { useCan } from "@/lib/useRole";
import type { Category, InventoryItem, MenuItem } from "@/lib/types";
import { VegMark } from "@/components/menu/veg-mark";
import { cleanDescription, DESCRIPTION_MAX, foodTypeOf, vegOf, type FoodKind } from "@/lib/menuAdmin";
import { ITEM_MSG } from "./menu-messages";
import { EMPTY_PHOTO, PhotoField, type PhotoDraft } from "./PhotoField";
import { blankRow, filledRows, RecipeFields, recipeKey, recipeProblem, type RecipeRow } from "./RecipeFields";
import { ItemExtrasFields, saveItemExtras, useItemExtras } from "./ItemExtras";

const MONEY = /^\d+(\.\d{1,2})?$/;
/** The server stores a price with at most 10 digits before the point; longer ones used to come back as a raw validation toast (QA D15). */
const PRICE = /^\d{1,10}(\.\d{1,2})?$/;
const makeSchema = (t: (k: string) => string) => z.object({
  category_id: z.string().min(1, t("chooseCategory")),
  name: z.string().trim().min(1, t("enterName")).max(200, t("nameMax")),
  price: z.string().regex(MONEY, t("priceFormat")).regex(PRICE, t("priceTooBig")),
  food: z.enum(["none", "veg", "nonveg", "egg"]),
  description: z.string().refine((v) => cleanDescription(v).length <= DESCRIPTION_MAX, t("descriptionMax").replace("{max}", String(DESCRIPTION_MAX))),
  variants: z.array(z.object({
    variant_id: z.string().optional(), // existing variant (kept/edited); absent = new. Not "id": useFieldArray owns that key.
    name: z.string().trim().min(1, t("nameOption")).max(100, t("tooLong")),
    price_delta: z.string().regex(MONEY, t("optionDelta")).regex(PRICE, t("priceTooBig")),
  })),
});
type Form = z.infer<ReturnType<typeof makeSchema>>;
const FOOD_CHOICES: { value: Form["food"]; label: string }[] = [
  { value: "none", label: "foodNone" }, { value: "veg", label: "foodVeg" }, { value: "nonveg", label: "foodNonVeg" }, { value: "egg", label: "foodEgg" },
];

/**
 * Add or edit an item with its options. On edit, options are matched by id: edited ones keep their id, new ones are
 * created, and removed ones are retired on the server (kept for past orders, no longer offered on the POS).
 */
export function ItemDialog({ open, onOpenChange, item, cats, defaultCategory, onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; item: MenuItem | null; cats: Category[]; defaultCategory: string; onSaved: () => void;
}) {
  const toast = useNotify();
  const confirm = useConfirm();
  const t = useMsg(ITEM_MSG);
  const schema = useMemo(() => makeSchema(t), [t]);
  const editing = item !== null;
  const cfg = useTaxConfig();
  const { feature } = useCan();
  const hasInventory = feature("inventory"); // plans without inventory get 403 feature_not_entitled: do not ask (red console error on every edit)
  const mark = currencyMark(cfg?.currency);
  const [photo, setPhoto] = useState<PhotoDraft>(EMPTY_PHOTO);
  const [uploading, setUploading] = useState(false);
  const [inv, setInv] = useState<InventoryItem[] | null>(null);
  const [recipe, setRecipe] = useState<RecipeRow[]>(() => [blankRow()]);
  const [recipeBase, setRecipeBase] = useState("[]"); // the recipe as loaded: saved again only when it changed
  const [ext, setExt] = useItemExtras(open, item);
  const [gst, setGst] = useState(""); // "" = restaurant default (not sent) // modifier groups + combo parts (hidden on servers without them)
  const f = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { category_id: "", name: "", price: "", food: "none", description: "", variants: [] } });
  const { fields, append, remove } = useFieldArray({ control: f.control, name: "variants" });
  const { errors, isSubmitting } = f.formState;
  const watchedName = useWatch({ control: f.control, name: "name" });
  const watchedCat = useWatch({ control: f.control, name: "category_id" });
  const current = useWatch({ control: f.control, name: "variants" });
  const watchedDesc = useWatch({ control: f.control, name: "description" }) ?? "";
  const foodHintId = useId();
  const keptIds = new Set((current ?? []).map((v) => v.variant_id).filter(Boolean));
  const removed = editing ? item.variants.filter((v) => !keptIds.has(v.id)).map((v) => v.name) : [];

  useEffect(() => {
    if (!open) return;
    f.reset(item
      ? { category_id: item.category_id, name: item.name, price: item.price, food: vegOf(item) ?? "none", description: item.description ?? "", variants: item.variants.map((v) => ({ variant_id: v.id, name: v.name, price_delta: v.price_delta })) }
      : { category_id: defaultCategory, name: "", price: "", food: "none", description: "", variants: [] });
    void Promise.resolve().then(() => { setPhoto(EMPTY_PHOTO); setGst(item?.gst_rate_code ?? ""); });
  }, [open, item, defaultCategory, f]);

  // Stock items for the recipe, and (when editing) the dish's current recipe.
  useEffect(() => {
    if (!open) return;
    let off = false;
    void Promise.resolve().then(() => { if (off) return; setInv(null); setRecipe([blankRow()]); setRecipeBase("[]"); });
    if (!hasInventory) { void Promise.resolve().then(() => { if (!off) setInv([]); }); return () => { off = true; }; }
    Promise.all([api.inventoryItems(), item ? api.recipes() : Promise.resolve([])]).then(([stock, recs]) => {
      if (off) return;
      const rec = item ? recs.find((r) => r.menu_item_id === item.id) : undefined;
      const rows = rec ? rec.ingredients.map((g): RecipeRow => ({ ...blankRow(), item_id: g.item_id, quantity: String(+Number(g.quantity).toFixed(3)), unit: stock.find((x) => x.id === g.item_id)?.base_unit ?? "g" })) : [blankRow()];
      setInv(stock); setRecipe(rows); setRecipeBase(recipeKey(rows));
    }).catch(() => { if (!off) setInv([]); });
    return () => { off = true; };
  }, [open, item, hasInventory]);

  const submit = f.handleSubmit(async (d) => {
    const problem = recipeProblem(recipe);
    if (problem) { toast.error(problem); return; }
    // A price of 0 is allowed (a free dish) but never by accident (QA D14): ask once.
    if (Number(d.price) === 0 && !(await confirm({ title: t("priceZeroTitle"), description: t("priceZeroDesc", { price: formatCurrency("0", cfg?.currency) }), confirmLabel: t("priceZeroConfirm"), cancelLabel: t("priceZeroBack") }))) { f.setFocus("price"); return; }
    const body = { category_id: d.category_id, name: d.name.trim(), price: d.price, variants: d.variants.map((v) => ({ ...(v.variant_id ? { id: v.variant_id } : {}), name: v.name.trim(), price_delta: v.price_delta })), ...(gst ? { gst_rate_code: gst } : {}),
      food_type: foodTypeOf(d.food === "none" ? null : (d.food as FoodKind)), description: cleanDescription(d.description) || null };
    let saved: MenuItem;
    try {
      saved = item ? await api.updateItem(item.id, body) : await api.createItem({ ...body, variants: body.variants.map(({ name, price_delta }) => ({ name, price_delta })) });
    } catch (e) {
      // 409 duplicate_item_name (a dish with this name is already on the menu): the server's plain sentence goes under the Name field, like a table
      // label (QA D13). Any other 409 is not about the name: it stays a toast.
      if (e instanceof ApiError && e.status === 409 && e.code === "duplicate_item_name" && e.message) f.setError("name", { type: "server", message: e.message }, { shouldFocus: true });
      else toast.error(e instanceof ApiError ? e.message : t("saveFail"));
      return;
    }
    // The item is saved from here on; a recipe or photo problem must not make the owner re-create it.
    let recipeFailed: string | null = null;
    if (inv && inv.length > 0 && recipeKey(recipe) !== recipeBase && filledRows(recipe).length > 0) {
      try { await api.saveRecipe({ menu_item_id: saved.id, ingredients: filledRows(recipe).map((r) => ({ item_id: r.item_id, quantity: r.quantity.trim(), unit: r.unit })) }); }
      catch (e) { recipeFailed = e instanceof ApiError ? e.message : t("recipeSaveFail"); }
    }
    const extrasFailed = await saveItemExtras(saved.id, ext);
    if (extrasFailed) toast.error(`${body.name} was saved, but its modifier groups or combo parts were not: ${extrasFailed}`);
    let photoFailed: string | null = null;
    try {
      if (photo.prepared) { setUploading(true); await api.uploadItemImage(saved.id, photo.prepared.blob, photo.prepared.name); }
      else if (photo.remove && item?.image_url) await api.deleteItemImage(saved.id);
    } catch (e) { photoFailed = e instanceof ApiError ? uploadMessage(e.status, e.message) : t("photoUploadFail"); }
    finally { setUploading(false); }
    if (recipeFailed) toast.error(t("savedRecipeFailed", { name: body.name, err: recipeFailed }));
    if (photoFailed) toast.error(t("savedPhotoFailed", { name: body.name, err: photoFailed }));
    else if (!recipeFailed && !extrasFailed) toast.success(t(item ? "updated" : "added", { name: body.name }));
    onSaved(); onOpenChange(false);
  });

  return (
    <Sheet side="right" open={open} onOpenChange={(o) => { if (!o && uploading) return; onOpenChange(o); }} title={t(editing ? "titleEdit" : "titleAdd")} description={t(cfg?.vat_registered === false ? "descNoVat" : cfg?.prices_include_tax ? "descInclusive" : "descExclusive")}
      footer={<>
        <Button disabled={uploading} onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
        <Button variant="primary" type="submit" form="item-form" loading={isSubmitting || uploading}>{t(editing ? "saveChanges" : "titleAdd")}</Button>
      </>}>
      <form id="item-form" onSubmit={(e) => void submit(e)} noValidate className="space-y-4 pb-3">
        <PhotoField name={watchedName} category={cats.find((c) => c.id === watchedCat)?.name} existingUrl={mediaUrl(item?.image_url ?? item?.thumb_url)} draft={photo} onChange={setPhoto} uploading={uploading} />
        <Input label={t("name")} placeholder={t("namePh")} autoComplete="off" error={errors.name?.message} {...f.register("name")} />
        <fieldset className="space-y-2" aria-describedby={foodHintId}>
          <legend className="text-sm font-semibold text-fg">{t("foodLegend")}</legend>
          <div className="grid grid-cols-2 gap-2">
            {FOOD_CHOICES.map((c) => (
              <label key={c.value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-fg has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ring)]">
                <input type="radio" value={c.value} className="size-4 shrink-0 accent-[var(--c-primary)]" {...f.register("food")} />
                {c.value === "none" ? <span aria-hidden className="size-4 shrink-0 rounded-[3px] border-2 border-dashed border-border-strong" /> : <VegMark kind={c.value} decorative />}
                <span>{t(c.label)}</span>
              </label>
            ))}
          </div>
          <p id={foodHintId} className="text-xs text-fg-muted">{t("foodHint")}</p>
        </fieldset>
        <Textarea label={t("description")} rows={2} placeholder={t("descriptionPh")} autoComplete="off" error={errors.description?.message}
          hint={t("descriptionHint", { n: cleanDescription(watchedDesc).length, max: DESCRIPTION_MAX })} {...f.register("description")} />
        <Select label={t("category")} error={errors.category_id?.message} {...f.register("category_id")}>
          <option value="">{t("chooseCategoryOpt")}</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Input label={mark ? t("priceMark", { mark }) : t("price")} hint={cfg?.prices_include_tax ? t("priceHint") : undefined} inputMode="decimal" placeholder="120.00" autoComplete="off" error={errors.price?.message} {...f.register("price")} />
        <Select label="GST rate" hint="Restaurant default suits most dishes (5% for restaurant service). Confirm with your accountant." value={gst} onChange={(e) => setGst(e.target.value)}>
          <option value="">Restaurant default{cfg?.rates.find((r) => r.code === "standard") ? ` (${Number(cfg.rates.find((r) => r.code === "standard")!.rate_percent)}%)` : ""}</option>
          {["gst_0", "gst_5", "gst_12", "gst_18", "gst_28"].map((c) => <option key={c} value={c}>GST {c.slice(4)}%</option>)}
        </Select>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-fg">{t("optionsLegend")}</legend>
          {fields.length > 0 && <div aria-hidden className="grid grid-cols-[1fr_6.5rem_2.75rem] gap-2 text-xs text-fg-muted"><span>{t("optionName")}</span><span>{t("extraPrice")}</span><span /></div>}
          {fields.map((fld, i) => (
            <div key={fld.id} className="grid grid-cols-[1fr_6.5rem_2.75rem] items-start gap-2 [&_.ch-label]:sr-only">
              <Input label={t("optionNameLabel", { n: i + 1 })} placeholder={t("optionNamePh")} error={errors.variants?.[i]?.name?.message} {...f.register(`variants.${i}.name`)} />
              <Input label={t("optionExtraLabel", { n: i + 1 })} inputMode="decimal" placeholder="30.00" error={errors.variants?.[i]?.price_delta?.message} {...f.register(`variants.${i}.price_delta`)} />
              <IconButton variant="ghost" label={t("removeOption", { n: i + 1 })} icon={<X />} onClick={() => remove(i)} />
            </div>
          ))}
          <Button iconStart={<Plus />} onClick={() => append({ name: "", price_delta: "0" })}>{t("addOption")}</Button>
          <p className="text-xs text-fg-muted">{t("extraHelp")}</p>
          {editing && removed.length > 0 && (
            <Notice tone="info">{t(removed.length === 1 ? "removedOne" : "removedMany", { names: removed.join(", ") })}</Notice>
          )}
        </fieldset>

        <ItemExtrasFields s={ext} set={setExt} itemId={item?.id ?? null} />

        <RecipeFields rows={recipe} onChange={setRecipe} inv={inv} onlyOneRecipe={fields.length > 0} />
      </form>
    </Sheet>
  );
}
