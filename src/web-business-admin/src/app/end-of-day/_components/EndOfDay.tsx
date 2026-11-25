"use client";

import { Notice, PageHeader, Skeleton } from "@chilli/ui";
import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Lock, WifiOff } from "lucide-react";
import { Card, EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { auth } from "@/lib/api";
import { useTaxConfig } from "@/lib/taxConfig";
import { isAdminRole, useRole } from "@/lib/useRole";
import { ShiftOpenBanner } from "@/components/shell/shift-banner";
import { TodayView } from "./TodayView";
import { ZDetail, ZHistory } from "./History";

const subscribe = (cb: () => void) => {
  window.addEventListener("online", cb); window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
};
const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
const FALLBACK_TZ = "Asia/Kolkata"; // India only: the restaurant zone until it is known

export function EndOfDayFallback() {
  return <div role="status" aria-label="Loading"><Skeleton className="mb-5 h-10 w-56" /><Skeleton className="h-96 rounded-2xl" /></div>;
}

function Blocked() {
  return (
    <Card className="mx-auto mt-6 max-w-lg">
      <EmptyState icon={<Lock />} title="Ask the owner or manager"
        hint="Closing the day and reading the Z-report is for owners and managers. You can keep taking orders from Chilli Agent."
        action={<Link href="/pos" className="inline-flex h-11 items-center rounded-xl bg-primary bg-primary-gradient px-5 text-sm font-semibold text-primary-fg shadow-[var(--shadow-inset-hi),var(--shadow-glow)]">Back to Chilli Agent</Link>} />
    </Card>
  );
}

export function EndOfDay() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const role = useRole();
  const online = useOnline();
  const cfg = useTaxConfig();
  const zId = params.get("z");
  const tab = params.get("tab") === "history" ? "history" : "today";

  useEffect(() => { if (!auth.token) router.replace("/login"); }, [router]);

  if (role === null) return <EndOfDayFallback />;
  if (!isAdminRole(role)) return <Blocked />;

  return (
    <>
      <PageHeader title="End of day"
        description={zId ? "A closed day, exactly as it was saved" : "See the day so far, close it and print the Z-report, or look back at earlier days"} />
      <div className="mb-4 empty:hidden"><ShiftOpenBanner /></div>
      {!online ? (
        <Notice tone="warning" title="You are offline" className="mb-4">
          <span className="flex items-start gap-2"><WifiOff aria-hidden className="mt-0.5 size-4 shrink-0" /><span>End-of-day reports need a connection, so no numbers are shown rather than old ones. Reconnect to see today so far or to close the day.</span></span>
        </Notice>
      ) : zId ? <ZDetail id={zId} /> : (
        <Tabs value={tab} onValueChange={(v) => router.push(v === "history" ? `${pathname}?tab=history` : pathname)}>
          <TabsList className="mb-4">
            <TabsTrigger value="today">Today so far</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="today"><TodayView /></TabsContent>
          <TabsContent value="history"><ZHistory currency={cfg?.currency ?? ""} timezone={cfg?.timezone ?? FALLBACK_TZ} /></TabsContent>
        </Tabs>
      )}
    </>
  );
}
