import { Children, useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from './buttons';
import { cx } from './cx';
import { icons } from './icons';
import { t, type Locale } from './locale';

export type KdsState = 'new' | 'prep' | 'ready';
export type KdsAge = 'ok' | 'warn' | 'late';

const stateKey: Record<KdsState, string> = { new: 'order.placed', prep: 'order.preparing', ready: 'order.ready' };
const advanceKey: Record<KdsState, string> = { new: 'kds.start', prep: 'kds.ready', ready: 'kds.serve' };

/** Whole minutes since the ticket was placed (never negative). */
export function ticketMinutes(placedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - placedAt) / 60_000));
}

/** ok below `warnAfter` minutes, warn from `warnAfter`, late from `lateAfter`. */
export function ticketAge(minutes: number, warnAfter = 10, lateAfter = 15): KdsAge {
  return minutes >= lateAfter ? 'late' : minutes >= warnAfter ? 'warn' : 'ok';
}

/** A ticking clock for ticket ageing. One timer per board, passed to tickets as `now`. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Kitchen screen frame: far density on the light canvas (the product is light only; owner approval 2026-11-03). */
export function KdsBoard({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="ch-kds" data-density="far" role={label ? 'group' : undefined} aria-label={label}>
      {children}
    </div>
  );
}

/** One stage of the board (New / Preparing / Ready). */
export function KdsColumn({ title, count, state = 'new', children, locale = 'en' }: {
  title: string; count?: number; state?: KdsState; children?: ReactNode; locale?: Locale;
}) {
  const id = useId();
  return (
    <section className={cx('ch-kds-col', `ch-kds-col--${state}`)} data-density="far" aria-labelledby={id}>
      <h2 id={id} className="ch-kds-col__title">
        {title}
        <span className="ch-kds-col__count">{count ?? Children.count(children)}</span>
      </h2>
      <div className="ch-kds-col__list">
        {Children.count(children) > 0 ? children : <p className="ch-kds-col__empty">{t(locale, 'kds.empty')}</p>}
      </div>
    </section>
  );
}

export interface KdsItem { id?: string; name: string; qty: number; note?: string }

export interface KdsTicketProps {
  number: string | number;
  channel?: string;
  table?: string;
  items: KdsItem[];
  /** Epoch ms the order was placed. */
  placedAt: number;
  /** Current epoch ms from `useNow()`; keeps tickets pure and testable. */
  now: number;
  state: KdsState;
  warnAfterMin?: number;
  lateAfterMin?: number;
  /** One tap moves the ticket to the next stage. */
  onAdvance?: () => void;
  advanceLabel?: string;
  locale?: Locale;
  /** Advance request in flight: the action shows its spinner and is disabled. */
  busy?: boolean;
  /** Just arrived: highlighted ring (data-fresh) until the host clears it. */
  fresh?: boolean;
  /** Small leading icon next to the channel/table text (e.g. dine-in, takeaway). */
  icon?: ReactNode;
  /** Secondary actions row under the main action (print, cancel). Keep each target 56px+. */
  actions?: ReactNode;
  /** Tapping anywhere on the ticket (outside its own buttons) advances it, for wet-hands use. The button stays the keyboard path. */
  tapToAdvance?: boolean;
}

/** Kitchen ticket. Age is colour + icon + words ("Late 17 min"), never colour alone. Large type, 56px+ action. */
export function KdsTicket({
  number, channel, table, items, placedAt, now, state, warnAfterMin = 10, lateAfterMin = 15, onAdvance, advanceLabel, locale = 'en', busy, fresh, icon, actions, tapToAdvance,
}: KdsTicketProps) {
  const minutes = ticketMinutes(placedAt, now);
  const age = ticketAge(minutes, warnAfterMin, lateAfterMin);
  const mins = t(locale, 'kds.min', { n: minutes });
  return (
    // The click handler is a pointer convenience only; the advance button is the accessible control.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events
    <article className={cx('ch-kds-ticket', `ch-kds-ticket--${state}`, tapToAdvance && onAdvance && 'ch-kds-ticket--tap')} data-density="far" data-age={age} data-fresh={fresh || undefined} aria-label={`#${number}`}
      onClick={tapToAdvance && onAdvance ? (e) => { if (!busy && !(e.target as HTMLElement).closest('button,a,input,select,textarea')) onAdvance(); } : undefined}>
      <header className="ch-kds-ticket__head">
        <span className="ch-kds-ticket__no">#{number}</span>
        <span className="ch-kds-ticket__meta">{icon}{[channel, table].filter(Boolean).join(' · ')}</span>
        <span className={cx('ch-kds-ticket__age', `ch-kds-ticket__age--${age}`)}>
          {age === 'ok' ? icons.clock : icons.alert}
          <span>{age === 'late' ? `${t(locale, 'kds.late')} ${mins}` : mins}</span>
        </span>
      </header>
      <p className="ch-kds-ticket__state">{t(locale, stateKey[state])}</p>
      <ul className="ch-kds-ticket__items">
        {items.map((i, n) => (
          <li key={i.id ?? n}>
            <span className="ch-kds-ticket__qty">{i.qty}×</span>
            <span>
              {i.name}
              {i.note ? <em className="ch-kds-ticket__note">{i.note}</em> : null}
            </span>
          </li>
        ))}
      </ul>
      {onAdvance ? <Button variant="primary" size="lg" className="ch-kds-ticket__go" loading={busy} disabled={busy} onClick={onAdvance}>{advanceLabel ?? t(locale, advanceKey[state])}</Button> : null}
      {actions ? <div className="ch-kds-ticket__actions">{actions}</div> : null}
    </article>
  );
}
