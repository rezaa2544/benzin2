import { useState } from 'react';
import { toPersianDigits } from '@benzin/shared';
import {
  boundsOfRing,
  centerOf,
  currentPosition,
  fractionOfPoint,
  pointAtFraction,
  type Bounds,
  type LatLng,
  type Ring,
} from '../lib/geo.js';
import { t } from '../lib/i18n.js';

export interface MapPickerProps {
  /** City outline from `/v1/zones`; a listing must sit inside it. */
  boundary?: Ring | null;
  /** Falls back to the boundary's bounds when the caller has none. */
  bounds?: Bounds | null;
  value: LatLng | null;
  onChange: (point: LatLng | null) => void;
  label?: string;
  hint?: string;
  /** Offers «موقعیت فعلی من» — off for the listing form, on for the search origin. */
  allowCurrent?: boolean;
  compact?: boolean;
}

const KEYBOARD_STEP = 0.03;

/**
 * G-07 point picker. It is deliberately dependency-free: the tile map providers the
 * product will use later need an API key and a network, so the box draws the city polygon
 * the API already knows about and lets the owner tap inside it. Tapping, dragging the
 * crosshair with the arrow keys, or asking the browser for the position all end in one
 * coordinate pair, which is exactly what `POST /v1/orders` expects.
 */
export function MapPicker({
  boundary,
  bounds: boundsProp,
  value,
  onChange,
  label,
  hint,
  allowCurrent = false,
  compact = false,
}: MapPickerProps): JSX.Element {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bounds = boundsProp ?? boundsOfRing(boundary) ?? null;
  const ring = boundary && boundary.length >= 3 ? boundary : null;
  const fraction = value && bounds ? fractionOfPoint(bounds, value) : null;

  const setFromFractions = (x: number, y: number): void => {
    if (!bounds) return;
    setNote(null);
    onChange(pointAtFraction(bounds, x, y));
  };

  const onPointer = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!bounds) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    setFromFractions(
      (event.clientX - box.left) / box.width,
      (event.clientY - box.top) / box.height,
    );
  };

  const onKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!bounds) return;
    const current = fraction ?? { x: 0.5, y: 0.5 };
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-KEYBOARD_STEP, 0],
      ArrowRight: [KEYBOARD_STEP, 0],
      ArrowUp: [0, -KEYBOARD_STEP],
      ArrowDown: [0, KEYBOARD_STEP],
    };
    const move = moves[event.key];
    if (!move) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setFromFractions(current.x, current.y);
      }
      return;
    }
    event.preventDefault();
    setFromFractions(current.x + move[0], current.y + move[1]);
  };

  const useMyLocation = async (): Promise<void> => {
    setBusy(true);
    const result = await currentPosition();
    setBusy(false);
    if (result.point) {
      onChange(result.point);
      setNote(null);
      return;
    }
    setNote(
      result.failure === 'denied'
        ? t('map.denied')
        : result.failure === 'unsupported'
          ? t('map.unsupported')
          : t('map.unavailable'),
    );
  };

  const ringPoints = (): string => {
    if (!ring || !bounds) return '';
    const spanLng = bounds.maxLng - bounds.minLng || 1;
    const spanLat = bounds.maxLat - bounds.minLat || 1;
    return ring
      .map(([lng, lat]) => {
        const x = ((lng - bounds.minLng) / spanLng) * 100;
        const y = ((bounds.maxLat - lat) / spanLat) * 100;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  };

  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="label mb-0">{label ?? t('map.title')}</span>
        <div className="flex gap-1">
          {allowCurrent ? (
            <button
              type="button"
              className="chip"
              disabled={busy}
              onClick={() => void useMyLocation()}
            >
              {busy ? t('map.locating') : t('map.myLocation')}
            </button>
          ) : null}
          {value ? (
            <button
              type="button"
              className="chip text-muted"
              onClick={() => {
                setNote(null);
                onChange(null);
              }}
            >
              {t('map.clear')}
            </button>
          ) : null}
        </div>
      </div>

      <div
        role="application"
        tabIndex={0}
        aria-label={t('map.aria')}
        onClick={onPointer}
        onKeyDown={onKey}
        className={`relative w-full cursor-crosshair overflow-hidden rounded-sm border border-line bg-surface2 focus-visible:ring-2 focus-visible:ring-brand ${
          compact ? 'h-32' : 'h-44'
        }`}
      >
        {bounds ? (
          <svg
            aria-hidden
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
          >
            {[25, 50, 75].map((line) => (
              <g key={line} stroke="currentColor" className="text-line" strokeWidth="0.4">
                <line x1={line} y1={0} x2={line} y2={100} />
                <line x1={0} y1={line} x2={100} y2={line} />
              </g>
            ))}
            {ring ? (
              <polygon
                points={ringPoints()}
                className="text-brand"
                fill="currentColor"
                fillOpacity="0.08"
                stroke="currentColor"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
        ) : null}

        {fraction ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-danger"
            style={{ left: `${fraction.x * 100}%`, top: `${fraction.y * 100}%` }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="5" fill="currentColor" />
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            </svg>
          </span>
        ) : (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted">
            {bounds ? t('map.empty') : t('map.noZone')}
          </span>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center justify-between gap-1 text-xs text-muted">
        <span>{hint ?? t('map.privacy')}</span>
        {value ? (
          <span className="tnum" dir="ltr">
            {toPersianDigits(value.lat.toFixed(4))}, {toPersianDigits(value.lng.toFixed(4))}
          </span>
        ) : null}
      </div>
      {note ? <p className="mt-1 text-xs text-danger">{note}</p> : null}
    </div>
  );
}

/** Convenience: the default point for a picker with no stored value. */
export function defaultPoint(boundary: Ring | null | undefined): LatLng | null {
  const bounds = boundsOfRing(boundary);
  return bounds ? centerOf(bounds) : null;
}
