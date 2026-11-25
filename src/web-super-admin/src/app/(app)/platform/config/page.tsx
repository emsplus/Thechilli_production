"use client";
import { useState, type FormEvent } from "react";
import { Button, Dialog, Input, Table, useToast } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import type { ConfigEntry } from "@/lib/api/types";
import { fmtDateTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { useAction, useResource } from "@/lib/useResource";
import { InlineError, Notice, PageHeader, ReasonDialog, ResourceView, TextArea } from "@/components/ui";

const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v));

export default function ConfigPage() {
  const can = useCan();
  const toast = useToast();
  const res = useResource(() => api.config.list(), "config");
  const [edit, setEdit] = useState<ConfigEntry | "new" | null>(null);
  const [del, setDel] = useState<ConfigEntry | null>(null);
  const write = can("config.write");
  return (
    <>
      <PageHeader title="Global config" subtitle="Platform-wide switches and limits. Not for secrets: secret-looking names are refused." actions={write ? <Button variant="primary" onClick={() => setEdit("new")}>Add setting</Button> : undefined} />
      {!write ? <Notice>You can read these settings. Only a super admin can change them.</Notice> : null}
      <ResourceView res={res} isEmpty={(d) => d.items.length === 0} empty={{ title: "No settings yet", description: "Settings you add show up here.", actionLabel: write ? "Add setting" : undefined, onAction: () => setEdit("new") }}>
        {(d) => (
          <Table<ConfigEntry> caption="Global settings" getKey={(c) => c.key} rows={d.items} columns={[
            { key: "k", header: "Key", render: (c) => <span className="hq-mono">{c.key}</span> }, { key: "v", header: "Value", render: (c) => <span className="hq-mono">{show(c.value)}</span> },
            { key: "d", header: "Description", render: (c) => c.description ?? "–" }, { key: "u", header: "Updated", render: (c) => `${fmtDateTime(c.updated_at)} by ${c.updated_by ?? "–"}` },
            { key: "a", header: "Actions", render: (c) => (write ? <div className="hq-row"><Button size="sm" onClick={() => setEdit(c)}>Edit</Button><Button size="sm" variant="danger-soft" onClick={() => setDel(c)}>Delete</Button></div> : null) },
          ]} />
        )}
      </ResourceView>
      {edit ? <EditConfig entry={edit === "new" ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); toast.show("Setting saved", "success"); res.reload(); }} /> : null}
      {del ? <ReasonDialog open onOpenChange={(o) => !o && setDel(null)} title="Delete setting" description={`Remove ${del.key}? Services reading it fall back to their defaults. The deletion and the old value are recorded in the audit log.`} confirmLabel="Delete setting" askReason={false}
        onConfirm={async (): Promise<ApiError | undefined> => { try { await api.config.remove(del.key); toast.show("Setting deleted", "success"); res.reload(); } catch (e) { return e as ApiError; } }} /> : null}
    </>
  );
}

function EditConfig({ entry, onClose, onDone }: { entry: ConfigEntry | null; onClose: () => void; onDone: () => void }) {
  const [key, setKey] = useState(entry?.key ?? "");
  const [value, setValue] = useState(entry ? show(entry.value) : "");
  const [desc, setDesc] = useState(entry?.description ?? "");
  const [touched, setTouched] = useState(false);
  let parsed: unknown; let jsonOk = true;
  try { parsed = JSON.parse(value); } catch { jsonOk = false; }
  const keyOk = /^[a-z][a-z0-9_.]{1,99}$/.test(key);
  const { run, busy, error } = useAction(async () => { await api.config.set(key, { value: parsed, description: desc || undefined }); onDone(); });
  const submit = (e: FormEvent) => { e.preventDefault(); setTouched(true); if (keyOk && jsonOk) void run(); };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={entry ? `Edit ${entry.key}` : "Add setting"} description="The change is audited and takes effect for services on their next read."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="cfg" loading={busy}>Save</Button></>}>
      <form id="cfg" className="hq-stack" onSubmit={submit} noValidate>
        <Input label="Key" value={key} disabled={!!entry} onChange={(e) => setKey(e.target.value)} hint="Lowercase, dots and underscores, e.g. limits.max_outlets_trial" error={touched && !keyOk ? "Use lowercase letters, digits, dots or underscores (2-100 characters)." : undefined} />
        <TextArea label="Value (JSON)" value={value} onChange={setValue} hint={'Text needs quotes: "hello". Numbers and true/false do not.'} error={touched && !jsonOk ? "That is not valid JSON." : undefined} />
        <Input label="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <InlineError error={error} />
      </form>
    </Dialog>
  );
}
