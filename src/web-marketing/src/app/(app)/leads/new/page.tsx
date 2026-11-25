"use client";
import { PageHeader } from "@chilli/ui";
import { LeadForm } from "@/components/lead-form";
import { NoAccess } from "@/components/ui";
import { useAuth } from "@/components/auth";
import { can } from "@/lib/roles";

export default function NewLeadPage() {
  const { user } = useAuth();
  if (!can(user?.role, "lead.write")) return <NoAccess role={user?.role} what="Adding a lead" needs="salespeople and marketing admins" />;
  return (<div className="stack"><PageHeader title="Add lead" description="Four fields are enough. We check for duplicates as you type." /><LeadForm /></div>);
}
