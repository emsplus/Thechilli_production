import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from './buttons';
import { toCsv, downloadCsv, type CsvValue } from './csv';
import { cx } from './cx';
import { EmptyState, ErrorState, Skeleton, SkeletonGroup } from './display';
import { icons } from './icons';
import { t, type Locale } from './locale';

type SortValue = string | number | bigint | null | undefined;

export interface DataColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'start' | 'end';
  /** Makes the column sortable. Sort on this raw value, not on the rendered text (paise, not "₹1.2 L"). */
  sortValue?: (row: T) => SortValue;
  /** Value written to CSV. Defaults to `sortValue`; a column with neither is left out of the export. */
  csv?: (row: T) => CsvValue;
}

export interface SortState { key: string; dir: 'asc' | 'desc' }

export interface DataTableProps<T> {
  /** Required: names the scroll region and the table. */
  caption: string;
  columns: DataColumn<T>[];
  rows: T[];
  getKey: (row: T) => string;
  status?: 'ready' | 'loading' | 'error';
  onRetry?: () => void;
  empty?: ReactNode;
  errorTitle?: string;
  /** Controlled sort. Omit for uncontrolled (sorts rows on the client). */
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  /** First column stays visible while scrolling sideways. Default true. */
  stickyFirstColumn?: boolean;
  /** Shows an Export CSV button; the file is named `${exportName}.csv`. */
  exportName?: string;
  loadingRows?: number;
  locale?: Locale;
}

const collator = new Intl.Collator('en-IN', { numeric: true, sensitivity: 'base' });

function compare(a: SortValue, b: SortValue): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'string' || typeof b === 'string') return collator.compare(String(a), String(b));
  return a < b ? -1 : a > b ? 1 : 0;
}

type Edge = 'none' | 'start' | 'middle' | 'end';

function useScrollEdge() {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState<Edge>('none');
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const x = Math.abs(el.scrollLeft);
    setEdge(max <= 1 ? 'none' : x <= 1 ? 'start' : x >= max - 1 ? 'end' : 'middle');
  }, []);
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  return { ref, edge, measure };
}

/** Sortable table with loading / empty / error states, sticky first column, scroll cue and CSV export. */
export function DataTable<T>({
  caption, columns, rows, getKey, status = 'ready', onRetry, empty, errorTitle, sort, onSortChange,
  stickyFirstColumn = true, exportName, loadingRows = 5, locale = 'en',
}: DataTableProps<T>) {
  const [inner, setInner] = useState<SortState | null>(null);
  const active = sort === undefined ? inner : sort;
  const hintId = useId();
  const { ref, edge, measure } = useScrollEdge();

  const sorted = useMemo(() => {
    if (!active) return rows;
    const sv = columns.find((c) => c.key === active.key)?.sortValue;
    if (!sv) return rows;
    const sign = active.dir === 'asc' ? 1 : -1;
    // Array.prototype.sort is stable, so equal rows keep their original order.
    return [...rows].sort((a, b) => sign * compare(sv(a), sv(b)));
  }, [rows, columns, active]);

  const setSort = (next: SortState | null) => { setInner(next); onSortChange?.(next); };
  const toggle = (key: string) => {
    if (!active || active.key !== key) setSort({ key, dir: 'asc' });
    else if (active.dir === 'asc') setSort({ key, dir: 'desc' });
    else setSort(null);
  };

  const exportable = columns.filter((c) => c.csv ?? c.sortValue);
  const onExport = () => downloadCsv(
    exportName ?? 'export',
    toCsv(exportable.map((c) => c.header), sorted.map((r) => exportable.map((c) => (c.csv ?? c.sortValue)!(r)))),
  );

  let body: ReactNode;
  if (status === 'error') {
    body = <ErrorState title={errorTitle ?? t(locale, 'common.error')} onAction={onRetry} locale={locale} />;
  } else if (status === 'loading') {
    body = (
      <SkeletonGroup locale={locale}>
        <div className="ch-dt__loading">{Array.from({ length: loadingRows }, (_, i) => <Skeleton key={i} height={20} />)}</div>
      </SkeletonGroup>
    );
  } else if (rows.length === 0) {
    body = empty ?? <EmptyState title={t(locale, 'common.empty')} />;
  } else {
    body = (
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard reachable
      <div ref={ref} className="ch-dt__scroll" role="region" aria-label={caption} aria-describedby={edge === 'none' ? undefined : hintId} tabIndex={0} onScroll={measure}>
        <table className="ch-table ch-dt__table">
          <caption className="ch-sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => {
                const dir = active?.key === c.key ? active.dir : null;
                return (
                  <th key={c.key} scope="col" className={c.align === 'end' ? 'ch-end' : undefined} aria-sort={c.sortValue ? (dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none') : undefined}>
                    {c.sortValue ? (
                      <button type="button" className="ch-dt__sort" onClick={() => toggle(c.key)}>
                        {c.header}
                        {dir === 'asc' ? icons.up : dir === 'desc' ? icons.down : icons.sort}
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={getKey(r)}>
                {columns.map((c) => <td key={c.key} className={c.align === 'end' ? 'ch-end' : undefined}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {edge === 'none' ? null : <span id={hintId} className="ch-sr-only">{t(locale, 'table.scroll')}</span>}
      </div>
    );
  }

  return (
    <div className={cx('ch-dt', stickyFirstColumn && 'ch-dt--sticky')} data-scroll={status === 'ready' ? edge : 'none'} data-status={status}>
      {/* Only when there is something to export: a lone disabled button on its own row reads as broken (UI review, Procurement). */}
      {exportName && status === 'ready' && rows.length > 0 ? (
        <div className="ch-dt__bar">
          <Button size="sm" iconStart={icons.upload} onClick={onExport}>{t(locale, 'action.export')}</Button>
        </div>
      ) : null}
      <div className="ch-dt__frame">{body}</div>
    </div>
  );
}

/** Row of filters above a table. Shows a Reset button while any filter is active. */
export function FilterBar({ label, children, activeCount = 0, onReset, locale = 'en' }: {
  label?: string; children: ReactNode; activeCount?: number; onReset?: () => void; locale?: Locale;
}) {
  return (
    <div role="group" aria-label={label ?? t(locale, 'filter.label')} className="ch-filters">
      {children}
      {activeCount > 0 && onReset ? <Button variant="ghost" onClick={onReset}>{`${t(locale, 'action.reset')} (${activeCount})`}</Button> : null}
    </div>
  );
}
