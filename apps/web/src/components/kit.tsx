/**
 * G-21 — the base components from `03-UX-SPEC.md` §۴ that the app was still drawing by hand.
 *
 * The rule in the spec is blunt: *if a component is not in the list, ask before building it* — and
 * every listed one must have a sample in `StyleGuidePage`. These were the gaps (Button, Card,
 * QuantityChip, StatusBadge, Countdown, BottomSheet, TextField, NumberStepper, SegmentedControl,
 * RangeSlider, RadioCard, Avatar).
 *
 * Everything here is a thin shell over the existing `.card` / `.btn` / `.input` classes and the
 * colour tokens, so there is exactly one place a look can change and no page has to re-invent a
 * chip. Pure logic lives in `lib/kit.ts` where it can be tested without a DOM.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { t } from '../lib/i18n.js';
import {
  badgeTone,
  clampCount,
  countdownLabel,
  nextStep,
  splitClock,
  statusLabel,
  type SegmentedOption,
  type StatusTone,
} from '../lib/kit.js';
import { formatToman } from '@benzin/shared';

/* ------------------------------------------------------------------ Button */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn btn-primary',
  secondary: 'btn',
  ghost: 'btn btn-ghost',
  danger: 'btn btn-danger',
};

/**
 * One button, four looks. `aria-busy` is set while loading so a screen reader hears the wait, and
 * the button stays disabled so a double tap cannot send the same order twice.
 */
export function Button({
  children,
  variant = 'secondary',
  loading = false,
  disabled = false,
  type = 'button',
  onClick,
  className = '',
  fullWidth = false,
  testId,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  onClick?: () => void;
  className?: string;
  fullWidth?: boolean;
  testId?: string;
}): JSX.Element {
  return (
    <button
      type={type}
      className={`${BUTTON_CLASS[variant]} ${fullWidth ? 'w-full' : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onClick}
      data-testid={testId}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="inline-block h-4 w-4 animate-spin rounded-pill border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------- Card */

/** A surface with a title. Cards never nest more than one level — the spec forbids the visual noise. */
export function Card({
  children,
  title,
  action,
  tone = 'plain',
  testId,
}: {
  children: ReactNode;
  title?: string;
  action?: ReactNode;
  tone?: 'plain' | 'brand' | 'warn' | 'danger';
  testId?: string;
}): JSX.Element {
  const surface =
    tone === 'brand'
      ? 'border-brand/40 bg-brandSoft'
      : tone === 'warn'
        ? 'border-warning/40 bg-warning/10'
        : tone === 'danger'
          ? 'border-danger/30 bg-dangerSoft'
          : '';
  return (
    <section className={`card ${surface}`} data-testid={testId}>
      {title || action ? (
        <div className="mb-2 flex items-center justify-between gap-2">
          {title ? <h2 className="text-base font-bold">{title}</h2> : null}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/* ------------------------------------------------------------ QuantityChip */

/** Litres with the Persian unit, because «۴۰» alone on a card means nothing. */
export function QuantityChip({
  litres,
  tone = 'plain',
}: {
  litres: number;
  tone?: 'plain' | 'brand';
}): JSX.Element {
  return (
    <span
      className={`chip ${tone === 'brand' ? 'bg-brand text-brandInk' : ''}`}
      data-testid="quantity-chip"
    >
      <span className="tnum">{clampCount(litres)}</span> {t('common.litre')}
    </span>
  );
}

/* ------------------------------------------------------------- StatusBadge */

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'bg-surface2 text-muted',
  brand: 'bg-brandSoft text-brand',
  warn: 'bg-warning/15 text-warning',
  danger: 'bg-dangerSoft text-danger',
  info: 'bg-info/15 text-info',
};

/**
 * A status always carries **text next to the colour** (colour-blind rule, §۱.۱). The mapping from
 * an order status to a tone and a label lives in `lib/kit.ts` so the tests can hold it still.
 */
export function StatusBadge({ status, label }: { status: string; label?: string }): JSX.Element {
  const tone = badgeTone(status);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-bold ${TONE_CLASS[tone]}`}
      data-testid="status-badge"
      data-tone={tone}
    >
      <span aria-hidden="true">●</span>
      {label ?? statusLabel(status)}
    </span>
  );
}

/* ---------------------------------------------------------------- Countdown */

/**
 * Time left, as text (not a ticking ring) — for lists, where a ring per row would be noise.
 * The spec asks for a 10-second tick: `useNow(10_000)` on the page pins the interval.
 */
export function Countdown({
  dueAt,
  now,
  warnBelowMs = 5 * 60 * 1000,
}: {
  dueAt: string | number | Date;
  now: number;
  /** Under this much time left the label turns warning-coloured. */
  warnBelowMs?: number;
}): JSX.Element {
  const remaining = new Date(dueAt).getTime() - now;
  const { minutes, seconds } = splitClock(remaining);
  const tone =
    remaining <= 0 ? 'text-danger' : remaining < warnBelowMs ? 'text-warning' : 'text-muted';
  return (
    <span className={`text-xs font-medium tnum ${tone}`} data-testid="countdown">
      {remaining <= 0 ? t('common.expired') : countdownLabel(minutes, seconds)}
    </span>
  );
}

/* --------------------------------------------------------------- BottomSheet */

/** The one sheet shape the app uses: rounded top, drag handle, safe-area padding. */
export function BottomSheet({
  open,
  title,
  children,
  footer,
  onClose,
  testId,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  testId?: string;
}): JSX.Element | null {
  const titleId = useId();
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-sheet flex items-end justify-center bg-black/40">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId ?? 'bottom-sheet'}
        className="w-full max-w-phone rounded-t-sheet border-t border-line bg-surface p-4 pb-[calc(var(--safe-bottom)+var(--space-4))] shadow-sheet outline-none"
      >
        <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-pill bg-line" />
        <h2 id={titleId} className="mb-2 text-base font-bold">
          {title}
        </h2>
        {children}
        {footer ? <div className="mt-4 flex gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- TextField */

/** A label that stays visible (placeholder-only inputs are banned in §۵). */
export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  required = false,
  type = 'text',
  dir,
  inputMode,
  maxLength,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  type?: 'text' | 'tel' | 'number' | 'password';
  dir?: 'rtl' | 'ltr';
  inputMode?: 'text' | 'numeric' | 'tel';
  maxLength?: number;
  testId?: string;
}): JSX.Element {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="mb-3">
      <label className="label" htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-danger">
            {' '}
            *
          </span>
        ) : null}
      </label>
      <input
        id={id}
        className="input"
        type={type}
        dir={dir}
        inputMode={inputMode}
        maxLength={maxLength}
        value={value}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- NumberStepper */

/** −/+ around a number. Steps come from the caller, so litres and days can share it. */
export function NumberStepper({
  value,
  onChange,
  step = 1,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  label,
  suffix,
  testId,
}: {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  label: string;
  suffix?: string;
  testId?: string;
}): JSX.Element {
  const down = nextStep(value, -step, min, max);
  const up = nextStep(value, step, min, max);
  return (
    <div className="flex items-center gap-2" data-testid={testId ?? 'number-stepper'}>
      <button
        type="button"
        className="btn min-h-tap min-w-tap px-0 text-lg"
        aria-label={t('common.decrease')}
        disabled={down === value}
        onClick={() => onChange(down)}
      >
        −
      </button>
      <div className="flex-1 text-center">
        <span className="label mb-0">{label}</span>
        <p className="money text-lg">
          <span className="tnum">{clampCount(value)}</span>
          {suffix ? <span className="text-xs font-normal text-muted"> {suffix}</span> : null}
        </p>
      </div>
      <button
        type="button"
        className="btn min-h-tap min-w-tap px-0 text-lg"
        aria-label={t('common.increase')}
        disabled={up === value}
        onClick={() => onChange(up)}
      >
        +
      </button>
    </div>
  );
}

/* --------------------------------------------------------- SegmentedControl */

/** The buy/sell switch. Two or three equal cells, the active one filled with the brand colour. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  testId,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  testId?: string;
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={label}
      data-testid={testId ?? 'segmented-control'}
      className="flex gap-1 rounded-sm border border-line bg-surface2 p-1"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={`min-h-tap flex-1 rounded-xs px-2 text-sm font-medium transition duration-fast ${
              active ? 'bg-brand text-brandInk' : 'text-muted hover:text-ink'
            }`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- RangeSlider */

/**
 * A native range input: keyboard-accessible for free, and the only slider the spec allows
 * (§۴). Values are rendered as plain numbers above the track because a thumb position is not a
 * quantity anyone can read.
 */
export function RangeSlider({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  format,
  testId,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  format?: (value: number) => string;
  testId?: string;
}): JSX.Element {
  const id = useId();
  return (
    <div data-testid={testId ?? 'range-slider'}>
      <div className="mb-1 flex items-center justify-between">
        <label className="label mb-0" htmlFor={id}>
          {label}
        </label>
        <span className="money text-sm">{format ? format(value) : clampCount(value)}</span>
      </div>
      <input
        id={id}
        className="w-full accent-brand"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div className="flex justify-between text-xs text-muted">
        <span className="tnum">{format ? format(min) : min}</span>
        <span className="tnum">{format ? format(max) : max}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- RadioCard */

/** Plans and payment methods: a full-width card that behaves like a radio. */
export function RadioCard({
  name,
  checked,
  onSelect,
  title,
  subtitle,
  price,
  badge,
  disabled = false,
  testId,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  subtitle?: string;
  price?: number;
  badge?: ReactNode;
  disabled?: boolean;
  testId?: string;
}): JSX.Element {
  const id = useId();
  return (
    <label
      htmlFor={id}
      data-testid={testId ?? 'radio-card'}
      className={`mb-2 flex min-h-tap cursor-pointer items-start gap-3 rounded-card border p-3 transition duration-fast ${
        checked ? 'border-brand bg-brandSoft' : 'border-line bg-surface hover:bg-surface2'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <input
        id={id}
        type="radio"
        name={name}
        className="mt-1 h-5 w-5 accent-brand"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-bold">{title}</span>
          {price === undefined ? null : (
            <span className="money text-sm">
              {formatToman(price)}{' '}
              <span className="text-xs font-normal text-muted">{t('common.toman')}</span>
            </span>
          )}
        </span>
        {subtitle ? <span className="mt-1 block text-xs text-muted">{subtitle}</span> : null}
        {badge ? <span className="mt-2 block">{badge}</span> : null}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------- Avatar */

/** Initials, because the product never uploads a profile photo. */
export function Avatar({ name, size = 40 }: { name: string; size?: number }): JSX.Element {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('');
  return (
    <span
      aria-hidden="true"
      className="grid place-items-center rounded-pill bg-brandSoft font-bold text-brand"
      style={{ width: size, height: size, fontSize: Math.round(size / 2.6) }}
      data-testid="avatar"
    >
      {initials || '؟'}
    </span>
  );
}
