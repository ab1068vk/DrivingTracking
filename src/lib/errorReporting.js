import { recordTrackingDiagnostic } from '@/lib/trackingDiagnostics';

const COORDINATE_PATTERN = /\b-?\d{1,3}\.\d{4,}\b/g;
const URL_QUERY_PATTERN = /([?&])(lat|lon|lng|latitude|longitude|center|q|query|coordinates|address|geocode)=[^&\s"')]+/gi;
const SENSITIVE_EXTRA_KEYS = new Set([
  'lat',
  'lng',
  'lon',
  'latitude',
  'longitude',
  'coordinates',
  'coordinate',
  'coords',
  'route_points',
  'routePoints',
  'raw_route_points',
  'address',
  'geocode',
  'reverse_geocode',
  'reverseGeocode',
]);
const ERROR_DEDUPE_WINDOW_MS = 2000;
const recentErrorEvents = new Map();

export const scrubDiagnosticText = (value = '', maxLength = 500) => String(value || '')
  .replace(URL_QUERY_PATTERN, (_match, separator, key) => `${separator}${key}=[REDACTED]`)
  .replace(COORDINATE_PATTERN, '[COORD]')
  .slice(0, maxLength);

export const sanitizeError = (error) => {
  const value = error?.reason || error?.error || error;
  const name = value?.name || 'Error';
  const message = scrubDiagnosticText(value?.message || value || 'Unknown error', 500);
  const stack = typeof value?.stack === 'string'
    ? value.stack
      .split('\n')
      .slice(0, 3)
      .map((line) => scrubDiagnosticText(line, 1000).replace(/https?:\/\/[^)\s]+/g, '[url]').replace(/[A-Z]:\\[^)\s]+/gi, '[path]'))
      .join('\n')
      .slice(0, 1000)
    : '';
  return { name, message, stack };
};

const sanitizeDiagnosticExtra = (extra = {}) => {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {};

  const sanitized = {};
  for (const [key, value] of Object.entries(extra)) {
    if (SENSITIVE_EXTRA_KEYS.has(key)) {
      sanitized[`${key}_redacted`] = true;
      continue;
    }
    if (typeof value === 'string') {
      sanitized[key] = scrubDiagnosticText(value, 500);
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
};

export function logError(context, error, extra = {}) {
  const sanitized = sanitizeError(error);
  const safeExtra = sanitizeDiagnosticExtra(extra);
  const dedupeKey = [
    context,
    sanitized.name,
    sanitized.message,
    JSON.stringify(safeExtra),
  ].join('|');
  const now = Date.now();
  const recent = recentErrorEvents.get(dedupeKey);
  if (recent && now - recent.at < ERROR_DEDUPE_WINDOW_MS) return recent.event;

  const event = recordTrackingDiagnostic({
    type: 'operation_error',
    title: `Operation failed: ${context}`,
    detail: sanitized.message,
    context,
    error_name: sanitized.name,
    stack_preview: sanitized.stack,
    ...safeExtra,
  });
  recentErrorEvents.set(dedupeKey, { at: now, event });
  return event;
}

export function initializeErrorReporting() {
  if (typeof window === 'undefined' || window.__roadSageErrorReportingInitialized) return;
  window.__roadSageErrorReportingInitialized = true;

  const report = (type, event) => {
    logError(type, event, { type, title: 'App error captured' });
  };

  window.addEventListener('error', (event) => report('js_error', event));
  window.addEventListener('unhandledrejection', (event) => report('unhandled_rejection', event));
}
