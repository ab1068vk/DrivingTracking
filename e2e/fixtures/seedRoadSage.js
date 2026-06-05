export const DB_NAME = 'road_sage_mobile';
export const LEGACY_DB_NAME = 'drivesense_mobile';
export const TRIP_STORE = 'trips';

export const baseSettings = {
  onboarding_completed: true,
  tracking_mode: 'manual',
  units: 'metric',
  notifications_enabled: true,
  notif_trip_summary_enabled: true,
  notif_safety_alerts_enabled: true,
  biometric_lock_enabled: false,
  voice_alerts_enabled: true,
  live_coaching_enabled: true,
  phone_use_detection_enabled: true,
  phone_use_live_alert_enabled: true,
  speed_warning_enabled: true,
  advanced_safety_detection_enabled: true,
  danger_zone_alerts_enabled: true,
  predictive_route_risk_enabled: true,
  weather_context_enabled: true,
  osrm_enabled: false,
  external_context_auto_fetch_enabled: false,
  stealth_mode_armed: false,
  data_retention_months: 24,
  currencySymbol: 'CAD',
  currency_symbol: 'CAD',
  fuel_price_per_unit: 1.65,
  threshold_harsh_brake_ms2: 4.5,
  threshold_rapid_accel_ms2: 3.0,
  threshold_speed_over_kmh: 5,
  threshold_speeding_kmh: 100,
  threshold_long_drive_minutes: 120,
  emergency_workflow_enabled: false,
};

export const privacyZone = {
  id: 'zone-home-test',
  label: 'Home (test)',
  name: 'Home (test)',
  lat: 43.6532,
  lng: -79.3832,
  radius: 200,
  radius_m: 200,
  created_at: '2026-01-01T00:00:00Z',
};

export function generateRoutePoints({ startLat, startLng, count = 30, speedKmh = 60 }) {
  const points = [];
  const now = Date.now() - count * 5000;
  for (let i = 0; i < count; i += 1) {
    points.push({
      lat: +(startLat + i * 0.0003).toFixed(6),
      lng: +(startLng + i * 0.0002).toFixed(6),
      speed_kmh: +(speedKmh + ((i % 7) - 3)).toFixed(1),
      accuracy: +(5 + (i % 3)).toFixed(1),
      altitude: +(80 + (i % 5)).toFixed(1),
      timestamp: new Date(now + i * 5000).toISOString(),
    });
  }
  return points;
}

export const safeTrip = {
  id: 'trip-safe-001',
  status: 'completed',
  start_time: '2026-05-30T08:00:00Z',
  end_time: '2026-05-30T08:25:00Z',
  duration_seconds: 1500,
  distance_km: 12.4,
  score_overall: 87,
  score_safety: 91,
  score_smoothness: 84,
  score_eco: 85,
  score_confidence_label: 'high',
  harsh_brakes_count: 0,
  rapid_accel_count: 1,
  sharp_turns_count: 0,
  speeding_events_count: 0,
  night_driving: false,
  background_tracking: false,
  start_source: 'manual',
  tags: ['commute', 'highway'],
  tag: 'commute',
  notes: 'Smooth morning commute',
  favorite: true,
  is_favorite: true,
  vehicle_id: 'vehicle-gas-001',
  needs_rescore: false,
  score_status: 'scored',
  schema_version: 23,
  route_points: generateRoutePoints({ startLat: 43.665, startLng: -79.45, count: 60 }),
  driving_events: [],
  phone_use_events: [],
  component_scores: {
    overall: { value: 87, evidence: 'high', dataSource: ['gps'] },
    safety: { value: 91, evidence: 'high', dataSource: ['gps'] },
    smoothness: { value: 84, evidence: 'high', dataSource: ['gps'] },
    eco: { value: 85, evidence: 'developing', dataSource: ['gps'] },
  },
};

export const riskyTrip = {
  id: 'trip-risky-001',
  status: 'completed',
  start_time: '2026-05-29T23:30:00Z',
  end_time: '2026-05-30T00:05:00Z',
  duration_seconds: 2100,
  distance_km: 18.7,
  score_overall: 54,
  score_safety: 42,
  score_smoothness: 61,
  score_eco: 66,
  score_confidence_label: 'high',
  harsh_brakes_count: 4,
  rapid_accel_count: 6,
  sharp_turns_count: 2,
  speeding_events_count: 3,
  night_driving: true,
  background_tracking: true,
  start_source: 'native_auto',
  tags: ['night', 'highway'],
  tag: 'night',
  notes: 'Night highway trip',
  favorite: false,
  is_favorite: false,
  vehicle_id: 'vehicle-ev-001',
  needs_rescore: false,
  score_status: 'scored',
  schema_version: 23,
  route_points: generateRoutePoints({ startLat: 43.71, startLng: -79.38, count: 90 }),
  driving_events: [
    { type: 'harsh_brake', severity: 'high', lat: 43.72, lng: -79.39, timestamp: '2026-05-29T23:35:00Z', value: 6.2, speed_kmh: 95 },
    { type: 'rapid_acceleration', severity: 'medium', lat: 43.73, lng: -79.40, timestamp: '2026-05-29T23:40:00Z', value: 4.1, speed_kmh: 60 },
    { type: 'speeding', severity: 'medium', lat: 43.74, lng: -79.41, timestamp: '2026-05-29T23:45:00Z', value: 118, speed_kmh: 118, speed_limit_kmh: 100 },
    { type: 'sharp_turn', severity: 'low', lat: 43.75, lng: -79.42, timestamp: '2026-05-29T23:50:00Z', value: 0.32, speed_kmh: 72 },
    { type: 'idle', severity: 'low', lat: 43.76, lng: -79.43, timestamp: '2026-05-30T00:00:00Z', value: 320 },
  ],
  phone_use_events: [],
  component_scores: {
    overall: { value: 54, evidence: 'high', dataSource: ['gps'] },
    safety: { value: 42, evidence: 'high', dataSource: ['gps'] },
    smoothness: { value: 61, evidence: 'high', dataSource: ['gps'] },
    eco: { value: 66, evidence: 'developing', dataSource: ['gps'] },
  },
};

export const activeTrip = {
  id: 'trip-active-001',
  status: 'active',
  trip_state: 'tracking',
  start_time: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
  route_points: generateRoutePoints({ startLat: 43.65, startLng: -79.39, count: 20 }),
};

export const minimalTrip = {
  id: 'trip-minimal-001',
  status: 'completed',
  start_time: '2026-05-28T12:00:00Z',
  end_time: '2026-05-28T12:04:00Z',
  duration_seconds: 240,
  distance_km: 0.8,
  score_overall: null,
  score_confidence_label: 'unavailable',
  harsh_brakes_count: 0,
  rapid_accel_count: 0,
  score_status: 'pending_javascript_scoring',
  needs_rescore: true,
  schema_version: 23,
  route_points: generateRoutePoints({ startLat: 43.65, startLng: -79.38, count: 8 }),
  driving_events: [],
};

export const gasVehicle = {
  id: 'vehicle-gas-001',
  name: 'Toyota Camry',
  make: 'Toyota',
  model: 'Camry',
  year: 2022,
  type: 'gas',
  fuel_type: 'regular',
  fuel_efficiency_l_per_100km: 8.5,
  color: '#2563EB',
  is_default: true,
  odometer_km: 22400,
  last_oil_change_km: 20000,
  tire_rotation_km: 15000,
  purchase_date: '2022-03-15',
  created_date: '2026-01-01T00:00:00Z',
};

export const evVehicle = {
  id: 'vehicle-ev-001',
  name: 'Tesla Model 3',
  make: 'Tesla',
  model: 'Model 3',
  year: 2024,
  type: 'ev',
  fuel_type: 'electric',
  energy_consumption_kwh_per_100km: 15.0,
  ev_efficiency_kwh_per_100km: 15.0,
  color: '#DC2626',
  is_default: false,
  odometer_km: 8200,
  created_date: '2026-01-02T00:00:00Z',
};

export const legacyPlaintextBackup = {
  version: 4,
  trips: [safeTrip],
  vehicles: [gasVehicle],
  settings: baseSettings,
};
export const wrongPasswordPayload = '';
export const oversizedPayload = 'x'.repeat(52_000_000);
export const corruptedEncryptedPayload = btoa('NOT_VALID_AES_GCM_DATA');

const storageKeys = [
  'drivesense_settings',
  'road_sage_settings',
  'drivesense_active_trip',
  'road_sage_active_trip',
  'road_sage_trips',
  'road_sage_vehicles',
  'road_sage_privacy_zones',
  'road_sage_indexeddb_name',
  'road_sage_route_risk_index',
  'road_sage_key_migration_v1_done',
];

export async function clearAllStorage(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ dbNames, keys }) => {
    localStorage.clear();
    sessionStorage.clear();
    keys.forEach((key) => localStorage.removeItem(key));
    await Promise.all(dbNames.map((name) => new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    })));
  }, {
    dbNames: [DB_NAME, LEGACY_DB_NAME, 'road_sage_test', 'keyval-store'],
    keys: storageKeys,
  });
}

export async function resetAndSeed(page, profile = {}) {
  const settings = {
    ...baseSettings,
    ...(profile.settings || {}),
  };
  const trips = profile.trips || [];
  const vehicles = profile.vehicles || [];
  const active = profile.activeTrip ?? null;
  const privacyZones = profile.privacyZones || [];

  await page.addInitScript(({ settings, trips, vehicles, active, privacyZones }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('road_sage_settings', JSON.stringify(settings));
    localStorage.setItem('drivesense_settings', JSON.stringify(settings));
    localStorage.setItem('road_sage_key_migration_v1_done', '1');
    localStorage.setItem('road_sage_indexeddb_name', 'road_sage_mobile');
    localStorage.setItem('road_sage_vehicles', JSON.stringify(vehicles));
    localStorage.setItem('road_sage_privacy_zones', JSON.stringify(privacyZones));
    localStorage.setItem('road_sage_trips', JSON.stringify(trips));
    if (active) {
      localStorage.setItem('road_sage_active_trip', JSON.stringify(active));
      localStorage.setItem('drivesense_active_trip', JSON.stringify(active));
    }
  }, { settings, trips, vehicles, active, privacyZones });

  if (page.url() === 'about:blank') {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }

  await page.evaluate(async ({ dbName, legacyDbName, tripStore, settings, trips, vehicles, active, privacyZones }) => {
    const openTripDb = () => {
      const request = indexedDB.open(dbName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(tripStore)) {
          const store = db.createObjectStore(tripStore, { keyPath: 'id' });
          store.createIndex('start_time', 'start_time');
          store.createIndex('status', 'status');
        }
        if (!db.objectStoreNames.contains('route_risk_index')) {
          db.createObjectStore('route_risk_index', { keyPath: 'id' });
        }
      };
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    };

    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('road_sage_settings', JSON.stringify(settings));
    localStorage.setItem('drivesense_settings', JSON.stringify(settings));
    localStorage.setItem('road_sage_key_migration_v1_done', '1');
    localStorage.setItem('road_sage_indexeddb_name', dbName);
    localStorage.setItem('road_sage_vehicles', JSON.stringify(vehicles));
    localStorage.setItem('road_sage_privacy_zones', JSON.stringify(privacyZones));
    localStorage.setItem('road_sage_trips', JSON.stringify(trips));
    if (active) {
      localStorage.setItem('road_sage_active_trip', JSON.stringify(active));
      localStorage.setItem('drivesense_active_trip', JSON.stringify(active));
    }

    await Promise.all([dbName, legacyDbName, 'road_sage_test', 'keyval-store'].map((name) => new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    })));

    const db = await openTripDb();
    try {
      if (trips.length) {
        const tx = db.transaction(tripStore, 'readwrite');
        const store = tx.objectStore(tripStore);
        trips.forEach((trip) => store.put(trip));
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      }
    } finally {
      db.close();
    }
  }, {
    dbName: DB_NAME,
    legacyDbName: LEGACY_DB_NAME,
    tripStore: TRIP_STORE,
    settings,
    trips,
    vehicles,
    active,
    privacyZones,
  });
}

export function cloneTrip(overrides = {}) {
  return {
    ...safeTrip,
    id: overrides.id || `trip-${Math.random().toString(36).slice(2, 8)}`,
    route_points: generateRoutePoints({
      startLat: overrides.startLat ?? 43.66,
      startLng: overrides.startLng ?? -79.44,
      count: overrides.routePointCount ?? 40,
      speedKmh: overrides.speedKmh ?? 60,
    }),
    ...overrides,
  };
}
