"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

export const TOPBAR_SLOT_ID = "topbar-slot";
const noop = () => () => {};

/**
 * Render page-specific controls into the shell's top bar (right side, before the sync status):
 *   <TopBarSlot><Button size="sm">New order</Button></TopBarSlot>
 */
export function TopBarSlot({ children }: { children: React.ReactNode }) {
  const el = useSyncExternalStore(noop, () => document.getElementById(TOPBAR_SLOT_ID), () => null);
  return el ? createPortal(children, el) : null;
}
