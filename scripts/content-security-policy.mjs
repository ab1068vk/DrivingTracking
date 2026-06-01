const STATIC_CONNECT_SOURCES = [
  "'self'",
  'https://overpass-api.de',
  'https://api.open-meteo.com',
  'https://nominatim.openstreetmap.org',
  'https://staticmap.openstreetmap.de',
];

const cspSourceForUrl = (value) => {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
};

const devConnectSources = (enabled) => (
  enabled
    ? ['ws://localhost:*', 'ws://127.0.0.1:*', 'http://localhost:*', 'http://127.0.0.1:*']
    : []
);

export function buildContentSecurityPolicy({ apiUrl = '', reportUri = '/csp-report', dev = false } = {}) {
  const connectSources = [
    ...STATIC_CONNECT_SOURCES,
    cspSourceForUrl(apiUrl),
    ...devConnectSources(dev),
  ].filter(Boolean);

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://staticmap.openstreetmap.de",
    "font-src 'self' data:",
    `connect-src ${[...new Set(connectSources)].join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `report-uri ${reportUri}`,
  ].join('; ');
}
