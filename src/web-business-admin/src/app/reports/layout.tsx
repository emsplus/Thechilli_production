import type { ReactNode } from "react";
import { ManageFrame } from "@/components/shell/manage-nav";

/** Reports, Cash drawer, End of day, Reservations and Customers are listed inside Manage: the same inner navigation beside the screen (its URL is unchanged). */
export default function Layout({ children }: { children: ReactNode }) {
  return <ManageFrame>{children}</ManageFrame>;
}
