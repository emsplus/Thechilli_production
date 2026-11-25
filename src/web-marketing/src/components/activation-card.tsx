"use client";
import { Badge, Button, Card, Notice, useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import { AsyncView, FormError } from "./ui";
import { useAction, useQuery } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";

const PLATFORM: Record<string, string> = { received: "Received by platform", under_review: "Under review", approved: "Approved", provisioning: "Setting up", provisioned: "Live", failed: "Setup failed", rejected: "Rejected" };
const BILLING: Record<string, string> = { trialing: "On free trial", active: "Paying", past_due: "Payment overdue", cancelled: "Cancelled", expired: "Expired" };
const platformTone = (s: string | null) => (s === "provisioned" ? "success" : s === "failed" || s === "rejected" ? "danger" : s ? "info" : "neutral") as "success" | "danger" | "info" | "neutral";
const billingTone = (s: string | null) => (s === "active" ? "success" : s === "past_due" || s === "cancelled" || s === "expired" ? "danger" : s ? "info" : "neutral") as "success" | "danger" | "info" | "neutral";

/** Activation and payment state as last reported by the platform. Refresh asks the platform again. */
export function ActivationCard({ appId, canRefresh }: { appId: string; canRefresh: boolean }) {
  const toast = useToast();
  const q = useQuery(`activation:${appId}`, () => api.onboarding.activation(appId));
  const act = useAction();
  async function refresh() {
    if (await act.run(() => api.onboarding.refreshActivation(appId))) { toast.show("Status updated", "success"); q.reload(); }
  }
  return (
    <Card as="section" aria-labelledby="act">
      <div className="between"><h2 id="act">Activation and payment</h2>{canRefresh && <Button size="sm" loading={act.busy} onClick={refresh}>Refresh status</Button>}</div>
      <FormError error={act.error} />
      <AsyncView q={q} rows={1}>
        {(a) => !a.external_business_id
          ? <p className="muted" style={{ marginTop: 12 }}>Not submitted to the platform yet. Provision the business first.</p>
          : (
            <div className="stack-sm" style={{ marginTop: 12 }}>
              <div className="row"><span className="muted">Platform</span><Badge tone={platformTone(a.platform_status)}>{a.platform_status ? PLATFORM[a.platform_status] ?? a.platform_status : "Unknown"}</Badge>
                <span className="muted">Subscription</span><Badge tone={billingTone(a.billing_status)}>{a.billing_status ? BILLING[a.billing_status] ?? a.billing_status : "None yet"}</Badge></div>
              {a.paying ? <Notice tone="success">Activated and paying.</Notice>
                : a.activated ? <Notice tone="success">Live on a free trial. Counts as paying after the first real bill.</Notice>
                : <Notice tone="info">Not live yet. Refresh to check the platform.</Notice>}
              <p className="small muted">{a.status_checked_at ? `Checked ${fmtDateTime(a.status_checked_at)}` : "Never checked"} · reference <span className="mono">{a.external_business_id}</span></p>
            </div>
          )}
      </AsyncView>
    </Card>
  );
}
