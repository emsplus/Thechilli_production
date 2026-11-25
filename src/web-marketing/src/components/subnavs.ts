import { can } from "@/lib/roles";
import type { Role } from "@/lib/api/types";

export const ONBOARDING_NAV = [
  { href: "/onboarding", label: "Applications" }, { href: "/onboarding/invitations", label: "Invitations" },
];
export const leadsNav = (role: Role | undefined) => [
  { href: "/leads", label: "Directory" }, { href: "/leads/pipeline", label: "Pipeline" },
  ...(can(role, "lead.write") ? [{ href: "/leads/duplicates", label: "Duplicates" }] : []),
  { href: "/demos", label: "Demos" },
];

export const earningsNav = (role: Role | undefined) => [
  { href: "/earnings", label: "Commission" },
  ...(can(role, "referral.manage") ? [{ href: "/earnings/referrals", label: "Referral codes" }] : []),
  ...(can(role, "commission.rules") ? [{ href: "/earnings/rules", label: "Rules" }] : []),
  { href: "/reports", label: "Reports" },
];
export const TEAM_NAV = [
  { href: "/team", label: "Users" }, { href: "/team/performance", label: "Performance" }, { href: "/team/audit", label: "Audit log" },
];
