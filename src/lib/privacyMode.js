export const HEIGHTENED_PRIVACY_MODE_KEY = 'heightened_privacy_mode';
const SETTINGS_STORAGE_KEY = 'drivesense_settings';

export const isHeightenedPrivacyMode = (settings = {}) => (
  settings?.[HEIGHTENED_PRIVACY_MODE_KEY] === true
);

export function isStoredHeightenedPrivacyMode() {
  try {
    if (typeof localStorage === 'undefined') return false;
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
    return isHeightenedPrivacyMode(parsed);
  } catch {
    return false;
  }
}

export function effectivePrivacySettings(settings = {}) {
  if (!isHeightenedPrivacyMode(settings)) return settings || {};
  return {
    ...(settings || {}),
    weather_context_enabled: false,
    speed_limit_lookup_enabled: false,
    request_obfuscation_enabled: true,
    map_matching_enabled: false,
  };
}

export function effectivePrivacyZones(zones = [], settings = {}) {
  const safeZones = Array.isArray(zones) ? zones : [];
  if (!isHeightenedPrivacyMode(settings)) return safeZones;
  return safeZones.map((zone) => ({
    ...zone,
    sensitivity: 'high',
  }));
}

export const HEIGHTENED_PRIVACY_MODE_EFFECTS = Object.freeze([
  'OSRM route snapping is skipped regardless of saved endpoint or consent.',
  'Open-Meteo weather and Overpass speed-limit lookups are skipped.',
  'Request timing obfuscation is treated as on for this session.',
  'All privacy zones are treated as high sensitivity for this session.',
]);
