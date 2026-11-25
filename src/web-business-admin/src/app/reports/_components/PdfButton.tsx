"use client";

import { Button } from "@chilli/ui";
import { useState } from "react";
import { FileText } from "lucide-react";
import { toast } from "@/components/ui";
import { api } from "@/lib/api";
import { pdfError, savePdf } from "@/lib/pdfSave";
import type { ReportPdfKind } from "@/lib/types";

const slug = (kind: ReportPdfKind) => kind.replace(/_/g, "-");

/** Downloads the A4 PDF of one report kind for the given range (fetched with the session, then saved / opened as a blob). */
export function PdfButton({ kind, from, to, label = "Download PDF", disabled }: { kind: ReportPdfKind; from: string; to: string; label?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { savePdf(await api.reportPdfBlob(kind, from, to), `${slug(kind)}_${from}_${to}.pdf`); }
    catch (e) { toast.error(pdfError(e)); }
    finally { setBusy(false); }
  }
  return <Button size="sm" variant="secondary" iconStart={<FileText />} loading={busy} disabled={disabled || !from || !to} onClick={() => void go()} data-testid={`pdf-${slug(kind)}`}>{label}</Button>;
}
