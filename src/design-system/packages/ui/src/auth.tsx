import {
  useCallback, useEffect, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from 'react';
import { cx } from './cx';

/** One slot in the left panel. Real photos or short clips only (see docs/AUTH_MEDIA_SPEC.md). */
export interface AuthMediaItem {
  type: 'image' | 'video';
  src: string;
  /** Required for videos when motion is off or data saver is on (shown instead of the clip). */
  poster?: string;
  /** Empty string = decorative (the default choice). Only write text when the caption means something. */
  alt: string;
  /** Licence or photographer line. Rendered as "Photo credit: ..." only when set. */
  credit?: string;
}

export interface AuthMediaProps {
  items?: readonly AuthMediaItem[];
  /** Milliseconds each slide stays (default 6000). */
  interval?: number;
  /** Accessible name of the slide-picker group. */
  label?: string;
  /** Test/dev hook: force these instead of reading the browser. */
  reducedMotion?: boolean;
  saveData?: boolean;
  className?: string;
  /** Overlay laid over the picture (AuthSplit puts the headline here, on a bottom scrim). */
  children?: ReactNode;
  /** Small decorative chips floating over the picture (sample visuals, hidden from assistive tech and on phones). */
  chips?: readonly string[];
}

/** Decorative sample chips laid over the picture (e.g. "KOT ready"); not data, aria-hidden, hidden on phones. */
function AuthChips({ chips }: { chips?: readonly string[] }) {
  if (!chips?.length) return null;
  return (
    <div className="ch-auth__chips" aria-hidden="true">
      {chips.slice(0, 3).map((c, i) => <span key={c} className={`ch-auth__chip ch-auth__chip--${i + 1}`}><span className="ch-auth__chip-dot" />{c}</span>)}
    </div>
  );
}

type Nav = Navigator & { connection?: { saveData?: boolean } };

/** null until the browser has been asked (server render and first paint show posters, never a clip). */
function useCalmMode(forceReduced?: boolean, forceSave?: boolean): boolean | null {
  const [calm, setCalm] = useState<boolean | null>(forceReduced || forceSave ? true : null);
  useEffect(() => {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const read = () => setCalm(Boolean(forceReduced || forceSave || mq?.matches || (navigator as Nav).connection?.saveData));
    read();
    mq?.addEventListener?.('change', read);
    return () => mq?.removeEventListener?.('change', read);
  }, [forceReduced, forceSave]);
  return calm;
}

/**
 * Development only (the "Placeholder" caption). Written as the plain `process.env.NODE_ENV` expression so app bundlers inline it
 * (an optional-chained `process.env?.NODE_ENV` is not inlined); where `process` does not exist at all it answers false, so a
 * production page never shows the caption.
 */
const isDev = () => {
  try { return process.env.NODE_ENV !== 'production'; } catch { return false; }
};

/** True while the tab is in the background: the carousel stops and clips pause (no work for an unseen page). */
function useTabHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const read = () => setHidden(document.visibilityState === 'hidden');
    read();
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, []);
  return hidden;
}

/**
 * Left panel of AuthSplit: slow crossfading carousel of real photos/clips, or a brand placeholder
 * when there is nothing (usable) to show. The slides are decorative; the dots are real buttons.
 */
export function AuthMedia({ items = [], interval = 6000, label = 'Choose picture', reducedMotion, saveData, className, children, chips }: AuthMediaProps) {
  const mode = useCalmMode(reducedMotion, saveData);
  const calm = mode !== false; // unknown counts as calm until the browser answers
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set());
  const [hovered, setPaused] = useState(false);
  // Any manual choice (dot, arrow key, swipe) stops the autoplay for the rest of the visit.
  const [manual, setManual] = useState(false);
  const touchX = useRef<number | null>(null);
  const tabHidden = useTabHidden();
  const paused = hovered || tabHidden;
  const dots = useRef<Array<HTMLButtonElement | null>>([]);
  const videos = useRef<Array<HTMLVideoElement | null>>([]);

  // A video with no poster cannot be shown while calm, so it counts as unusable then.
  const usable = items.map((it, i) => !failed.has(i) && !(calm && it.type === 'video' && !it.poster));
  const live = items.map((_, i) => i).filter((i) => usable[i]);
  const current = live.includes(index) ? index : live[0];
  const rotating = live.length > 1 && !calm && !paused && !manual;

  useEffect(() => {
    if (!rotating || current === undefined) return;
    const timer = setTimeout(() => {
      const at = live.indexOf(current);
      setIndex(live[(at + 1) % live.length]!);
    }, interval);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotating, current, interval, live.join(',')]);

  // Only the visible clip plays, and only when motion is welcome.
  useEffect(() => {
    videos.current.forEach((v, i) => {
      if (!v) return;
      if (!calm && i === current && !paused) void v.play?.()?.catch?.(() => undefined);
      else v.pause?.();
    });
  }, [calm, current, paused]);

  const markFailed = useCallback((i: number) => setFailed((s) => new Set(s).add(i)), []);
  const go = (i: number, focus = false) => { setManual(true); setIndex(i); if (focus) dots.current[i]?.focus(); };
  const step = (by: number) => {
    if (live.length < 2 || current === undefined) return;
    const at = live.indexOf(current);
    go(live[(at + by + live.length) % live.length]!);
  };
  const onDotKey = (e: KeyboardEvent, at: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    go(live[(at + step + live.length) % live.length]!, true);
  };

  const credit = current !== undefined ? items[current]?.credit : undefined;

  if (current === undefined) {
    return (
      <div className={cx('ch-auth__media', 'ch-auth__media--ph', className)} data-placeholder="" data-paused={tabHidden || undefined}>
        <div className="ch-auth__ph-art" aria-hidden="true" />
        <AuthChips chips={chips} />
        {children}
        {isDev() ? <span className="ch-auth__ph-tag">Placeholder: no media. Add photos to public/auth-media/manifest.json</span> : null}
      </div>
    );
  }

  return (
    <div
      className={cx('ch-auth__media', className)}
      data-paused={paused || undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false); }}
      onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
      onTouchEnd={(e) => {
        const x0 = touchX.current; touchX.current = null;
        const x1 = e.changedTouches[0]?.clientX;
        if (x0 == null || x1 == null || Math.abs(x1 - x0) < 40) return;
        step(x1 < x0 ? 1 : -1);
      }}
    >
      {/* While the first picture loads, the scene shows behind it (static: no animation under media). */}
      <div className="ch-auth__slides" aria-live={rotating ? 'off' : 'polite'}>
        {items.map((it, i) => {
          if (!usable[i]) return null;
          const showClip = it.type === 'video' && !calm;
          const shown = i === current;
          return (
            <div key={`${it.src}-${i}`} className={cx('ch-auth__slide', shown && 'is-on')} data-active={shown || undefined}>
              {showClip ? (
                <video
                  ref={(el) => { videos.current[i] = el; }}
                  src={it.src}
                  poster={it.poster}
                  muted loop playsInline preload="none"
                  aria-label={it.alt || undefined}
                  aria-hidden={it.alt ? undefined : true}
                  onError={() => markFailed(i)}
                />
              ) : (
                <img
                  src={it.type === 'video' ? it.poster : it.src}
                  alt={it.alt}
                  loading={i === 0 ? 'eager' : 'lazy'}
                  fetchPriority={i === 0 ? 'high' : 'low'}
                  decoding="async"
                  onError={() => markFailed(i)}
                />
              )}
            </div>
          );
        })}
      </div>
      <AuthChips chips={chips} />
      {children}
      {credit ? <p className="ch-auth__credit">Photo credit: {credit}</p> : null}
      {live.length > 1 ? (
        <div className="ch-auth__dots" role="group" aria-label={label}>
          {live.map((i, n) => (
            <button
              key={i}
              type="button"
              ref={(el) => { dots.current[i] = el; }}
              className="ch-auth__dot"
              aria-label={`Show picture ${n + 1} of ${live.length}`}
              aria-current={i === current ? 'true' : undefined}
              onClick={() => go(i)}
              onKeyDown={(e) => onDotKey(e, n)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Remember me" for sign-in forms: keeps only the EMAIL on this device (never the password or a token). Pre-fills it and ticks
 * the box on the next visit. Call `commit(email)` after a successful sign-in: it stores or forgets the email.
 */
export function useRememberedEmail(storageKey: string) {
  const [email, setEmail] = useState('');
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) { setEmail((cur) => cur || saved); setRemember(true); }
    } catch { /* storage blocked: start empty */ }
  }, [storageKey]);
  const commit = useCallback((value: string) => {
    try {
      if (remember && value) localStorage.setItem(storageKey, value);
      else localStorage.removeItem(storageKey);
    } catch { /* storage blocked */ }
  }, [remember, storageKey]);
  return { email, setEmail, remember, setRemember, commit };
}

export interface AuthSplitProps {
  /** Logo mark, centred above the title. */
  logo?: ReactNode;
  /** Page heading (h1). Leave out when the children render their own h1 (e.g. forgot / reset password steps). */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** The form(s). Inputs use `variant="pill"` (with `icon`); the primary button uses `size="lg"`. */
  children: ReactNode;
  /** Line under the form. */
  footer?: ReactNode;
  /** Logo shown in a white pill at the top of the shape (style guide v1.0: real logo on white, never on red). */
  shapeLogo?: ReactNode;
  /** Large white title on the Chilli Red shape (portal-specific, true copy only). */
  headline?: ReactNode;
  /** One soft line under it. */
  tagline?: ReactNode;
  /** Optional outlined pill action on the shape: pass a link with className "ch-auth__action". A text link on phones. */
  action?: ReactNode;
  /** Accessible name of the shape (a complementary landmark). */
  sideLabel?: string;
  /** Photos/clips from the manifest, shown faintly inside the shape only when `showMedia` is on (default off: clean shape). */
  media?: readonly AuthMediaItem[];
  mediaInterval?: number;
  showMedia?: boolean;
  className?: string;
}

/**
 * Sign-in shell (owner reference, 2026-10-31): one big rounded white card. Left (~55%): centred logo, large title, pill fields,
 * a modest centred primary button. Right (~45%): a Chilli Red shape with heavily rounded left corners bleeding off the card's right
 * edge, carrying a white title, one soft line and an optional outlined pill action. Below 768px the shape becomes a curved
 * banner above the form. Renders the page's <main> (the form column).
 */
export function AuthSplit({ logo, title, subtitle, children, footer, shapeLogo, headline, tagline, action, sideLabel = 'About thechilli.ai', media, mediaInterval, showMedia = false, className }: AuthSplitProps) {
  return (
    <div className={cx('ch-auth', className)}>
      <div className="ch-auth__card">
        <main className="ch-auth__main" id="main">
          <div className="ch-auth__inner">
            {logo ? <div className="ch-auth__logo">{logo}</div> : null}
            {title ? <h1 className="ch-auth__title">{title}</h1> : null}
            {subtitle ? <p className="ch-auth__sub">{subtitle}</p> : null}
            <div className="ch-auth__body">{children}</div>
            {footer ? <p className="ch-auth__foot">{footer}</p> : null}
          </div>
        </main>
        <aside className={cx('ch-auth__shape', showMedia && media?.length ? 'ch-auth__shape--media' : null)} aria-label={sideLabel}>
          {showMedia && media?.length ? <AuthMedia items={media} interval={mediaInterval} className="ch-auth__shape-media" /> : null}
          <div className="ch-auth__shape-text">
            {shapeLogo ? <div className="ch-auth__pill">{shapeLogo}</div> : null}
            {headline ? <h2 className="ch-auth__headline">{headline}</h2> : null}
            {tagline ? <p className="ch-auth__tagline">{tagline}</p> : null}
            {action ? <div className="ch-auth__action-wrap">{action}</div> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
