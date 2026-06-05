const OSRM_HEALTH_TIMEOUT_MS = 5000;
const OSRM_HEADER_NAMES = [
  'x-osrm',
  'x-osrm-backend',
  'x-osrm-engine',
  'x-osrm-version',
];

const normalizeEndpointUrl = (endpoint) => {
  const url = new URL(String(endpoint || '').trim());
  url.hash = '';
  return url.toString().replace(/\/$/, '');
};

const hasOsrmHeaderName = (name = '') => OSRM_HEADER_NAMES.includes(String(name).toLowerCase());

const hasOsrmHeaderValue = (value = '') => String(value).toLowerCase().includes('osrm');

export const readableOsrmHeader = (headers) => {
  if (!headers) return null;
  for (const name of OSRM_HEADER_NAMES) {
    const value = headers.get?.(name);
    if (value) return { name, value };
  }
  if (typeof headers.entries === 'function') {
    for (const [name, value] of headers.entries()) {
      if (hasOsrmHeaderName(name) || hasOsrmHeaderValue(value)) return { name, value };
    }
  }
  return null;
};

export function buildOsrmHealthPatch(result) {
  return {
    osrm_health_status: result.ok ? 'connected' : 'unreachable',
    osrm_last_health_checked_at: result.checked_at,
    osrm_last_health_error: result.error || '',
    ...(result.ok ? { osrm_last_reachable_at: result.checked_at } : {}),
  };
}

export async function checkOsrmEndpointHealth(endpoint) {
  let url;
  try {
    url = normalizeEndpointUrl(endpoint);
  } catch {
    return {
      status: 'unreachable',
      ok: false,
      checked_at: new Date().toISOString(),
      error: 'The OSRM endpoint is not a valid URL.',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OSRM_HEALTH_TIMEOUT_MS);
    const response = await fetch(url, {
      method: 'OPTIONS',
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (response.status !== 200) {
      return {
        status: 'unreachable',
        ok: false,
        checked_at: new Date().toISOString(),
        error: `OSRM OPTIONS health check failed (${response.status}).`,
      };
    }
    const osrmHeader = readableOsrmHeader(response.headers);
    if (!osrmHeader) {
      return {
        status: 'unreachable',
        ok: false,
        checked_at: new Date().toISOString(),
        error: 'OSRM health check needs an exposed X-OSRM-* response header.',
      };
    }
    return {
      status: 'connected',
      ok: true,
      checked_at: new Date().toISOString(),
      header: osrmHeader.name,
      error: '',
    };
  } catch (error) {
    return {
      status: 'unreachable',
      ok: false,
      checked_at: new Date().toISOString(),
      error: error?.name === 'AbortError'
        ? 'OSRM health check timed out.'
        : error?.message || 'OSRM health check failed.',
    };
  }
}
