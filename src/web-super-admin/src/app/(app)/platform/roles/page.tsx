"use client";
import { Table } from "@chilli/ui";
import { api } from "@/lib/api";
import { ROLES, type Permission, type Role } from "@/lib/api/types";
import { ROLE_LABEL } from "@/lib/permissions";
import { useResource } from "@/lib/useResource";
import { PageHeader, ResourceView } from "@/components/ui";

export default function RolesPage() {
  const res = useResource(() => api.staff.roles(), "roles");
  return (
    <>
      <PageHeader title="Roles & permissions" subtitle="What each role can do. Roles are fixed; permissions are checked on every request." />
      <ResourceView res={res} isEmpty={(d) => Object.keys(d).length === 0} empty={{ title: "No roles returned" }}>
        {(d) => {
          const perms = [...new Set(ROLES.flatMap((r) => d[r] ?? []))].sort();
          return (
            <div className="hq-matrix">
              <Table<Permission> caption="Role permission matrix" getKey={(p) => p} rows={perms} columns={[
                { key: "p", header: "Permission", render: (p) => <span className="hq-mono">{p}</span> },
                ...ROLES.map((r: Role) => ({ key: r, header: ROLE_LABEL[r], render: (p: Permission) => ((d[r] ?? []).includes(p) ? <span aria-label="Allowed">Yes</span> : <span className="hq-muted" aria-label="Not allowed">–</span>) })),
              ]} />
            </div>
          );
        }}
      </ResourceView>
    </>
  );
}
