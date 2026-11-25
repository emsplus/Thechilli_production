"use client";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { LeadForm } from "@/components/lead-form";
import { PageHeader } from "@chilli/ui";
import { AsyncView, NoAccess } from "@/components/ui";
import { useAuth } from "@/components/auth";
import { can } from "@/lib/roles";
import { useQuery } from "@/lib/hooks";

export default function EditLeadPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const allowed = can(user?.role, "lead.write");
  const q = useQuery(`lead:${id}:${allowed}`, () => (allowed ? api.leads.get(id) : Promise.reject(new Error("no access"))));
  if (!allowed) return <NoAccess role={user?.role} what="Editing a lead" needs="salespeople and marketing admins" />;
  return (
    <div className="stack">
      <PageHeader title="Edit lead" />
      <AsyncView q={q} rows={4}>{(lead) => <LeadForm lead={lead} />}</AsyncView>
    </div>
  );
}
