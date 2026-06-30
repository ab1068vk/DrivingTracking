const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function normalizeHttpsEndpoint(value, { allowLoopbackHttp = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }

  const host = url.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(host);
  const allowedProtocol = url.protocol === 'https:' || (
    allowLoopbackHttp &&
    url.protocol === 'http:' &&
    isLoopback
  );
  if (!allowedProtocol) return '';

  return url.toString().replace(/\/$/, '');
}

export function describeEndpointValidationError(value, { allowLoopbackHttp = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const isAllowedLoopbackHttp = allowLoopbackHttp &&
      url.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(host);
    if (url.protocol !== 'https:' && !isAllowedLoopbackHttp) {
      return allowLoopbackHttp
        ? 'Endpoint must use HTTPS, except loopback HTTP for local development.'
        : 'Endpoint must use HTTPS.';
    }
    return '';
  } catch {
    return 'Endpoint must be a valid URL.';
  }
}
