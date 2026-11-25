"use client";
import { useState } from "react";
import { Button, Dialog, RadioGroup, useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import { FormError } from "./ui";
import { STAGE_LABEL } from "@/lib/pipeline";
import { useAction, useQuery } from "@/lib/hooks";
import { usePeople } from "@/lib/people";
import type { LeadOut } from "@/lib/api/types";

/** Fold a duplicate into this lead. Candidates are leads sharing this lead's phone or email. History moves here, the duplicate is removed. */
export function MergeLeadDialog({ lead, open, onOpenChange, onMerged }: { lead: LeadOut; open: boolean; onOpenChange: (o: boolean) => void; onMerged: () => void }) {
  const toast = useToast();
  const { name } = usePeople();
  const [pick, setPick] = useState<string | null>(null);
  const act = useAction();
  const cands = useQuery(`merge-cands:${lead.id}:${open}`, async () => {
    if (!open || (!lead.phone && !lead.email)) return [];
    return (await api.leads.duplicates({ phone: lead.phone ?? undefined, email: lead.email ?? undefined })).filter((d) => d.id !== lead.id);
  });
  async function merge() {
    if (!pick) return;
    if (await act.run(() => api.leads.merge(lead.id, pick))) { toast.show("Leads merged", "success"); onOpenChange(false); onMerged(); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Merge a duplicate into this lead"
      description="Activities, demos, applications and invitations move to this lead. Empty fields are filled from the duplicate, which is then removed. This cannot be undone."
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="danger-soft" disabled={!pick} loading={act.busy} onClick={merge}>Merge into {lead.business_name}</Button></>}>
      <FormError error={act.error} />
      {cands.loading ? <p className="muted">Looking for duplicates...</p>
        : !cands.data?.length ? <p className="muted">No other lead shares this phone or email.</p>
        : (
          <RadioGroup legend="Duplicate to merge" name="dup" value={pick ?? undefined} onValueChange={setPick} options={cands.data.map((d) => ({ value: d.id, label: `${d.business_name} (${STAGE_LABEL[d.stage]}), owner ${name(d.owner_id)}` }))} />
        )}
    </Dialog>
  );
}
