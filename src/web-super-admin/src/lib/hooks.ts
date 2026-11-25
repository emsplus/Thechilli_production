"use client";
import { useMemo } from "react";
import { api } from "./api";
import type { Tenant } from "./api/types";
import { useResource } from "./useResource";
import { useSession } from "./session";

/** id -> tenant for display names in lists that only carry tenant ids (invoices, payments, tickets, logs). */
export function useTenants() {
  const { perms } = useSession();
  const res = useResource(() => api.tenants.list({ limit: 200 }), "tenants-all", perms.has("tenants.read"));
  const byId = useMemo(() => new Map<string, Tenant>((res.data?.items ?? []).map((t) => [t.id, t])), [res.data]);
  const nameOf = (id: string | null | undefined) => (id ? byId.get(id)?.display_name ?? id.slice(0, 8) : "–");
  return { ...res, tenants: res.data?.items ?? [], byId, nameOf };
}
