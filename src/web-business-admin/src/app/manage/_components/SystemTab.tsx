"use client";

import { HeartPulse, ScrollText } from "lucide-react";
import { SegmentedControl } from "@/components/ui";
import { useMsg } from "@/lib/i18n";
import { AuditView } from "./AuditView";
import { SystemView } from "./SystemView";
import { useManage } from "./manage-context";
import { MANAGE_MSG } from "./shell-messages";

/** Advanced, rarely needed: who did what, and whether the books add up. */
export function SystemTab({ view }: { view?: string }) {
  const t = useMsg(MANAGE_MSG);
  const { goto } = useManage();
  const sub = view === "audit" ? "audit" : "health";
  return (
    <>
      <SegmentedControl label={t("sysSection")} className="mb-4" value={sub} onChange={(v) => goto("system", v === "audit" ? "audit" : undefined)}
        options={[{ value: "health", label: t("sysHealth"), icon: <HeartPulse /> }, { value: "audit", label: t("auditLog"), icon: <ScrollText /> }]} />
      {sub === "audit" ? <AuditView embedded /> : <SystemView embedded />}
    </>
  );
}
