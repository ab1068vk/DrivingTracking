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

export const parseTrustedOrigins = (value = '') => [
  ...new Set(splitList(value).map(normalizeAllowedOrigin).filter(Boolean)),
];

const stripIpv6Brackets = (hostname = '') => hostname.replace(/^\[|\]$/g, '');

const ipv4Parts = (hostname = '') => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const parts = hostname.split('.').map(Number);
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
};

export const isLocalOrPrivateHostname = (hostname = '') => {
  const host = stripIpv6Brackets(String(hostname || '').trim().toLowerCase().replace(/\.$/, ''));
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const v4 = ipv4Parts(host);
  if (v4) {
    const [a, b] = v4;
    return a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }

  if (host.includes(':')) {
    return host === '::' ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80:');
  }

  return false;
};

export const isIpAddressHostname = (hostname = '') => {
  const host = stripIpv6Brackets(String(hostname || '').trim().toLowerCase().replace(/\.$/, ''));
  return Boolean(ipv4Parts(host)) || host.includes(':');
};

export function normalizeTrustedHttpsEndpoint(endpoint, {
  label = 'Endpoint',
  allowedOrigins = [],
  blockedOrigins = [],
} = {}) {
  const raw = String(endpoint || '').trim();
  if (!raw) {
    return { ok: false, configured: false, error: '' };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      configured: true,
      error: `${label} must be a valid absolute URL.`,
    };
  }

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      configured: true,
      error: `${label} must use HTTPS.`,
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      configured: true,
      error: `${label} must not include credentials.`,
    };
  }

  if (url.search) {
    return {
      ok: false,
      configured: true,
      error: `${label} must not include query parameters.`,
    };
  }

  if (isLocalOrPrivateHostname(url.hostname) || isIpAddressHostname(url.hostname)) {
    return {
      ok: false,
      configured: true,
      error: `${label} must use a public HTTPS domain, not localhost, private-network addresses, or IP literals.`,
    };
  }

  url.hash = '';
  const origin = url.origin.toLowerCase();
  const allowlist = [...new Set((allowedOrigins || []).map(normalizeAllowedOrigin).filter(Boolean))];
  const blocklist = [...new Set((blockedOrigins || []).map(normalizeAllowedOrigin).filter(Boolean))];

  if (blocklist.includes(origin)) {
    return {
      ok: false,
      configured: true,
      error: `${label} is blocked for this app.`,
    };
  }

  if (allowlist.length && !allowlist.includes(origin)) {
    return {
      ok: false,
      configured: true,
      error: `${label} is not in the trusted endpoint allowlist.`,
    };
  }

  return {
    ok: true,
    configured: true,
    url: url.toString().replace(/\/$/, ''),
    origin,
    domain: url.hostname.toLowerCase(),
  };
}
