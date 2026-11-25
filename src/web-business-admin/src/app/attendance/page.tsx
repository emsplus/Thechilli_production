import { redirect } from "next/navigation";

/** Kept for old links: this screen lives inside Manage now (the original Karahi layout). */
export default function Page() {
  redirect("/manage?tab=staff&view=attendance");
}
