import { getJson, setJson } from '@/lib/mobileStorage';

export const OUTBOUND_DATA_LOG_KEY = 'road_sage_outbound_data_log_v1';
export const OUTBOUND_DATA_LOG_LIMIT = 40;

export const EXTERNAL_SERVICE_LABELS = Object.freeze({
  osm_speed_limits: 'OpenStreetMap speed limits',
  open_meteo_weather: 'Open-Meteo weather',
  osrm_route_snapping: 'OSRM route snapping',
  nominatim_reverse_geocoding: 'OpenStreetMap reverse geocoding',
  map_tiles: 'Online map tiles',
  calibration_upload: 'Calibration sharing',
  backend_sync: 'Backend sync',
  export_file: 'Export file',
  import_file: 'Import file',
});

export const isLocalOnlyMode = (settings = {}) => settings.external_requests_local_only === true;

export const mapTilesAllowed = (settings = {}) => (
  !isLocalOnlyMode(settings) && settings.map_tiles_enabled === true
);

export const externalServiceAllowed = (settings = {}, service) => {
  if (isLocalOnlyMode(settings)) return false;
  if (service === 'osm_speed_limits') return settings.speed_limit_lookup_enabled === true;
  if (service === 'open_meteo_weather') return settings.weather_context_enabled === true;
  if (service === 'osrm_route_snapping') return settings.map_matching_enabled === true && settings.osrm_data_sharing_consented === true;
  if (service === 'nominatim_reverse_geocoding') return settings.reverse_geocoding_enabled === true;
  if (service === 'map_tiles') return mapTilesAllowed(settings);
  if (service === 'calibration_upload') return settings.calibration_sharing_enabled === true;
  if (service === 'backend_sync') return settings.backend_sync_enabled === true;
  return !isLocalOnlyMode(settings);
};

export const enforceLocalOnlyPatch = (patch = {}) => (
  patch.external_requests_local_only === true
    ? {
      ...patch,
      speed_limit_lookup_enabled: false,
      weather_context_enabled: false,
      external_context_auto_fetch_enabled: false,
      map_matching_enabled: false,
      osrm_data_sharing_consented: false,
      calibration_sharing_enabled: false,
      backend_sync_enabled: false,
      reverse_geocoding_enabled: false,
      map_tiles_enabled: false,
      road_data_fetch_always_allow: false,
    }
    : patch
);

export async function recordOutboundDataEvent(event = {}) {
  const service = event.service || 'external_request';
  const now = new Date().toISOString();
  const entry = {
    id: `${now}_${Math.random().toString(36).slice(2, 8)}`,
    service,
    label: event.label || EXTERNAL_SERVICE_LABELS[service] || service,
    status: event.status || 'used',
    screen: event.screen || null,
    detail: event.detail || '',
    destination: event.destination || '',
    at: event.at || now,
  };

  try {
    const current = await getJson(OUTBOUND_DATA_LOG_KEY, []);
    const next = [entry, ...(Array.isArray(current) ? current : [])].slice(0, OUTBOUND_DATA_LOG_LIMIT);
    await setJson(OUTBOUND_DATA_LOG_KEY, next);
  } catch {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(OUTBOUND_DATA_LOG_KEY);
        const current = raw ? JSON.parse(raw) : [];
        const next = [entry, ...(Array.isArray(current) ? current : [])].slice(0, OUTBOUND_DATA_LOG_LIMIT);
        localStorage.setItem(OUTBOUND_DATA_LOG_KEY, JSON.stringify(next));
      }
    } catch {
      // Best-effort audit logging must never block the user action.
    }
  }
  return entry;
}

export async function readOutboundDataLog() {
  try {
    const value = await getJson(OUTBOUND_DATA_LOG_KEY, []);
    return Array.isArray(value) ? value : [];
  } catch {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(OUTBOUND_DATA_LOG_KEY);
      const value = raw ? JSON.parse(raw) : [];
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }
}

export const summarizePrivacyZoneFiltering = ({ originalPoints = [], safePoints = [], privacyZones = [] } = {}) => {
  const originalCount = Array.isArray(originalPoints) ? originalPoints.length : 0;
  const safeCount = Array.isArray(safePoints) ? safePoints.length : 0;
  const removedCount = Math.max(0, originalCount - safeCount);
  return {
    originalCount,
    safeCount,
    removedCount,
    privacyZoneCount: Array.isArray(privacyZones) ? privacyZones.length : 0,
    message: removedCount > 0
      ? `${removedCount} route point${removedCount === 1 ? '' : 's'} removed by privacy zones before external requests.`
      : privacyZones?.length
        ? 'No route points were inside privacy-zone guards for this request.'
        : 'No privacy zones are set.',
  };
};
