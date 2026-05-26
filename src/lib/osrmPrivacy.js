export const PUBLIC_OSRM_DEMO_URL = 'https://router.project-osrm.org';

export function isPublicOsrmDemoUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(String(value));
    return url.hostname.toLowerCase() === 'router.project-osrm.org';
  } catch {
    return false;
  }
}
