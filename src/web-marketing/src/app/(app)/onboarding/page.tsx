"use client";
import Link from "next/link";
import { FilterBar } from "@chilli/ui/data";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Select, PageHeader } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AppStatusBadge, AsyncView, SubNav } from "@/components/ui";
import { ONBOARDING_NAV } from "@/components/subnavs";
import { useQuery } from "@/lib/hooks";
import { usePeople } from "@/lib/people";
import { can } from "@/lib/roles";
import { fmtDate, fmtMoney } from "@/lib/format";
import type { AppSource, AppStatus } from "@/lib/api/types";

export default function OnboardingPage() {
  const { user } = useAuth();
  const { name } = usePeople();
  const router = useRouter();
  const [status, setStatus] = useState<AppStatus | "">("");
  const [source, setSource] = useState<AppSource | "">("");
  const q = useQuery(`apps:${status}`, () => api.onboarding.list({ status: status || undefined, limit: 200 }));
  return (
    <div className="stack">
      <PageHeader title="Onboarding" description="Get each business to its first real bill." actions={<>{can(user?.role, "onboarding.create") && <Link href="/onboarding/new"><Button variant="primary">+ Application</Button></Link>}</>} />
      <SubNav items={ONBOARDING_NAV} />
      <FilterBar>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as AppStatus | "")}>
          <option value="">All</option><option value="draft">Draft</option><option value="in_progress">In progress</option><option value="ready">Ready</option><option value="provisioned">Provisioned</option><option value="cancelled">Cancelled</option>
        </Select>
        <Select label="Source" value={source} onChange={(e) => setSource(e.target.value as AppSource | "")}>
          <option value="">Assisted and self-signup</option><option value="assisted">Assisted by an agent</option><option value="self_signup">Self-signup tracking</option>
        </Select>
      </FilterBar>
      <AsyncView q={q} isEmpty={(d) => d.filter((a) => !source || a.source === source).length === 0}
        empty={{ title: "No applications", description: user?.role === "salesperson" ? "Applications for your leads appear here once started." : "Start an application from a lead after the demo.", ...(can(user?.role, "onboarding.create") ? { actionLabel: "New application", onAction: () => router.push("/onboarding/new") } : {}) }}>
        {(apps) => (
          <ul className="list">
            {apps.filter((a) => !source || a.source === source).map((a) => (
              <li key={a.id}>
                <span className="grow">
                  <Link href={`/onboarding/${a.id}`} className="title">{a.business_name}</Link><br />
                  <span className="small muted">{a.source === "self_signup" ? "Self-signup" : `Agent: ${name(a.agent_id)}`} · started {fmtDate(a.created_at)}{a.contract_value_minor > 0 ? ` · ${fmtMoney(a.contract_value_minor, a.currency)}` : ""}</span>
                </span>
                <AppStatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </div>
  );
}
