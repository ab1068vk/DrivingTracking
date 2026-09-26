import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DPD-032 / DPD-033. The analytics settings version used to hash the whole
// settings object and every vehicle field, so dark mode, a map pan, an odometer
// auto-sync or restoring an identical fleet re-swept all 3,000 trips of D1 on the
// A54. It now hashes a positive projection of the only inputs the D1 contribution
// reads. Part A pins that the projection is COMPLETE (every other key and field is
// provably irrelevant to the contribution) and not over-broad; Part B pins the
// end-to-end effect on the repair row and the D1 head.

const settingsState = {};
const vehiclesState = { list: [] };
vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', async (importOriginal) => ({
  ...(await importOriginal()),
  localSettings: { get: () => structuredClone(settingsState) },
}));
vi.mock('@/lib/localVehicleRepository', () => ({
  localVehicleRepository: {
    list: async () => structuredClone(vehiclesState.list),
    getAllForReference: async () => structuredClone(vehiclesState.list),
  },
}));
const storage = new Map();
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback = null) => (storage.has(key) ? structuredClone(storage.get(key)) : fallback)),
  setJson: vi.fn(async (key, value) => { storage.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => { storage.delete(key); }),
}));
vi.mock('@/lib/appLifecycleWork', () => ({ admitP6ReviewedWork: vi.fn() }));

const { DEFAULT_SETTINGS } = await import('@/lib/trackingStore');
const { CARBON_ANALYTICS_SETTINGS_KEYS, CARBON_ANALYTICS_VEHICLE_FIELDS } = await import('@/lib/tripInsights');
const { buildAchievementTripContribution } = await import('@/lib/achievementAggregates');
const {
  __testables,
  invalidateP6AnalyticsForSettings,
  stepP6BrowserTripDerivedUpdate,
} = await import('@/lib/p6TripDerivedState');
const { DB_NAME, P6_TRIP_DERIVED_STORES } = await import('@/lib/localTripRepository');
const { P6_DOMAIN_KEYS, P6_READINESS_STATES } = await import('@/lib/p6Contracts');
const { FakeIndexedDb } = await import('./helpers/fakeIndexedDb');

const { analyticsSettingsProjection, analyticsVehicleProjection } = __testables;

// Three vehicles chosen so every carbon input is exercised: a fully specified
// petrol car, a bare profile that falls back to settings, and an EV whose grid
// intensity must come from settings. Plus every non-analytics field a real
// vehicle record carries (odometer sync, names, cost, maintenance, flags).
const vehicles = () => [
  {
    id: 'v_full', name: 'Daily Commuter', fuel_type: 'gasoline', fuel_efficiency_l_per_100km: 7.4,
    co2_baseline_kg_per_100km: 19.5, grid_co2_kg_per_kwh: null, fuel_price_per_liter: 1.62,
    odometer_km: 48210, odometer_trip_distance_anchor_km: 23709.4, auto_odometer_last_sync_at: '2026-09-23T05:08:10.000Z',
    is_default: true, color: '#2266aa', make: 'Honda', model: 'Civic', year: 2019, notes: 'commute',
    created_date: '2025-01-01T00:00:00.000Z', updated_date: '2026-09-23T05:08:10.000Z', retired_at: null,
  },
  { id: 'v_bare', name: 'Borrowed' },
  { id: 'v_ev', name: 'New EV', fuel_type: 'electric', odometer_km: 1200, is_default: false },
];
const trips = [
  { id: 't1', status: 'completed', vehicle_id: 'v_full', distance_km: 23.4, duration_seconds: 1800, score_overall: 82, eco_driving_score: 71, start_time: '2026-09-01T12:00:00.000Z', end_time: '2026-09-01T12:30:00.000Z' },
  { id: 't2', status: 'completed', vehicle_id: 'v_bare', distance_km: 11.2, duration_seconds: 900, score_overall: 77, eco_driving_score: 40, start_time: '2026-09-02T12:00:00.000Z', end_time: '2026-09-02T12:15:00.000Z' },
  { id: 't3', status: 'completed', vehicle_id: 'v_ev', distance_km: 42.0, duration_seconds: 2400, score_overall: 90, eco_driving_score: 88, start_time: '2026-09-03T12:00:00.000Z', end_time: '2026-09-03T12:40:00.000Z' },
  { id: 't4', status: 'completed', vehicle_id: 'v_missing', distance_km: 5.0, duration_seconds: 600, score_overall: 60, start_time: '2026-09-04T12:00:00.000Z', end_time: '2026-09-04T12:10:00.000Z' },
];
const baseSettings = () => ({ ...structuredClone(DEFAULT_SETTINGS), grid_co2_kg_per_kwh: 0.12, dark_mode: 'system', last_map_center: null });
const contributions = (settings, fleet) => JSON.stringify(trips.map((trip) => buildAchievementTripContribution(trip, settings, fleet)));
const mutate = (value) => {
  if (typeof value === 'number') return value + 13.7;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'string') return `${value}_mutated`;
  if (value === null || value === undefined) return 'mutated';
  return { mutated: true };
};

describe('Part A — the analytics projection is complete and not over-broad', () => {
  it('ignores every settings key outside CARBON_ANALYTICS_SETTINGS_KEYS (dependency closure)', () => {
    const base = baseSettings();
    const baseline = contributions(base, vehicles());
    const keys = new Set([...Object.keys(base), 'dark_mode', 'last_map_center', 'experience_mode',
      'premium_visual_experience', 'heightened_privacy_mode', 'units', 'legal_notice_acknowledged_at',
      'rasp_checked_at', 'default_fuel_price_per_liter']);
    let checked = 0;
    for (const key of keys) {
      if (CARBON_ANALYTICS_SETTINGS_KEYS.includes(key)) continue;
      const changed = { ...base, [key]: mutate(base[key]) };
      expect(contributions(changed, vehicles()), `${key} altered a D1 contribution`).toBe(baseline);
      expect(analyticsSettingsProjection(changed), `${key} reached the version`).toEqual(analyticsSettingsProjection(base));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(50); // guards against a vacuous DEFAULT_SETTINGS
  });

  it('ignores every vehicle field outside CARBON_ANALYTICS_VEHICLE_FIELDS', () => {
    const base = baseSettings();
    const baseline = contributions(base, vehicles());
    const fields = new Set(vehicles().flatMap((vehicle) => Object.keys(vehicle)));
    for (const field of fields) {
      if (CARBON_ANALYTICS_VEHICLE_FIELDS.includes(field)) continue;
      const fleet = vehicles().map((vehicle) => ({ ...vehicle, [field]: mutate(vehicle[field]) }));
      expect(contributions(base, fleet), `vehicle.${field} altered a D1 contribution`).toBe(baseline);
      expect(analyticsVehicleProjection(fleet), `vehicle.${field} reached the version`).toEqual(analyticsVehicleProjection(vehicles()));
    }
  });

  it('every listed settings key is a real analytics input', () => {
    const base = baseSettings();
    const probes = {
      fuel_type: 'diesel',
      default_l_per_100km: 11.9,
      co2_baseline_kg_per_100km: 31.0,
      grid_co2_kg_per_kwh: 0.45,
      default_ev_kwh_per_100km: 24.5,
    };
    expect(Object.keys(probes).sort()).toEqual([...CARBON_ANALYTICS_SETTINGS_KEYS].sort());
    // `co2_saved_kg = max(0, baseline - actual)`: with the default baseline the bare
    // profile's savings clamp to 0 either way, which would hide a real input. Probe
    // against a baseline where savings are positive (except when probing it).
    const positive = { ...base, co2_baseline_kg_per_100km: 40 };
    for (const [key, value] of Object.entries(probes)) {
      const reference = key === 'co2_baseline_kg_per_100km' ? base : positive;
      expect(contributions({ ...reference, [key]: value }, vehicles()), `${key} did not change any contribution`)
        .not.toBe(contributions(reference, vehicles()));
    }
  });

  it('every listed vehicle field changes the version', () => {
    for (const field of CARBON_ANALYTICS_VEHICLE_FIELDS) {
      const fleet = vehicles().map((vehicle) => (vehicle.id === 'v_full' ? { ...vehicle, [field]: mutate(vehicle[field]) } : vehicle));
      expect(analyticsVehicleProjection(fleet), field).not.toEqual(analyticsVehicleProjection(vehicles()));
    }
  });

  it('is independent of fleet order and of settings key order', () => {
    expect(analyticsVehicleProjection([...vehicles()].reverse())).toEqual(analyticsVehicleProjection(vehicles()));
    const reversed = Object.fromEntries(Object.entries(baseSettings()).reverse());
    expect(JSON.stringify(analyticsSettingsProjection(reversed))).toBe(JSON.stringify(analyticsSettingsProjection(baseSettings())));
  });
});

describe('Part B — end to end: repair row and D1 head', () => {
  let indexedDb;
  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
    storage.clear();
    for (const key of Object.keys(settingsState)) delete settingsState[key];
    Object.assign(settingsState, baseSettings());
    vehiclesState.list = vehicles();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const record = (storeName, key) => indexedDb.getStoreState(DB_NAME, storeName)?.records.get(key) || null;
  const repair = () => record(P6_TRIP_DERIVED_STORES.CONTROL, 'analytics-settings-repair');
  const head = () => record(P6_TRIP_DERIVED_STORES.MANIFESTS, `${P6_DOMAIN_KEYS.ANALYTICS}:all`);
  const converge = async () => {
    for (let turn = 0; turn < 50; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate();
      if (result.hasMore !== true) break;
    }
  };

  it('keeps D1 VERIFIED through UI-only and odometer changes, and demotes it for a real input', async () => {
    await invalidateP6AnalyticsForSettings('TEST_INITIAL');
    await converge();
    expect(repair()?.state).toBe('COMPLETE');
    expect(head()?.state).toBe(P6_READINESS_STATES.VERIFIED);
    const converged = structuredClone(repair());

    // DPD-033 negative controls.
    settingsState.dark_mode = 'dark';
    await invalidateP6AnalyticsForSettings('SETTINGS_CHANGED');
    settingsState.last_map_center = { lat: 43.65, lng: -79.38, zoom: 13 };
    await invalidateP6AnalyticsForSettings('SETTINGS_CHANGED');
    settingsState.experience_mode = 'tracking';
    await invalidateP6AnalyticsForSettings('SETTINGS_CHANGED');
    // DPD-032 negative controls: odometer auto-sync, and restoring an identical fleet.
    vehiclesState.list = vehicles().map((vehicle) => (vehicle.id === 'v_full'
      ? { ...vehicle, odometer_km: 48999, odometer_trip_distance_anchor_km: 23800, auto_odometer_last_sync_at: '2026-09-24T21:00:00.000Z' }
      : vehicle));
    await invalidateP6AnalyticsForSettings('VEHICLES_CHANGED');
    vehiclesState.list = structuredClone(vehiclesState.list);
    await invalidateP6AnalyticsForSettings('VEHICLES_CHANGED');

    expect(repair()).toEqual(converged);
    expect(head()?.state).toBe(P6_READINESS_STATES.VERIFIED);

    // Positive control: a real analytics input still invalidates.
    vehiclesState.list = vehiclesState.list.map((vehicle) => (vehicle.id === 'v_full'
      ? { ...vehicle, fuel_efficiency_l_per_100km: 9.9 } : vehicle));
    await invalidateP6AnalyticsForSettings('VEHICLES_CHANGED');
    expect(repair()?.state).toBe('DIRTY');
    expect(repair()?.reason).toBe('VEHICLES_CHANGED');
    expect(head()?.state).toBe(P6_READINESS_STATES.REBUILD_REQUIRED);
  });

  // DPD-042. A settled derived-update job ignores a same-epoch reviewed admission, so the
  // invalidation must also reach it as a P7 source change (the DPD-041 follow-up producer).
  it('publishes a source change for a real input only, after the invalidation commits', async () => {
    const { subscribeP7SourceChange } = await import('@/lib/p7SourceChange');
    const seen = [];
    const stop = subscribeP7SourceChange(({ reason }) => seen.push(reason));
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    await invalidateP6AnalyticsForSettings('TEST_INITIAL');
    await converge();
    await flush();
    seen.length = 0;

    settingsState.dark_mode = 'dark';
    await invalidateP6AnalyticsForSettings('SETTINGS_CHANGED');
    settingsState.last_map_center = { lat: 43.65, lng: -79.38, zoom: 13 };
    await invalidateP6AnalyticsForSettings('SETTINGS_CHANGED');
    vehiclesState.list = vehicles().map((vehicle) => (vehicle.id === 'v_full' ? { ...vehicle, odometer_km: 48999 } : vehicle));
    await invalidateP6AnalyticsForSettings('VEHICLES_CHANGED');
    await flush();
    expect(seen).not.toContain('p6_analytics_settings_invalidated');

    settingsState.co2_baseline_kg_per_100km = 13;
    await invalidateP6AnalyticsForSettings('SETTINGS_CHANGED');
    await flush();
    expect(seen.filter((reason) => reason === 'p6_analytics_settings_invalidated')).toHaveLength(1);
    expect(repair()?.state).toBe('DIRTY');
    stop();
  });

  it('a genuine settings input demotes D1', async () => {
    await invalidateP6AnalyticsForSettings('TEST_INITIAL');
    await converge();
    settingsState.default_l_per_100km = 12.5;
    await invalidateP6AnalyticsForSettings('SETTINGS_CHANGED');
    expect(repair()?.state).toBe('DIRTY');
    expect(head()?.state).toBe(P6_READINESS_STATES.REBUILD_REQUIRED);
  });
});
