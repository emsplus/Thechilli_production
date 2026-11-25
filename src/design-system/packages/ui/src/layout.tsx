import { createContext, useContext, useId, type HTMLAttributes, type ReactNode } from 'react';
import { IconButton } from './buttons';
import { cx } from './cx';
import { icons } from './icons';
import { t, type Locale } from './locale';
import { Money, formatINR, type MoneyInput } from './money';
import { Skeleton } from './display';

/** Page title block. Exactly one h1 per page. */
export function PageHeader({ title, description, actions, back }: { title: string; description?: string; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="ch-page-head">
      {back ? <div className="ch-page-head__back">{back}</div> : null}
      <div className="ch-page-head__row">
        <div>
          <h1 className="ch-page-head__title">{title}</h1>
          {description ? <p className="ch-page-head__desc">{description}</p> : null}
        </div>
        {actions ? <div className="ch-page-head__actions">{actions}</div> : null}
      </div>
    </header>
  );
}

/** Titled region of a page. `level` keeps the heading outline right (default h2). */
export function Section({ title, description, actions, level = 2, children, className, ...rest }: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title: string; description?: string; actions?: ReactNode; level?: 2 | 3 | 4;
}) {
  const id = useId();
  const H = `h${level}` as const;
  return (
    <section {...rest} aria-labelledby={id} className={cx('ch-section', className)}>
      <div className="ch-section__head">
        <div>
          <H id={id} className="ch-section__title">{title}</H>
          {description ? <p className="ch-section__desc">{description}</p> : null}
        </div>
        {actions ? <div className="ch-section__actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';
const noticeIcon = { info: icons.info, success: icons.check, warning: icons.alert, danger: icons.alert } as const;

/** Inline message. Danger and warning are announced assertively (role=alert); others politely. */
export function Notice({ tone = 'info', title, children, action, onDismiss, locale = 'en', className }: {
  tone?: NoticeTone; title?: string; children?: ReactNode; action?: ReactNode; onDismiss?: () => void; locale?: Locale; className?: string;
}) {
  return (
    <div className={cx('ch-notice', `ch-notice--${tone}`, className)} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}>
      <span className="ch-notice__icon">{noticeIcon[tone]}</span>
      <div className="ch-notice__body">
        {title ? <strong className="ch-notice__title">{title}</strong> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action}
      {onDismiss ? <IconButton label={t(locale, 'action.dismiss')} icon={icons.x} onClick={onDismiss} /> : null}
    </div>
  );
}

/** Spinner with a spoken label. Use skeletons for page-shaped loading, this for short waits. */
export function Spinner({ label, locale = 'en', size = 20 }: { label?: string; locale?: Locale; size?: number }) {
  return (
    <span role="status" className="ch-spinner-wrap">
      <span className="ch-spinner" aria-hidden="true" style={{ width: size, height: size }} />
      <span className="ch-sr-only">{label ?? t(locale, 'common.loading')}</span>
    </span>
  );
}

export interface StatCardProps {
  label: string;
  /** Money amount in paise: shown compact (lakh / crore) with the exact figure as the title. */
  money?: MoneyInput;
  /** Any other value (a count, a duration). Ignored when `money` is set. */
  value?: ReactNode;
  /** Change versus the previous period, in percent. Shown with arrow + words, never colour alone. */
  delta?: number;
  /** For cost-like numbers, a fall is good. */
  lowerIsBetter?: boolean;
  deltaLabel?: string;
  /** One short explanatory line under the value, inside the card ("Before refunds", "3 bills"). */
  hint?: ReactNode;
  loading?: boolean;
  locale?: Locale;
}

/** KPI tile (value + delta). Money uses the shared compact lakh/crore formatter. */
export function StatCard({ label, money, value, delta, lowerIsBetter, deltaLabel, hint, loading, locale = 'en' }: StatCardProps) {
  const dir = delta === undefined ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const good = dir === 'flat' ? null : lowerIsBetter ? dir === 'down' : dir === 'up';
  const text = delta === undefined ? '' : dir === 'flat' ? t(locale, 'delta.flat') : t(locale, `delta.${dir}`, { n: Math.abs(delta) });
  return (
    <div className="ch-card ch-stat" role="group" aria-label={label} aria-busy={loading || undefined}>
      <span className="ch-stat__label">{label}</span>
      {loading ? <Skeleton width={96} height={32} /> : (
        <span className="ch-stat__value">
          {money !== undefined ? <Money value={money} compact title={formatINR(money)} /> : value}
        </span>
      )}
      {dir && !loading ? (
        <span className={cx('ch-stat__delta', good === true && 'ch-stat__delta--good', good === false && 'ch-stat__delta--bad')}>
          {icons[dir]}<span>{text}</span>{deltaLabel ? <span className="ch-stat__vs">{deltaLabel}</span> : null}
        </span>
      ) : null}
      {hint ? <span className="ch-stat__hint">{hint}</span> : null}
    </div>
  );
}
export const KpiTile = StatCard;

/* ---------- FeatureGate ---------- */
interface GateValue { can?: (perm: string) => boolean; flags?: Record<string, boolean> }
const GateCtx = createContext<GateValue>({});

/** Supplies the signed-in user's permission check and the tenant's entitlement flags. */
export function FeatureGateProvider({ can, flags, children }: GateValue & { children: ReactNode }) {
  return <GateCtx.Provider value={{ can, flags }}>{children}</GateCtx.Provider>;
}

/**
 * Renders children only when every given condition passes: `can(perm)` and/or `flags[flag]`.
 * Fails closed: no provider, an unknown flag, or no condition at all renders `fallback` (default nothing).
 * This hides UI only; the server must still enforce the same rule.
 */
export function FeatureGate({ perm, flag, fallback = null, children }: { perm?: string; flag?: string; fallback?: ReactNode; children: ReactNode }) {
  const { can, flags } = useContext(GateCtx);
  const hasCondition = perm !== undefined || flag !== undefined;
  const ok = hasCondition && (perm === undefined || can?.(perm) === true) && (flag === undefined || flags?.[flag] === true);
  return <>{ok ? children : fallback}</>;
}

/** Outlet picker for the app bar. Renders nothing for one outlet (strategy: only if more than 1). */
export function OutletSwitcher({ outlets, value, onChange, locale = 'en', label }: {
  outlets: Array<{ id: string; name: string }>; value: string; onChange: (id: string) => void; locale?: Locale; label?: string;
}) {
  const id = useId();
  if (outlets.length <= 1) return null;
  return (
    <div className="ch-outlet">
      <label htmlFor={id} className="ch-sr-only">{label ?? t(locale, 'outlet.label')}</label>
      <span aria-hidden="true" className="ch-outlet__icon">{icons.pin}</span>
      <select id={id} className="ch-input ch-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );
}
