import { Suspense } from "react";
import type { Metadata } from "next";
import { InventoryHub } from "./_components/InventoryHub";
import { HubFallback } from "./_components/HubFallback";

export const metadata: Metadata = { title: "Procurement and stock" };

export default function InventoryPage() {
  return <Suspense fallback={<HubFallback />}><InventoryHub /></Suspense>;
}
