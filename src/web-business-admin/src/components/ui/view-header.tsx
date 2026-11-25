import type { ReactNode } from "react";
import { PageHeader } from "@chilli/ui";

/** A page's own header, or (inside Manage, where the panel already shows the section title) just its description and actions. */
export function ViewHeader({ embedded, title, description, actions }: { embedded?: boolean; title: string; description?: string; actions?: ReactNode }) {
  if (!embedded) return <PageHeader title={title} description={description} actions={actions} />;
  if (!description && !actions) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      {description && <p className="max-w-2xl text-sm text-fg-muted">{description}</p>}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
