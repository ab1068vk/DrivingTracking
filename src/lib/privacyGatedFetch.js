import { pinnedFetch } from '@/lib/pinnedFetch';
import { logTransmission } from '@/lib/transmissionLog';
import { isStoredHeightenedPrivacyMode } from '@/lib/privacyMode';
import { logSystemFailure } from '@/lib/systemLog';

export const PRIVACY_GATEWAY_DOWNGRADE_WARNING =
  'Declared protection did not match outgoing payload precision; downgraded to raw.';

const SERVICE_PRECISION_LIMITS = Object.freeze({
  'open-meteo': Object.freeze({ rounded: 4 }),
  // Overpass boxes are snapped onto the BBOX_GRID_DEG grid in speedLimitSource,
  // so anything finer than the grid is route precision that should not be there.
  overpass: Object.freeze({ bounding_box: 3 }),
  osrm: Object.freeze({ raw: Infinity }),
});

const COORDINATE_DISCLOSURES = new Set([
  'none',
  'blocked',
  'raw',
  'rounded',
  'bounding_box',
  'masked',
  'committed',
]);

const requestUrl = (request) => {
  if (request instanceof URL) return request.toString();
  if (typeof Request !== 'undefined' && request instanceof Request) return request.url;
  if (typeof request === 'string') return request;
  return String(request?.url || request?.href || '');
};

const requestInit = (request) => {
  if (!request || request instanceof URL || typeof request === 'string') return {};
  if (typeof Request !== 'undefined' && request instanceof Request) {
    return {
      method: request.method,
      headers: request.headers,
      body: null,
      signal: request.signal,
    };
  }
  return {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  };
};

const bodyText = (body) => {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const parts = [];
    body.forEach((value, key) => {
      parts.push(`${key}=${value}`);
    });
    return parts.join('&');
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return '';
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
};

const decodeLoose = (value) => {
  const text = String(value || '').replace(/\+/g, ' ');
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const decimalPlaces = (raw) => {
  const mantissa = String(raw || '').split(/[eE]/)[0];
  const [, decimals = ''] = mantissa.split('.');
  return decimals.length;
};

const isLatLngPair = (lat, lng) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

export function inspectRequestCoordinates(request) {
  const init = requestInit(request);
  const url = requestUrl(request);
  const body = bodyText(init.body);
  const haystack = `${decodeLoose(url)} ${decodeLoose(body)}`;
  const matches = Array.from(haystack.matchAll(/[-+]?(?:\d+\.\d+|\d+)(?:[eE][-+]?\d+)?/g));
  const coordinatePairs = [];

  for (let index = 0; index < matches.length - 1; index += 1) {
    const firstRaw = matches[index][0];
    const secondRaw = matches[index + 1][0];
    const first = Number(firstRaw);
    const second = Number(secondRaw);
    if (!Number.isFinite(first) || !Number.isFinite(second)) continue;

    const latLng = isLatLngPair(first, second);
    const lngLat = isLatLngPair(second, first);
    if (!latLng && !lngLat) continue;

    coordinatePairs.push({
      values: latLng ? [first, second] : [second, first],
      order: latLng ? 'lat_lng' : 'lng_lat',
      maxDecimalPlaces: Math.max(decimalPlaces(firstRaw), decimalPlaces(secondRaw)),
    });
  }

  return {
    url,
    body,
    coordinatePairs,
    maxDecimalPlaces: coordinatePairs.reduce(
      (max, pair) => Math.max(max, pair.maxDecimalPlaces),
      0
    ),
  };
}

const requestBytesOut = (request, inspection = inspectRequestCoordinates(request)) => (
  inspection.url.length + inspection.body.length
);

const precisionLimitFor = (service, disclosure) => (
  SERVICE_PRECISION_LIMITS[service]?.[disclosure] ?? Infinity
);

const defaultEvidence = ({ coordinateDisclosure, service, inspection, precisionLimit, downgraded }) => {
  if (downgraded) return ['privacy gateway inspected URL/body precision before send'];
  if (!inspection.coordinatePairs.length) return ['privacy gateway found no coordinate-shaped payload data'];
  if (coordinateDisclosure === 'raw') return ['privacy gateway found coordinate data and logged raw disclosure'];
  if (Number.isFinite(precisionLimit)) {
    return [`privacy gateway verified ${service} payload precision <= ${precisionLimit} decimals`];
  }
  return ['privacy gateway inspected outgoing URL/body payload'];
};

function normalizeBlockResult(result) {
  if (!result) return null;
  if (result === true) return { blocked: true };
  if (typeof result === 'object') return { ...result, blocked: true };
  return null;
}

export async function privacyGatedFetch(service, request, options = {}) {
  const declaredDisclosure = COORDINATE_DISCLOSURES.has(options.coordinateDisclosure)
    ? options.coordinateDisclosure
    : 'none';
  const init = requestInit(request);
  const url = requestUrl(request);
  const guardBlock = normalizeBlockResult(await options.guard?.({ service, request, options }));
  const directBlock = normalizeBlockResult(options.block);
  const heightenedBlock = isStoredHeightenedPrivacyMode() &&
    ['open-meteo', 'overpass', 'osrm'].includes(service)
    ? {
      blocked: true,
      reason: 'heightened_privacy_mode',
      privacyVerificationEvidence: ['heightened privacy mode blocked this external lookup before network send'],
      protections: ['heightened privacy mode'],
    }
    : null;
  const block = guardBlock || directBlock || heightenedBlock;
  const source = `privacyGatedFetch:${service}`;

  if (block) {
    const logRecord = await logTransmission({
      service,
      type: options.type || 'Outbound request',
      coordinateDisclosure: 'blocked',
      privacyTransformVerified: true,
      privacyTransformSource: source,
      privacyVerificationEvidence: block.privacyVerificationEvidence ||
        options.privacyVerificationEvidence ||
        ['privacy gateway blocked request before network send'],
      sentCoords: null,
      protections: block.protections || options.protections || ['request blocked before send'],
      offsetMeters: options.offsetMeters ?? null,
      bytesOut: 0,
      status: 'blocked',
      tripId: options.tripId ?? null,
      zonesSuppressed: block.zonesSuppressed || options.zonesSuppressed || [],
    });
    return { blocked: true, reason: block.reason || 'blocked', logRecord };
  }

  const inspection = inspectRequestCoordinates(request);
  const precisionLimit = precisionLimitFor(service, declaredDisclosure);
  const downgraded = declaredDisclosure !== 'raw' &&
    inspection.coordinatePairs.length > 0 &&
    inspection.maxDecimalPlaces > precisionLimit;
  const coordinateDisclosure = downgraded ? 'raw' : declaredDisclosure;
  const privacyVerificationWarnings = downgraded ? [PRIVACY_GATEWAY_DOWNGRADE_WARNING] : [];
  const privacyTransformVerified = !downgraded;
  const privacyVerificationEvidence = [
    ...defaultEvidence({
      coordinateDisclosure,
      service,
      inspection,
      precisionLimit,
      downgraded,
    }),
    ...(Array.isArray(options.privacyVerificationEvidence) ? options.privacyVerificationEvidence : []),
  ];

  const logRecord = await logTransmission({
    service,
    type: options.type || 'Outbound request',
    coordinateDisclosure,
    privacyTransformVerified,
    privacyTransformSource: source,
    privacyVerificationEvidence,
    privacyVerificationWarnings,
    sentCoords: options.sentCoords ?? (
      inspection.coordinatePairs.length ? `${inspection.coordinatePairs.length} coordinate pair(s)` : null
    ),
    protections: options.protections || [],
    offsetMeters: options.offsetMeters ?? null,
    bytesOut: requestBytesOut(request, inspection),
    status: options.status || 'safe',
    tripId: options.tripId ?? null,
    zonesSuppressed: options.zonesSuppressed || [],
  });

  // A request that a different transport will actually send still has to pass
  // the same inspection and land in the transmission log, or the privacy console
  // under-reports what left the device.
  if (options.logOnly === true) {
    return { blocked: false, logged: true, privacyTransformVerified, coordinateDisclosure, logRecord };
  }

  try {
    return await (options.fetchImpl || pinnedFetch)(url, init);
  } catch (error) {
    logSystemFailure('privacy_gateway_fetch_failed', error, {
      service,
      request_logged: true,
      disclosure_level: coordinateDisclosure,
      verified_before_send: privacyTransformVerified === true,
      bytes_out: requestBytesOut(request, inspection),
    });
    throw error;
  }
}
