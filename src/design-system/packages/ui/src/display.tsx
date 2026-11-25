import * as RT from '@radix-ui/react-tabs';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';
import { icons } from './icons';
import { t, type Locale } from './locale';
import { Button } from './buttons';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'ink' | 'outline' | 'brand' | 'brand-outline';

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cx('ch-badge', `ch-badge--${tone}`, className)} {...rest} />;
}

export type FoodType = 'veg' | 'non-veg' | 'egg';
const foodLabel: Record<FoodType, string> = { veg: 'Veg', 'non-veg': 'Non-veg', egg: 'Egg' };

/** FSSAI food mark: square outline with a dot (veg) or triangle (non-veg); shape + colour, and an accessible name. */
export function FoodMark({ type, label, className }: { type: FoodType; label?: string; className?: string }) {
  return <span role="img" aria-label={label ?? foodLabel[type]} className={cx('ch-food', `ch-food--${type}`, className)} />;
}

export function Card({ as: Tag = 'div', className, ...rest }: HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' }) {
  return <Tag className={cx('ch-card', className)} {...rest} />;
}

/* ---------- Skeleton ---------- */
export function Skeleton({ width, height = 16, className }: { width?: number | string; height?: number | string; className?: string }) {
  return <span className={cx('ch-skeleton', className)} style={{ width, height }} aria-hidden="true" />;
}

/** Wraps loading placeholders so assistive tech hears one "Loading". */
export function SkeletonGroup({ children, locale = 'en' }: { children: ReactNode; locale?: Locale }) {
  return (
    <div role="status" aria-busy="true">
      <span className="ch-sr-only">{t(locale, 'common.loading')}</span>
      {children}
    </div>
  );
}

/* ---------- Empty / Error ---------- */
interface StateProps {
  title: string;
  description?: string;
  /** Every empty and error state offers one next action (P14). */
  actionLabel?: string;
  onAction?: () => void;
}

export interface EmptyStateProps extends StateProps {
  /**
   * Weight of the action button. One primary action per view: pass `secondary` when the page already shows a primary button
   * (for example "New customer" in the header). Defaults to `primary` (unchanged behaviour).
   */
  actionVariant?: 'primary' | 'secondary';
}

export function EmptyState({ title, description, actionLabel, onAction, actionVariant = 'primary' }: EmptyStateProps) {
  return (
    <div className="ch-state">
      <span className="ch-state__icon">{icons.inbox}</span>
      <h3 className="ch-state__title">{title}</h3>
      {description ? <p className="ch-state__desc">{description}</p> : null}
      {actionLabel ? <Button variant={actionVariant} onClick={onAction}>{actionLabel}</Button> : null}
    </div>
  );
}

export function ErrorState({ title, description, actionLabel, onAction, locale = 'en' }: StateProps & { locale?: Locale }) {
  return (
    <div className="ch-state ch-state--error" role="alert">
      <span className="ch-state__icon ch-state__icon--danger">{icons.alert}</span>
      <h3 className="ch-state__title">{title}</h3>
      {description ? <p className="ch-state__desc">{description}</p> : null}
      <Button variant="secondary" onClick={onAction}>{actionLabel ?? t(locale, 'action.retry')}</Button>
    </div>
  );
}

/* ---------- Tabs ---------- */
export interface TabItem { value: string; label: string; content: ReactNode }

export function Tabs({ items, defaultValue, label }: { items: TabItem[]; defaultValue?: string; label: string }) {
  return (
    <RT.Root className="ch-tabs" defaultValue={defaultValue ?? items[0]?.value}>
      <RT.List className="ch-tabs__list" aria-label={label}>
        {items.map((i) => <RT.Trigger key={i.value} value={i.value} className="ch-tabs__tab">{i.label}</RT.Trigger>)}
      </RT.List>
      {items.map((i) => <RT.Content key={i.value} value={i.value} className="ch-tabs__panel">{i.content}</RT.Content>)}
    </RT.Root>
  );
}

/* ---------- Table ---------- */
export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'start' | 'end';
}

export interface TableProps<T> {
  /** Required: every table has a caption (visually hidden unless `showCaption`). */
  caption: string;
  showCaption?: boolean;
  columns: Column<T>[];
  rows: T[];
  getKey: (row: T) => string;
  empty?: ReactNode;
}

export function Table<T>({ caption, showCaption, columns, rows, getKey, empty }: TableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    // Scrollable region must be keyboard focusable (axe: scrollable-region-focusable).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="ch-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="ch-table">
        <caption className={showCaption ? 'ch-table__caption' : 'ch-sr-only'}>{caption}</caption>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} scope="col" className={c.align === 'end' ? 'ch-end' : undefined}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={getKey(r)}>
              {columns.map((c) => <td key={c.key} className={c.align === 'end' ? 'ch-end' : undefined}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
