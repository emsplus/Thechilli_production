"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Skeleton, SkeletonGroup } from "@chilli/ui";
import { CustomersView } from "@/components/customers/CustomersView";
import { api, auth } from "@/lib/api";

/** Cashiers and waiters keep this page; owners and managers are sent to Manage -> Customers (same screen, one home). */
export default function CustomersPage() {
  const router = useRouter();
  const [staff, setStaff] = useState(false);
  useEffect(() => {
    if (!auth.token) { router.replace("/login"); return; }
    api.me().then((m) => { if (m.role === "owner" || m.role === "manager") router.replace("/manage?tab=customers"); else setStaff(true); }).catch(() => setStaff(true));
  }, [router]);
  if (!staff) return <SkeletonGroup><div className="space-y-3"><Skeleton width={256} height={48} /><Skeleton height={144} /></div></SkeletonGroup>;
  return <CustomersView />;
}
