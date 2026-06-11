const REDACTED = '[REDACTED]';
const TIMESTAMP_REDACTED = '[TS_REDACTED]';
const MAX_DEPTH = 15;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 2000;

const GPS_COORD_RE = /(-?\d{1,3}\.\d{4,})(?:\s*[,;]\s*|\s+)(-?\d{1,3}\.\d{4,})/g;
const LABELED_COORD_RE = /(\b(?:lat(?:itude)?|lng|lon(?:gitude)?)\b"?\s*[:=]\s*)-?\d{1,3}(?:\.\d+)?/gi;
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/gi;
const EPOCH_CANDIDATE_RE = /\b\d{10,13}\b/g;

const SENSITIVE_KEYS = new Set([
  'latitude',
  'longitude',
  'lat',
  'lng',
  'lon',
  'gps',
  'gpspoint',
  'gpspoints',
  'rawgpspoint',
  'rawgpspoints',
  'coordinate',
  'coordinates',
  'coords',
  'location',
  'locations',
  'parkedlocation',
  'route',
  'routepoint',
  'routepoints',
  'rawroute',
  'rawroutepoints',
  'path',
  'polyline',
  'privacyzone',
  'privacyzones',
  'privacyzoneid',
  'privacyzonelabel',
  'privacyzoneradius',
  'zone',
  'zonecenter',
  'zoneid',
  'zonelabel',
  'zonelatitude',
  'zonelongitude',
  'zoneradius',
  'startlat',
  'startlng',
  'endlat',
  'endlng',
]);

const TIMESTAMP_KEYS = new Set([
  'timestamp',
  'timestamps',
  'time',
  'datetime',
  'createdat',
  'updatedat',
  'recordedat',
  'capturedat',
  'startedat',
  'endedat',
  'starttime',
  'endtime',
]);

const normalizeKey = (key) => String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();

const isPlausibleEpoch = (digits) => {
  const value = Number(digits);
  if (!Number.isFinite(value)) return false;
  const milliseconds = digits.length <= 10 ? value * 1000 : value;
  return milliseconds >= Date.UTC(2000, 0, 1) && milliseconds <= Date.UTC(2100, 0, 1);
};

const sanitizeString = (value) => String(value)
  .replace(GPS_COORD_RE, '[LAT_REDACTED],[LNG_REDACTED]')
  .replace(LABELED_COORD_RE, '$1[COORD_REDACTED]')
  .replace(ISO_TIMESTAMP_RE, TIMESTAMP_REDACTED)
  .replace(EPOCH_CANDIDATE_RE, (match) => (isPlausibleEpoch(match) ? TIMESTAMP_REDACTED : match))
  .slice(0, MAX_STRING_LENGTH);

const isCoordinatePair = (value) => (
  Array.isArray(value) &&
  value.length >= 2 &&
  Number.isFinite(value[0]) &&
  Number.isFinite(value[1]) &&
  Math.abs(value[0]) <= 90 &&
  Math.abs(value[1]) <= 180 &&
  (!Number.isInteger(value[0]) || !Number.isInteger(value[1]))
);

const readError = (error, depth, seen) => ({
  name: sanitizeString(error.name || 'Error'),
  message: sanitizeString(error.message || 'Unknown error'),
  stack: typeof error.stack === 'string' ? sanitizeString(error.stack) : '',
  ...(error.cause !== undefined ? { cause: redactValue(error.cause, depth + 1, seen) } : {}),
});

function redactValue(value, depth, seen) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    const digits = String(Math.trunc(value));
    return Number.isInteger(value) && isPlausibleEpoch(digits) ? TIMESTAMP_REDACTED : value;
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}]`;
  if (depth > MAX_DEPTH) return '[TRUNCATED]';

  if (value instanceof Date) return TIMESTAMP_REDACTED;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) return readError(value, depth, seen);

  if (Array.isArray(value)) {
    if (isCoordinatePair(value)) return '[LAT_REDACTED],[LNG_REDACTED]';
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, depth + 1, seen));
  }

  const output = {};
  let keys;
  try {
    keys = Object.keys(value).slice(0, MAX_OBJECT_KEYS);
  } catch {
    return { _sanitizationFailed: true };
  }

  for (const key of keys) {
    const normalizedKey = normalizeKey(key);
    if (SENSITIVE_KEYS.has(normalizedKey)) {
      output[key] = REDACTED;
    } else if (TIMESTAMP_KEYS.has(normalizedKey)) {
      output[key] = TIMESTAMP_REDACTED;
    } else {
      try {
        output[key] = redactValue(value[key], depth + 1, seen);
      } catch {
        output[key] = REDACTED;
      }
    }
  }
  return output;
}

export function sanitizeCrashPayload(payload) {
  try {
    const sanitized = redactValue(payload, 0, new WeakSet());
    return JSON.parse(JSON.stringify(sanitized));
  } catch {
    return { _sanitizationFailed: true };
  }
}
