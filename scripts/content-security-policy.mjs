const STATIC_CONNECT_SOURCES = [
  "'self'",
  'https://overpass-api.de',
  'https://overpass.kumi.systems',
  'https://api.open-meteo.com',
  'https://archive-api.open-meteo.com',
  'https://nominatim.openstreetmap.org',
];

const splitList = (value = '') => String(value || '')
  .split(/[\s,]+/)
  .map((item) => item.trim())
  .filter(Boolean);

const normalizeAllowedOrigin = (value = '') => {
  try {
    const raw = String(value || '').trim();
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.protocol === 'https:' ? url.origin.toLowerCase() : '';
  } catch {
    return '';
  }
};

const isLocalOrPrivateHost = (hostname = '') => {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  return host === '::' ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:');
};

const isIpLiteralHost = (hostname = '') => {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
};

const cspSourceForUrl = (value, trustedOrigins = '') => {
  if (!value) return '';
  try {
    const url = new URL(value);
    const origin = url.origin.toLowerCase();
    const allowlist = splitList(trustedOrigins).map(normalizeAllowedOrigin).filter(Boolean);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || isLocalOrPrivateHost(url.hostname) || isIpLiteralHost(url.hostname)) return '';
    if (allowlist.length && !allowlist.includes(origin)) return '';
    return origin;
  } catch {
    return '';
  }
};

const devConnectSources = (enabled) => (
  enabled
    ? ['ws://localhost:*', 'ws://127.0.0.1:*', 'http://localhost:*', 'http://127.0.0.1:*']
    : []
);

export function buildContentSecurityPolicy({ apiUrl = '', trustedApiOrigins = '', reportUri = '/csp-report', dev = false } = {}) {
  const connectSources = [
    ...STATIC_CONNECT_SOURCES,
    cspSourceForUrl(apiUrl, trustedApiOrigins),
    ...devConnectSources(dev),
  ].filter(Boolean);

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://*.tile.openstreetmap.fr",
    "font-src 'self' data:",
    `connect-src ${[...new Set(connectSources)].join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `report-uri ${reportUri}`,
  ].join('; ');
}
