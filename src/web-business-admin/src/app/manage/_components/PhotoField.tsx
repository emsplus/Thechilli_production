"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Loader, RefreshCw, Trash2, Upload } from "lucide-react";
import { Button } from "@chilli/ui";
import { useNotify } from "@/lib/useNotify";
import { useMsg } from "@/lib/i18n";
import { FoodImage } from "@/components/pos/food-image";
import { cn } from "@/lib/cn";
import { ITEM_MSG } from "./menu-messages";
import { PHOTO_TYPES, PhotoError, mb, preparePhoto, type PreparedPhoto } from "@/lib/image";

export interface PhotoDraft { prepared: PreparedPhoto | null; remove: boolean }
export const EMPTY_PHOTO: PhotoDraft = { prepared: null, remove: false };

/**
 * Photo picker for a menu item: drag and drop, file picker, camera (phones) with an instant preview.
 * It only prepares the file (validate + downscale); the dialog uploads it after the item is saved.
 */
export function PhotoField({ name, category, existingUrl, draft, onChange, uploading }: {
  name: string; category?: string | null; existingUrl: string | null; draft: PhotoDraft; onChange: (d: PhotoDraft) => void; uploading?: boolean;
}) {
  const notify = useNotify();
  const t = useMsg(ITEM_MSG);
  const pick = useRef<HTMLInputElement>(null);
  const cam = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const prepared = draft.prepared;

  useEffect(() => {
    if (!prepared) { void Promise.resolve().then(() => setPreview(null)); return; }
    const u = URL.createObjectURL(prepared.blob);
    void Promise.resolve().then(() => setPreview(u));
    return () => URL.revokeObjectURL(u);
  }, [prepared]);

  async function take(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(null);
    try { onChange({ prepared: await preparePhoto(file), remove: false }); }
    catch (e) { const m = e instanceof PhotoError ? e.message : t("cantUse"); setError(m); notify.error(m); }
    finally { setBusy(false); }
  }

  const shown = prepared ? preview : draft.remove ? null : existingUrl;
  const has = !!shown;
  const working = busy || uploading;

  return (
    <div>
      <span className="mb-1.5 block text-sm font-semibold text-fg">{t("photo")} <span className="font-normal text-fg-subtle">{t("optional")}</span></span>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void take(e.dataTransfer.files?.[0]); }}
        className={cn("relative overflow-hidden rounded-2xl border-2 border-dashed transition-colors", drag ? "border-primary bg-primary-soft" : has ? "border-transparent" : "border-border-strong bg-surface-2/50")}>
        {has ? (
          <FoodImage src={shown} name={name || "Item"} category={category} className="aspect-[4/3] w-full" />
        ) : (
          <div className="flex aspect-[16/9] flex-col items-center justify-center gap-1.5 px-4 text-center sm:aspect-[2/1]">
            <span className="grid size-11 place-items-center rounded-2xl bg-primary-soft text-primary-soft-fg"><ImagePlus aria-hidden className="size-5" /></span>
            <p className="text-sm font-semibold text-fg">{drag ? t("dropPhoto") : t("dragPhoto")}</p>
            <p className="text-xs text-fg-subtle">{t("photoTypes")}</p>
          </div>
        )}
        {working && (
          <div role="status" aria-label={uploading ? t("uploadingAria") : t("preparingAria")} className="absolute inset-0 grid place-items-center bg-surface/70">
            <span className="flex items-center gap-2 rounded-full bg-surface px-4 py-2 text-sm font-semibold text-fg shadow-pop"><Loader aria-hidden className="size-4 animate-spin" />{uploading ? t("uploadingText") : t("preparingText")}</span>
          </div>
        )}
        {prepared && !working && (
          <span className="absolute left-2 top-2 rounded-full bg-surface/90 px-2.5 py-1 text-xs font-semibold text-fg shadow-xs">{t("newPhoto", { size: mb(prepared.blob.size) })}</span>
        )}
      </div>

      <input ref={pick} type="file" aria-label={t("photoFile")} accept={PHOTO_TYPES.join(",")} className="sr-only" tabIndex={-1}
        onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ""; }} />
      <input ref={cam} type="file" aria-label={t("takeAPhotoAria")} accept="image/*" capture="environment" className="sr-only" tabIndex={-1}
        onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ""; }} />

      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" iconStart={has ? <RefreshCw /> : <Upload />} disabled={working} onClick={() => pick.current?.click()}>{has ? t("replacePhoto") : t("choosePhoto")}</Button>
        <span className="hidden pointer-coarse:inline-flex"><Button variant="secondary" size="sm" iconStart={<Camera />} disabled={working} onClick={() => cam.current?.click()}>{t("takePhoto")}</Button></span>
        {(prepared || (existingUrl && !draft.remove)) && (
          <Button variant="ghost" size="sm" iconStart={<Trash2 />} disabled={working}
            onClick={() => onChange(prepared ? { prepared: null, remove: false } : { prepared: null, remove: true })}>{prepared ? t("discardNew") : t("removePhoto")}</Button>
        )}
        {draft.remove && existingUrl && !prepared && (
          <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_PHOTO)}>{t("keepCurrent")}</Button>
        )}
      </div>
      {error && <p role="alert" className="mt-1.5 text-xs font-medium text-danger-fg">{error}</p>}
    </div>
  );
}
