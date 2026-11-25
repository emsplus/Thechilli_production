"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAiDrawer } from "@/components/shell/ai-drawer";

/** The assistant lives in a side panel now; an old /ai link or bookmark opens it over the POS. */
export default function AiPage() {
  const router = useRouter();
  const { setOpen } = useAiDrawer();
  useEffect(() => { setOpen(true); router.replace("/pos"); }, [router, setOpen]);
  return null;
}
