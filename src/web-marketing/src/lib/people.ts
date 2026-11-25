"use client";
import { api } from "./api";
import type { UserOut } from "./api/types";
import { useAuth } from "@/components/auth";
import { useQuery } from "./hooks";

/** Names for owner/assignee ids. Only admins can list users (server rule); others see "You" or "Teammate". */
export function usePeople() {
  const { user } = useAuth();
  const isAdmin = user?.role === "marketing_admin";
  const q = useQuery<UserOut[]>(`users:${isAdmin}`, () => (isAdmin ? api.users.list() : Promise.resolve([])));
  const users = q.data ?? [];
  const name = (id: string | null | undefined): string => {
    if (!id) return "Unassigned";
    if (id === user?.id) return "You";
    return users.find((u) => u.id === id)?.name ?? "Teammate";
  };
  return { users, name, loading: q.loading };
}
