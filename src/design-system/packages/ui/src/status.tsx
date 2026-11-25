import type { ReactNode } from 'react';
import { cx } from './cx';
import { icons } from './icons';
import { t, type Locale } from './locale';
import { Button } from './buttons';

export type OrderState = 'draft' | 'placed' | 'preparing' | 'ready' | 'served' | 'paid' | 'cancelled';

export const orderStates: readonly OrderState[] = ['draft', 'placed', 'preparing', 'ready', 'served', 'paid', 'cancelled'];

const stateMeta: Record<OrderState, { tone: string; icon: ReactNode }> = {
  draft: { tone: 'neutral', icon: icons.pencil },
  placed: { tone: 'info', icon: icons.dot },
  preparing: { tone: 'warning', icon: icons.flame },
  ready: { tone: 'success', icon: icons.check },
  served: { tone: 'neutral', icon: icons.checks },
  paid: { tone: 'primary', icon: icons.rupee },
  cancelled: { tone: 'danger', icon: icons.x },
};

/** Status = colour + icon + text, never colour alone. */
export function StatusPill({ state, locale = 'en', className }: { state: OrderState; locale?: Locale; className?: string }) {
  const m = stateMeta[state];
  return (
    <span className={cx('ch-pill', `ch-pill--${m.tone}`, className)}>
      {m.icon}
      <span>{t(locale, `order.${state}`)}</span>
    </span>
  );
}

export function OfflineBanner({ offline, queued = 0, locale = 'en' }: { offline: boolean; queued?: number; locale?: Locale }) {
  // Live region stays mounted so the change is announced.
  return (
    <div role="status" aria-live="polite" className={offline ? 'ch-offline' : undefined}>
      {offline ? (
        <>
          <span className="ch-offline__icon">{icons.offline}</span>
          <span>{t(locale, 'offline.banner')}</span>
          {queued > 0 ? <strong>{t(locale, 'sync.queued', { n: queued })}</strong> : null}
        </>
      ) : null}
    </div>
  );
}

export type SyncState = 'synced' | 'queued' | 'sending' | 'failed' | 'offline';

const syncMeta: Record<SyncState, { tone: string; icon: ReactNode }> = {
  synced: { tone: 'success', icon: icons.check },
  queued: { tone: 'warning', icon: icons.clock },
  sending: { tone: 'info', icon: icons.upload },
  failed: { tone: 'danger', icon: icons.alert },
  offline: { tone: 'neutral', icon: icons.offline },
};

/** Honest state (P10): Queued / Sending / Confirmed / Failed. Never says done until confirmed. */
export function SyncStatus({ state, count = 0, locale = 'en', onRetry }: { state: SyncState; count?: number; locale?: Locale; onRetry?: () => void }) {
  const m = syncMeta[state];
  return (
    <span className="ch-sync-wrap">
      <span role={state === 'failed' ? 'alert' : 'status'} className={cx('ch-pill', `ch-pill--${m.tone}`)}>
        {m.icon}
        <span>{t(locale, `sync.${state}`, { n: count })}</span>
      </span>
      {state === 'failed' && onRetry ? <Button size="sm" onClick={onRetry}>{t(locale, 'action.retry')}</Button> : null}
    </span>
  );
}
