import { isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';

export const osrmEndpointDomain = (endpoint) => {
  try {
    return new URL(String(endpoint || '').trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
};

export const normalizeOsrmEndpoint = (endpoint) => String(endpoint || '').trim().replace(/\/$/, '');

export const hasVerifiedOsrmEndpoint = (settings = {}) => (
  settings.map_matching_enabled !== false &&
  Boolean(settings.osrm_map_matching_url) &&
  settings.osrm_data_sharing_consented === true &&
  settings.osrm_health_status === 'connected' &&
  Boolean(settings.osrm_last_reachable_at) &&
  !isPublicOsrmDemoUrl(settings.osrm_map_matching_url)
);
