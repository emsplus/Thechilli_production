import { redirect } from "next/navigation";

/**
 * The Today page was folded into Manage > Overview (the "Today" strip near the top) at the owner's request: the sidebar no
 * longer lists it. Old links and bookmarks still work.
 */
export default function TodayPage() {
  redirect("/manage");
}
