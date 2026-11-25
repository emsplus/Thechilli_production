"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, FileUp, Loader, RefreshCw, ScanLine, Trash2, X } from "lucide-react";
import { motion } from "motion/react";
import { Button, IconButton, Notice } from "@chilli/ui";
import { Card, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { prepareScanPage } from "@/lib/image";
import type { Purchase } from "@/lib/types";
import { CameraCapture, canUseLiveCamera } from "./CameraCapture";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useOnline } from "@/lib/useOnline";

const ACCEPT = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
/** Same limits as POST /purchases/pages. */
export const MAX_PAGES = 10;
const MAX_TOTAL = 10 * 1024 * 1024;
const em = (e: unknown, fb: string) => (e instanceof ApiError ? (e.status === 0 ? "Could not reach the server. Check the connection and try again; your photos are still here." : e.message) : fb);

interface Page { id: number; blob: Blob; name: string; url: string }
type Busy = null | "file" | "photo" | "pages";

/**
 * Step 1 of the purchase flow: drop / choose a file (PDF or image, one invoice), or photograph a paper bill page by page
 * with the phone camera (Add page / Retake / Remove) and send all pages as ONE purchase. Needs the server: off when offline.
 */
export function InvoiceUpload({ onUploaded, setError }: { onUploaded: (p: Purchase) => Promise<void>; setError: (m: string | null) => void }) {
  const online = useOnline();
  const phone = useMediaQuery("(max-width: 639px), (pointer: coarse)"); // camera first on phones
  const [busy, setBusy] = useState<Busy>(null);
  const [drag, setDrag] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  const [live, setLive] = useState(false); // in-app camera open
  const fileInput = useRef<HTMLInputElement>(null);
  const camInput = useRef<HTMLInputElement>(null);
  const retakeAt = useRef<number | null>(null);
  const nextId = useRef(1);
  const urls = useRef(new Set<string>());

  useEffect(() => { const set = urls.current; return () => set.forEach((u) => URL.revokeObjectURL(u)); }, []);
  const drop = (u: string) => { URL.revokeObjectURL(u); urls.current.delete(u); };

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (!online) { setError("You are offline. Connect to the internet to upload an invoice."); return; }
    if (f.type && !ACCEPT.includes(f.type)) { setError("Upload a PDF, PNG, JPG or WebP file."); return; }
    if (f.size > 10 * 1024 * 1024) { setError("That file is over 10 MB. Upload a smaller photo or PDF."); return; }
    setBusy("file"); setError(null);
    try { const p = await api.uploadPurchase(f); await onUploaded(p); toast.message("Invoice uploaded. Reading it now…"); }
    catch (e) { setError(em(e, "Upload failed")); }
    finally { setBusy(null); }
  }

  /** A camera photo: shrink it in the browser, then add it as a new page or put it in place of the one being retaken. */
  async function onPhoto(f: File | undefined) {
    const at = retakeAt.current;
    retakeAt.current = null;
    if (!f) return;
    setBusy("photo"); setError(null);
    try {
      const prepared = await prepareScanPage(f);
      const url = URL.createObjectURL(prepared.blob);
      urls.current.add(url);
      const page: Page = { id: nextId.current++, blob: prepared.blob, name: prepared.name, url };
      setPages((ps) => {
        if (at !== null && ps[at]) { drop(ps[at].url); return ps.map((p, i) => (i === at ? page : p)); }
        return ps.length >= MAX_PAGES ? ps : [...ps, page];
      });
    } finally { setBusy(null); }
  }

  /** In-app camera first (works in the installed app); the system camera picker when the browser cannot open one. */
  const openCamera = (retake: number | null = null) => { retakeAt.current = retake; if (canUseLiveCamera()) setLive(true); else camInput.current?.click(); };
  const liveOverlay = live && (
    <CameraCapture onClose={() => { retakeAt.current = null; setLive(false); }}
      onFail={(why) => { setLive(false); setError(why); }}
      onCapture={(f) => { setLive(false); void onPhoto(f); }} />
  );
  const remove = (i: number) => setPages((ps) => { if (ps[i]) drop(ps[i].url); return ps.filter((_, j) => j !== i); });
  const discard = () => setPages((ps) => { ps.forEach((p) => drop(p.url)); return []; });
  const total = pages.reduce((s, p) => s + p.blob.size, 0);

  async function readInvoice() {
    if (!pages.length) return;
    if (total > MAX_TOTAL) { setError("These photos are over 10 MB together. Retake the largest pages or send fewer pages."); return; }
    setBusy("pages"); setError(null);
    try {
      const p = await api.uploadPurchasePages(pages);
      discard();
      await onUploaded(p);
      toast.message(`${pages.length === 1 ? "Bill" : `${pages.length}-page bill`} uploaded. Reading it now…`);
    } catch (e) { setError(em(e, "Upload failed")); }
    finally { setBusy(null); }
  }

  const camera = (
    <input ref={camInput} type="file" aria-label="Camera photo" accept="image/*" capture="environment" className="sr-only" tabIndex={-1}
      onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ""; }} />
  );
  const offline = !online && (
    <div className="mb-3 w-full text-left"><Notice tone="warning" title="You are offline">
      Scanning and uploading invoices need an internet connection. Connect, then try again.
    </Notice></div>
  );

  if (pages.length) {
    const uploading = busy === "pages";
    return (
      <Card className="mb-6" aria-label="Bill photos">
        {offline}
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold text-fg">Bill photos <span className="tnum font-normal text-fg-muted">· {pages.length} page{pages.length === 1 ? "" : "s"}</span></h2>
            <p className="text-sm text-fg-muted">One photo per page, flat and in good light. Add every page, then read the invoice.</p>
          </div>
          <IconButton label="Discard photos" icon={<X />} disabled={uploading} onClick={discard} />
        </div>
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label="Pages">
          {pages.map((p, i) => (
            <li key={p.id} className="overflow-hidden rounded-xl border border-border bg-surface-2">
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
                <img src={p.url} alt={`Page ${i + 1}`} className="aspect-[3/4] w-full object-cover" />
                <span className="tnum absolute left-2 top-2 rounded-full bg-surface/90 px-2 py-0.5 text-xs font-semibold text-fg shadow-xs">Page {i + 1}</span>
              </div>
              <div className="flex">
                <Button variant="ghost" className="min-w-0 flex-1 rounded-none px-2" iconStart={<RefreshCw />} disabled={uploading || !online} onClick={() => openCamera(i)} aria-label={`Retake page ${i + 1}`}>Retake</Button>
                <IconButton label={`Remove page ${i + 1}`} icon={<Trash2 />} className="rounded-none" disabled={uploading} onClick={() => remove(i)} />
              </div>
            </li>
          ))}
        </ol>
        {uploading && (
          <div role="status" className="mt-4 flex flex-col items-center gap-2 text-sm font-medium text-fg">
            <span className="flex items-center gap-2"><Loader aria-hidden className="size-4 animate-spin" />Uploading {pages.length} page{pages.length === 1 ? "" : "s"} ({(total / 1024 / 1024).toFixed(1)} MB)…</span>
            <div className="h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-surface-3"><motion.div className="h-full w-1/3 rounded-full bg-primary" animate={{ x: ["-100%", "300%"] }} transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }} /></div>
          </div>
        )}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" iconStart={<Camera />} disabled={uploading || !online || pages.length >= MAX_PAGES || busy === "photo"} onClick={() => openCamera()}>Add page</Button>
          <Button variant="primary" size="lg" iconStart={<ScanLine />} loading={uploading} disabled={!online || busy === "photo"} onClick={() => void readInvoice()}>Read invoice</Button>
        </div>
        {pages.length >= MAX_PAGES && <p className="mt-2 text-xs text-fg-subtle">That is the most pages one bill can have ({MAX_PAGES}).</p>}
        {camera}{liveOverlay}
      </Card>
    );
  }

  const scanBtn = <Button key="scan" variant={phone ? "primary" : "secondary"} size={phone ? "lg" : "md"} iconStart={<Camera />} disabled={!!busy || !online} onClick={() => openCamera()} className="max-sm:w-full">Scan with camera</Button>;
  const fileBtn = <Button key="file" variant={phone ? "secondary" : "primary"} iconStart={<FileUp />} disabled={!!busy || !online} onClick={() => fileInput.current?.click()} className="max-sm:w-full">Choose file</Button>;
  return (
    <Card className="mb-6 p-0 sm:p-0">
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void onFile(e.dataTransfer.files?.[0]); }}
        className={cn("flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors sm:py-10", drag ? "border-primary bg-primary-soft" : "border-border-strong bg-surface")}>
        {offline}
        <span className="grid size-14 place-items-center rounded-2xl bg-primary-soft text-primary-soft-fg">
          {busy ? <Loader className="size-7 animate-spin" aria-hidden /> : phone ? <Camera className="size-7" aria-hidden /> : <FileUp className="size-7" aria-hidden />}
        </span>
        <div aria-live="polite">
          <p className="font-display text-lg font-semibold text-fg">{busy === "file" ? "Uploading invoice…" : busy === "photo" ? "Preparing photo…" : drag ? "Drop to upload" : phone ? "Scan a supplier bill" : "Drop a supplier invoice here"}</p>
          <p className="mt-0.5 text-sm text-fg-muted">{phone ? "Photograph the bill page by page, or choose a PDF or photo (up to 10 MB)." : "PDF, PNG, JPG or WebP up to 10 MB, or photograph a paper bill page by page."} We read it automatically; you review before anything changes.</p>
        </div>
        {busy === "file" && <div className="h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-surface-3"><motion.div className="h-full w-1/3 rounded-full bg-primary" animate={{ x: ["-100%", "300%"] }} transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }} /></div>}
        <input ref={fileInput} type="file" aria-label="Invoice file" accept={ACCEPT.join(",")} className="sr-only" tabIndex={-1} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
        {camera}{liveOverlay}
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-center">{phone ? [scanBtn, fileBtn] : [fileBtn, scanBtn]}</div>
      </div>
    </Card>
  );
}
