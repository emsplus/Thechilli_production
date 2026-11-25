import { Badge } from "@chilli/ui";
import type { InvitationOut } from "@/lib/api/types";

export function invitationState(i: InvitationOut, now = Date.now()): "Accepted" | "Revoked" | "Expired" | "Sent" {
  if (i.used_at) return "Accepted";
  if (i.revoked_at) return "Revoked";
  if (new Date(i.expires_at).getTime() < now) return "Expired";
  return "Sent";
}

/** The API tracks sent / accepted / revoked / expired. "Opened" is not tracked by the backend. */
export function InvitationStatus({ inv }: { inv: InvitationOut }) {
  const s = invitationState(inv);
  return <Badge tone={s === "Accepted" ? "success" : s === "Sent" ? "info" : s === "Revoked" ? "danger" : "neutral"}>{s}</Badge>;
}
