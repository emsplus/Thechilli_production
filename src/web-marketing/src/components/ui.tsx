"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Badge, EmptyState, Notice, ErrorState, Skeleton, SkeletonGroup, type BadgeTone } from "@chilli/ui";
import type { QueryResult } from "@/lib/hooks";
import type { ApiError } from "@/lib/api";
import type { Role, AppStatus, CampaignStatus, DemoStatus, EntryStatus, LeadStage } from "@/lib/api/types";
import { STAGE_LABEL } from "@/lib/pipeline";
import { ROLE_LABEL } from "@/lib/roles";

/** "in_progress" -> "In progress": status values shown as words, not codes. */
export const statusLabel = (s: string) => { const t = s.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

export function errorText(e: ApiError): { title: string; description: string } {
  if (e.isNetwork) return { title: "Cannot reach the server", description: "Check your connection, then retry." };
  if (e.status === 403) return { title: "Not available for your role", description: "Ask a marketing admin if you need access." };
  if (e.status === 404) return { title: "Not found", description: "It may have been removed, or it is not assigned to you." };
  return { title: "Could not load this", description: e.message };
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <SkeletonGroup>
      <div className="stack-sm">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} height={52} />)}</div>
    </SkeletonGroup>
  );
}

interface AsyncProps<T> {
  q: QueryResult<T>;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: { title: string; description?: string; actionLabel?: string; onAction?: () => void };
  rows?: number;
}
/** Loading, error (with retry) and empty states in one place. Every data region goes through this. */
export function AsyncView<T>({ q, children, isEmpty, empty, rows }: AsyncProps<T>) {
  if (q.loading) return <LoadingRows rows={rows} />;
  if (q.error) return <ErrorState {...errorText(q.error)} actionLabel="Retry" onAction={q.reload} />;
  if (q.data === undefined) return null;
  if (isEmpty?.(q.data) && empty) return <EmptyState {...empty} />;
  return <>{children(q.data)}</>;
}

export function FormError({ error }: { error: ApiError | null | undefined }) {
  if (!error) return null;
  return <Notice tone="danger">{error.message}</Notice>;
}

export function SubNav({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = nav.current, cur = el?.querySelector<HTMLElement>("[aria-current=page]");
    if (el && cur && el.scrollWidth > el.clientWidth) el.scrollLeft = cur.offsetLeft - (el.clientWidth - cur.offsetWidth) / 2;
  }, [path]);
  return (
    <nav className="tabs-nav" aria-label="Section" ref={nav}>
      {items.map((i) => <Link key={i.href} href={i.href} aria-current={path === i.href ? "page" : undefined}>{i.label}</Link>)}
    </nav>
  );
}

const STAGE_TONE: Record<LeadStage, BadgeTone> = { new: "neutral", contacted: "info", qualified: "info", demo_scheduled: "primary", demo_done: "primary", negotiation: "warning", won: "success", lost: "danger" };
export const StageBadge = ({ stage }: { stage: LeadStage }) => <Badge tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</Badge>;

const APP_TONE: Record<AppStatus, BadgeTone> = { draft: "neutral", in_progress: "info", ready: "success", provisioned: "success", cancelled: "danger" };
export const AppStatusBadge = ({ status }: { status: AppStatus }) => <Badge tone={APP_TONE[status]}>{statusLabel(status)}</Badge>;

const ENTRY_TONE: Record<EntryStatus, BadgeTone> = { pending: "warning", approved: "info", paid: "success", rejected: "danger" };
export const EntryBadge = ({ status }: { status: EntryStatus }) => <Badge tone={ENTRY_TONE[status]}>{statusLabel(status)}</Badge>;

const CAMPAIGN_TONE: Record<CampaignStatus, BadgeTone> = { draft: "neutral", active: "success", paused: "warning", ended: "neutral" };
export const CampaignBadge = ({ status }: { status: CampaignStatus }) => <Badge tone={CAMPAIGN_TONE[status]}>{statusLabel(status)}</Badge>;

const DEMO_TONE: Record<DemoStatus, BadgeTone> = { scheduled: "primary", completed: "success", cancelled: "neutral", no_show: "danger" };
export const DemoBadge = ({ status }: { status: DemoStatus }) => <Badge tone={DEMO_TONE[status]}>{statusLabel(status)}</Badge>;

/** Visible "no access" state (never a silent redirect). `needs` names who can use the page, e.g. "marketing admins". */
export function NoAccess({ role, what = "This page", needs = "marketing admins" }: { role?: string; what?: string; needs?: string }) {
  const router = useRouter();
  return <EmptyState title="You do not have access to this page" description={`${what} is for ${needs}${role ? `; you are signed in as ${ROLE_LABEL[role as Role].toLowerCase()}` : ""}. Ask a marketing admin if you need it.`} actionLabel="Back to My day" onAction={() => router.push("/")} />;
}
