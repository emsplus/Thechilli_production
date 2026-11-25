"use client";

import { formatDate } from "@/lib/datetime";
import { Button } from "@chilli/ui";
import { useState } from "react";
import { FileText } from "lucide-react";
import { toast } from "@/components/ui";
import { api } from "@/lib/api";
import { pdfError, savePdf } from "@/lib/pdfSave";
import type { ChatAttachment } from "@/lib/types";

const day = (iso: string) => formatDate(iso);
const period = (a: ChatAttachment) => (a.from === a.to ? day(a.from) : `${day(a.from)} to ${day(a.to)}`);

function Attachment({ att }: { att: ChatAttachment }) {
  const [busy, setBusy] = useState(false);
  async function get() {
    if (busy) return;
    setBusy(true);
    try { savePdf(await api.attachmentBlob(att), att.filename); }
    catch (e) { toast.error(pdfError(e)); }
    finally { setBusy(false); }
  }
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-soft-fg"><FileText className="size-[1.1rem]" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-fg">{att.title}</span>
        <span className="block truncate text-xs text-fg-muted">{period(att)}</span>
      </span>
      <Button size="sm" variant="secondary" loading={busy} onClick={() => void get()} aria-label={`Download PDF: ${att.title}`}>Download PDF</Button>
    </li>
  );
}

/** PDFs the assistant prepared, one row each. Fetched with the session when tapped (the url is not a public link). */
export function Attachments({ items }: { items: ChatAttachment[] }) {
  if (!items.length) return null;
  return <ul className="mt-2 space-y-2 text-left" aria-label="PDF reports">{items.map((a) => <Attachment key={a.url} att={a} />)}</ul>;
}
