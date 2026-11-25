import * as RD from '@radix-ui/react-dialog';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cx } from './cx';
import { Button } from './buttons';
import { icons } from './icons';
import { t, type Locale } from './locale';

export interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required: dialogs and sheets always have an accessible title. */
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  locale?: Locale;
  /** Element to focus on open (e.g. Cancel on a destructive confirm). Default: the first form field in the content, else the primary action; never the Close button. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Keep the title for screen readers only (the content shows its own heading); the close button stays. */
  hideTitle?: boolean;
  /** No body padding: the content brings its own layout (e.g. a POS cart panel). */
  flush?: boolean;
}

const FIELD = 'input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled)';
const PRIMARY = '.ch-btn--primary:not(:disabled), button[type=submit]:not(:disabled)';

/** Default initial focus: first form field, else the primary action, else any focusable control except Close, else the surface itself. */
function defaultFocusTarget(content: HTMLElement): HTMLElement {
  const fields = content.querySelector<HTMLElement>(`.ch-pop__body :is(${FIELD})`);
  if (fields) return fields;
  const primary = content.querySelector<HTMLElement>(PRIMARY);
  if (primary) return primary;
  const other = content.querySelector<HTMLElement>('.ch-pop__body :is(button, a[href], [tabindex]:not([tabindex="-1"])):not(:disabled), .ch-pop__foot :is(button, a[href]):not(:disabled)');
  return other ?? content;
}

function Overlay({ open, onOpenChange, title, description, children, footer, locale = 'en', kind, initialFocus, role, hideTitle, flush }: OverlayProps & { kind: string; role?: 'alertdialog' }) {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="ch-overlay" />
        <RD.Content
          ref={contentRef}
          className={cx('ch-surface-pop', kind)}
          {...(role ? { role } : {})}
          onOpenAutoFocus={(e) => {
            const target = initialFocus?.current ?? defaultFocusTarget((contentRef.current ?? e.target) as HTMLElement);
            e.preventDefault();
            target.focus();
          }}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className={cx('ch-pop__head', hideTitle && 'ch-pop__head--bare')}>
            <RD.Title className={hideTitle ? 'ch-sr-only' : 'ch-pop__title'}>{title}</RD.Title>
            <RD.Close className="ch-btn ch-btn--ghost ch-btn--icon" aria-label={t(locale, 'action.close')}>{icons.x}</RD.Close>
          </div>
          {description ? <RD.Description className="ch-pop__desc">{description}</RD.Description> : null}
          <div className={cx('ch-pop__body', flush && 'ch-pop__body--flush')}>{children}</div>
          {footer ? <div className="ch-pop__foot">{footer}</div> : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** Dialog: errors and confirms only (P9). Traps focus, Esc closes, focus returns. */
export function Dialog(props: OverlayProps) {
  return <Overlay {...props} kind="ch-dialog" />;
}

export interface ConfirmDialogProps extends Omit<OverlayProps, 'children' | 'footer' | 'initialFocus'> {
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** Destructive confirms use the soft danger button (never a filled red one) and start focused on Cancel. */
  destructive?: boolean;
  /** Disables Confirm and shows its spinner while the action runs. */
  busy?: boolean;
}

/** Confirm variant (role=alertdialog): a title, one sentence, Cancel and a verb button. Flat scrim, no blur. */
export function ConfirmDialog({ confirmLabel, cancelLabel, onConfirm, destructive, busy, locale = 'en', onOpenChange, ...props }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Overlay
      {...props}
      locale={locale}
      onOpenChange={onOpenChange}
      kind="ch-dialog ch-dialog--confirm"
      role="alertdialog"
      initialFocus={destructive ? cancelRef : confirmRef}
      footer={(
        <>
          <Button ref={cancelRef} onClick={() => onOpenChange(false)}>{cancelLabel ?? t(locale, 'action.cancel')}</Button>
          <Button ref={confirmRef} variant={destructive ? 'danger-solid' : 'primary'} loading={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    />
  );
}

export interface SheetProps extends OverlayProps {
  side?: 'bottom' | 'right';
}

/** Sheet: the default for inline flows (pay, item options). Bottom on phones, right on desktop. */
export function Sheet({ side = 'bottom', ...props }: SheetProps) {
  return <Overlay {...props} kind={cx('ch-sheet', `ch-sheet--${side}`)} />;
}

/* ---------------- Toast ---------------- */

export type ToastTone = 'info' | 'success' | 'danger';
interface ToastItem { id: number; message: string; tone: ToastTone }
interface ToastApi { show: (message: string, tone?: ToastTone) => void }

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const toneIcon = { info: icons.info, success: icons.check, danger: icons.alert } as const;

/** Toasts are announced by live regions: polite for info/success, assertive for danger. */
export function ToastProvider({ children, duration = 5000, locale = 'en' }: { children: ReactNode; duration?: number; locale?: Locale }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const show = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = ++seq.current;
    setItems((cur) => [...cur.slice(-2), { id, message, tone }]);
  }, []);
  const dismiss = useCallback((id: number) => setItems((cur) => cur.filter((i) => i.id !== id)), []);
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="ch-toasts">
        <div role="status" aria-live="polite" aria-relevant="additions">
          {items.filter((i) => i.tone !== 'danger').map((i) => <ToastView key={i.id} item={i} duration={duration} onDismiss={dismiss} locale={locale} />)}
        </div>
        <div role="alert" aria-live="assertive" aria-relevant="additions">
          {items.filter((i) => i.tone === 'danger').map((i) => <ToastView key={i.id} item={i} duration={duration} onDismiss={dismiss} locale={locale} />)}
        </div>
      </div>
    </ToastCtx.Provider>
  );
}

function ToastView({ item, duration, onDismiss, locale }: { item: ToastItem; duration: number; onDismiss: (id: number) => void; locale: Locale }) {
  useEffect(() => {
    // Errors stay until dismissed so they are never missed.
    if (item.tone === 'danger') return;
    const timer = setTimeout(() => onDismiss(item.id), duration);
    return () => clearTimeout(timer);
  }, [item, duration, onDismiss]);
  return (
    <div className={cx('ch-toast', `ch-toast--${item.tone}`)}>
      <span className="ch-toast__icon">{toneIcon[item.tone]}</span>
      <span className="ch-toast__msg">{item.message}</span>
      <button type="button" className="ch-btn ch-btn--ghost ch-btn--icon" aria-label={t(locale, 'action.dismiss')} onClick={() => onDismiss(item.id)}>{icons.x}</button>
    </div>
  );
}
