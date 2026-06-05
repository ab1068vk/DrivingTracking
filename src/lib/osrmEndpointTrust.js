import { isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
import { normalizeTrustedHttpsEndpoint, parseTrustedOrigins } from '@/lib/externalEndpointTrust';

const TRUSTED_OSRM_ORIGINS = parseTrustedOrigins(import.meta.env.VITE_TRUSTED_OSRM_ORIGINS);

export const osrmEndpointDomain = (endpoint) => {
  try {
    return new URL(String(endpoint || '').trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
};

export const normalizeOsrmEndpoint = (endpoint) => (
  normalizeTrustedHttpsEndpoint(endpoint, { label: 'OSRM endpoint', allowedOrigins: TRUSTED_OSRM_ORIGINS }).url ||
  String(endpoint || '').trim().replace(/\/$/, '')
);

export const evaluateOsrmEndpointTrust = (endpoint) => {
  if (isPublicOsrmDemoUrl(endpoint)) {
    return {
      ok: false,
      configured: Boolean(String(endpoint || '').trim()),
      error: 'Use a private or trusted OSRM endpoint; the public OSRM demo cannot be saved as a route-snapping endpoint.',
    };
  }
  return normalizeTrustedHttpsEndpoint(endpoint, {
    label: 'OSRM endpoint',
    allowedOrigins: TRUSTED_OSRM_ORIGINS,
  });
};

export const hasVerifiedOsrmEndpoint = (settings = {}) => (
  (() => {
    const trust = evaluateOsrmEndpointTrust(settings.osrm_map_matching_url);
    return settings.map_matching_enabled === true &&
      trust.ok === true &&
      settings.osrm_data_sharing_consented === true &&
      settings.osrm_health_status === 'connected' &&
      Boolean(settings.osrm_last_reachable_at) &&
      settings.osrm_verified_endpoint === trust.url &&
      settings.osrm_verified_origin === trust.origin &&
      settings.osrm_verified_domain === trust.domain &&
      !isPublicOsrmDemoUrl(settings.osrm_map_matching_url);
  })()
);
