"use client";
import { useRef, useState } from "react";
import { Badge, Button, Card, Notice, Select, useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import { AsyncView, FormError } from "./ui";
import { useAction, useQuery } from "@/lib/hooks";
import type { DocType, DocumentOut } from "@/lib/api/types";

export const DOC_LABEL: Record<DocType, string> = { trade_licence: "Trade licence", owner_id: "Owner ID", tax_certificate: "GST certificate", other: "Other" };
export const MAX_DOC_BYTES = 5 * 1024 * 1024;
const ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";
const EXT = /\.(pdf|png|jpe?g)$/i;

/** Client-side pre-check so the user gets instant feedback; the server re-validates type by content and size. */
export function checkFile(f: { name: string; size: number }): string | null {
  if (f.size === 0) return "That file is empty.";
  if (f.size > MAX_DOC_BYTES) return "That file is over 5 MB.";
  if (!EXT.test(f.name)) return "Only PDF, PNG or JPEG files are accepted.";
  return null;
}
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const TONE = { received: "info", verified: "success", rejected: "danger" } as const;

export function DocumentsCard({ appId, canEdit, canDecide, onChange }: { appId: string; canEdit: boolean; canDecide: boolean; onChange?: () => void }) {
  const toast = useToast();
  const q = useQuery(`docs:${appId}`, () => api.onboarding.documents(appId));
  const [type, setType] = useState<DocType>("trade_licence");
  const [local, setLocal] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const act = useAction();

  async function pick(file: File | undefined) {
    if (!file) return;
    const bad = checkFile(file);
    setLocal(bad);
    if (bad) return;
    if (await act.run(() => api.onboarding.uploadDocument(appId, type, { name: file.name, type: file.type, data: file }))) {
      toast.show("Document uploaded", "success"); q.reload(); onChange?.();
    }
    if (input.current) input.current.value = "";
  }
  async function decide(d: DocumentOut, s: "verified" | "rejected") {
    if (await act.run(() => api.onboarding.decideDocument(appId, d.id, s))) { toast.show(`Marked ${s}`, "success"); q.reload(); onChange?.(); }
  }
  async function remove(d: DocumentOut) {
    if (await act.run(() => api.onboarding.deleteDocument(appId, d.id))) { toast.show("Document removed", "success"); q.reload(); onChange?.(); }
  }
  async function open(d: DocumentOut) {
    const blob = await act.run(() => api.onboarding.documentContent(appId, d.id));
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = d.filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <Card as="section" aria-labelledby="docs">
      <h2 id="docs">Documents</h2>
      <p className="small muted">A trade licence and the owner ID must both be verified by a marketing admin. PDF, PNG or JPEG, up to 5 MB.</p>
      <FormError error={act.error} />
      {local && <Notice tone="danger">{local}</Notice>}
      <AsyncView q={q} rows={2} isEmpty={(d) => d.length === 0} empty={{ title: "No documents yet", description: canEdit ? "Choose a type and upload the file." : undefined }}>
        {(rows) => (
          <ul className="list">
            {rows.map((d) => (
              <li key={d.id}>
                <span className="grow"><span className="title">{DOC_LABEL[d.doc_type]}</span><br /><span className="small muted">{d.filename} · {kb(d.size_bytes)}</span></span>
                <Badge tone={TONE[d.status]}>{d.status}</Badge>
                <span className="row">
                  <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => open(d)}>Download</Button>
                  {canDecide && d.status !== "verified" && <Button size="sm" disabled={act.busy} onClick={() => decide(d, "verified")}>Verify</Button>}
                  {canDecide && d.status !== "rejected" && <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => decide(d, "rejected")}>Reject</Button>}
                  {canEdit && <Button size="sm" variant="danger-soft" disabled={act.busy} onClick={() => remove(d)}>Remove</Button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
      {canEdit && (
        <div className="grid form" style={{ marginTop: 12, alignItems: "end" }}>
          <Select label="Document type" value={type} onChange={(e) => setType(e.target.value as DocType)}>{(Object.keys(DOC_LABEL) as DocType[]).map((t) => <option key={t} value={t}>{DOC_LABEL[t]}</option>)}</Select>
          <div>
            <input ref={input} type="file" accept={ACCEPT} hidden aria-label="Choose a file" onChange={(e) => void pick(e.target.files?.[0])} />
            <Button variant="primary" loading={act.busy} onClick={() => input.current?.click()}>Upload file</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
