/**
 * Display helpers for values that may not have been measured.
 *
 * Trip Detail previously rendered `?? 0` fallbacks and invented confidence
 * words, which read as measurements. These helpers make "we did not measure
 * this" a distinct, honest output instead of a confident zero.
 *
 * Kept separate from scoreDisplay.js (which owns score formatting) and free of
 * any tripEngine import so it can be used from anywhere without cycles.
 */
import { convertSpeedKmh, normalizeUnits, speedUnitLabel } from '@/lib/unitFormatting';

export const NOT_MEASURED = 'Not measured';

/**
 * Render a numeric value, or a muted fallback when it was never measured.
 * `0` is a legitimate measurement and is rendered as such - only null,
 * undefined, '' and NaN fall back.
 *
 * @param {any} value
 * @param {(n:number)=>string} [formatter]
 * @param {{ fallback?: string }} [options]
 * @returns {string}
 */
export function formatMeasured(value, formatter = (n) => String(n), { fallback = NOT_MEASURED } = {}) {
  if (value == null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return formatter(numeric);
}

/** True when a value is a real measurement rather than a missing reading. */
export function isMeasured(value) {
  return value != null && value !== '' && Number.isFinite(Number(value));
}

const CONFIDENCE_WORDS = new Set(['very_low', 'low', 'medium', 'high', 'very_high']);

/**
 * Normalize the two confidence shapes the codebase produces - a 0-1 number
 * (phoneUsageAccess writes `0.92`) and a word - into one label.
 * Returns `null` when there is no confidence to show, so callers render
 * nothing rather than inventing 'medium'.
 *
 * @param {any} value
 * @returns {string|null}
 */
export function formatConfidence(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric < 0 || numeric > 1) return null;
    if (numeric >= 0.85) return 'high';
    if (numeric >= 0.6) return 'medium';
    if (numeric >= 0.35) return 'low';
    return 'very low';
  }
  const word = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!CONFIDENCE_WORDS.has(word)) return null;
  return word.replace(/_/g, ' ');
}

/**
 * Unit table for driving-event `value` fields, keyed to what tripEngine
 * actually stores at detection time.
 * @type {Record<string, 'ms2'|'g'|'seconds'|'speed'|'deg_s'|'ratio'|'none'>}
 */
const EVENT_VALUE_KIND = Object.freeze({
  harsh_brake: 'ms2',
  rapid_acceleration: 'ms2',
  aggressive_overtake: 'ms2',
  close_proximity: 'ms2',
  sharp_turn: 'g',
  idle: 'seconds',
  erratic_speed: 'seconds',
  speeding: 'speed',
  stop_start_pattern: 'speed',
  heading_deviation: 'deg_s',
  heading_deviation_legacy: 'deg_s',
  phone_use: 'ratio',
  near_miss: 'none',
  tailgate_cycle: 'none',
});

const formatSeconds = (seconds) => (seconds >= 60
  ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  : `${Math.round(seconds)}s`);

/**
 * Render an event magnitude with the unit that magnitude is actually in.
 * Returns `null` when the event carries no meaningful magnitude, so callers
 * omit the line instead of printing "- m/s2".
 *
 * @param {any} event
 * @param {string} [units] 'metric' | 'imperial'
 * @returns {string|null}
 */
export function formatEventValue(event, units = 'metric') {
  const kind = EVENT_VALUE_KIND[event?.type] || 'none';
  if (kind === 'none') return null;
  // Number(null) is 0 and Number('') is 0, so an explicit check is required or
  // a missing magnitude renders as a measured zero.
  if (event?.value == null || event.value === '') return null;
  const numeric = Number(event.value);
  if (!Number.isFinite(numeric)) return null;
  switch (kind) {
    case 'ms2':
      return `${numeric.toFixed(1)} m/s²`;
    case 'g':
      return `${numeric.toFixed(2)} g`;
    case 'seconds':
      return formatSeconds(numeric);
    case 'deg_s':
      return `${numeric.toFixed(1)} °/s`;
    case 'ratio':
      return `${Math.round(numeric * 100)}%`;
    case 'speed': {
      const converted = convertSpeedKmh(numeric, units);
      if (converted == null) return null;
      const label = event?.type === 'stop_start_pattern'
        ? `${speedUnitLabel(units)} drop`
        : speedUnitLabel(units);
      return `${Math.round(converted)} ${label}`;
    }
    default:
      return null;
  }
}

/** Speed formatter that returns a fallback rather than "NaN km/h". */
export function formatSpeedMeasured(kmh, units = 'metric', fallback = NOT_MEASURED) {
  const converted = convertSpeedKmh(kmh, normalizeUnits(units));
  if (converted == null) return fallback;
  return `${Math.round(converted)} ${speedUnitLabel(units)}`;
}
