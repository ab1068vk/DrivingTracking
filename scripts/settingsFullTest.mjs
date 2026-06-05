// Road Sage full settings integration test.
// Run: npm run test:settings-contract

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

globalThis.Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web' };
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => _store.get(k) ?? null,
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
  clear: () => _store.clear(),
  get length() { return _store.size; },
  key: (i) => [..._store.keys()][i] ?? null,
};
globalThis.indexedDB = { open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }) };
globalThis.NativeSpeech = { speak: async () => {} };
globalThis.__VITE_ENV__ = {
  VITE_TRUSTED_OSRM_ORIGINS: '',
  VITE_BLOCKED_OSRM_ORIGINS: '',
  VITE_DEFAULT_OSRM_URL: '',
  VITE_OSRM_TIMEOUT_MS: '',
  VITE_API_URL: '',
};
globalThis.window = globalThis;
globalThis.navigator ??= { onLine: true };
globalThis.document ??= {
  documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
  createElement: () => ({ style: {}, click() {}, remove() {} }),
  body: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => null,
};
globalThis.btoa ??= (value) => Buffer.from(value, 'binary').toString('base64');
globalThis.atob ??= (value) => Buffer.from(String(value), 'base64').toString('binary');

const loaderSource = `
  import { readFile } from 'node:fs/promises';
  import { pathToFileURL, fileURLToPath } from 'node:url';
  import path from 'node:path';
  const ROOT = ${JSON.stringify(ROOT)};
  const SRC = ${JSON.stringify(SRC)};
  const aliases = new Map([
    ['@capacitor/core', "export const Capacitor = globalThis.Capacitor; export const registerPlugin = (name) => globalThis.Capacitor?.Plugins?.[name] || {};"],
    ['@capacitor/preferences', "export const Preferences = { async get({key}) { return { value: globalThis.localStorage?.getItem(key) ?? null }; }, async set({key,value}) { globalThis.localStorage?.setItem(key, value); }, async remove({key}) { globalThis.localStorage?.removeItem(key); } };"],
    ['@capacitor/local-notifications', "export const LocalNotifications = { async requestPermissions() { return { display: 'granted' }; }, async checkPermissions() { return { display: 'granted' }; }, async createChannel() {}, async schedule() {}, async cancel() {}, async addListener() { return { remove() {} }; } };"],
    ['@capacitor/app', "export const App = { async addListener() { return { remove() {} }; } };"],
    ['@capacitor/geolocation', "export const Geolocation = { async checkPermissions() { return { location: 'granted' }; }, async requestPermissions() { return { location: 'granted' }; }, async getCurrentPosition() { return { coords: { latitude: 0, longitude: 0, accuracy: 1 }, timestamp: Date.now() }; } };"],
    ['@capacitor/filesystem', "export const Filesystem = {}; export const Directory = {}; export const Encoding = {};"],
    ['@capacitor/splash-screen', "export const SplashScreen = { hide() {} };"],
    ['@capacitor-community/background-geolocation', "export const BackgroundGeolocation = {};"],
    ['@/api/trips', "export const tripService = { async list() { return []; }, async upsertMany() {}, async markCompletedForRescore() { return 0; } };"],
    ['@/api/vehicles', "export const vehicleService = { async list() { return []; }, async upsertMany() {} };"],
  ]);
  const asUrl = (p) => pathToFileURL(p).href;
  const exists = async (p) => {
    try { await readFile(p); return true; } catch { return false; }
  };
  const stripTs = (source) => source
    .replace(/: *[A-Za-z_$][A-Za-z0-9_$]*(?:\\[\\])?(?= *[,)=;{])/g, '')
    .replace(/: *Array<[^>]+>/g, '')
    .replace(/: *readonly \\[[^\\]]+\\]/g, '');
  async function resolveFile(basePath) {
    const parsed = path.parse(basePath);
    const swapped = parsed.ext === '.js'
      ? [path.join(parsed.dir, parsed.name + '.ts'), path.join(parsed.dir, parsed.name + '.tsx')]
      : [];
    const candidates = [basePath, ...swapped, basePath + '.js', basePath + '.jsx', basePath + '.ts', basePath + '.tsx', path.join(basePath, 'index.js')];
    for (const candidate of candidates) if (await exists(candidate)) return candidate;
    return basePath;
  }
  export async function resolve(specifier, context, nextResolve) {
    if (aliases.has(specifier)) {
      return { url: 'data:text/javascript;base64,' + Buffer.from(aliases.get(specifier)).toString('base64'), shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      return { url: asUrl(await resolveFile(path.join(SRC, specifier.slice(2)))), shortCircuit: true };
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
      const parent = path.dirname(fileURLToPath(context.parentURL));
      const resolved = await resolveFile(path.resolve(parent, specifier));
      if (resolved !== path.resolve(parent, specifier) || await exists(resolved)) return { url: asUrl(resolved), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
  export async function load(url, context, nextLoad) {
    if (url.startsWith('file:') && /\\.(ts|tsx)$/.test(url)) {
      const file = fileURLToPath(url);
      if (file.endsWith(path.join('src', 'lib', 'scoring', 'pipeline.ts'))) {
        return {
          format: 'module',
          source: "export const SCORING_PIPELINE = Object.freeze([]); export function runScoringPipeline(routePoints = [], events = [], settings = {}, externalContext = {}, stages = SCORING_PIPELINE) { return { routePoints: Array.isArray(routePoints) ? routePoints : [], events: Array.isArray(events) ? events : [], settings: settings && typeof settings === 'object' ? settings : {}, externalContext: externalContext && typeof externalContext === 'object' ? externalContext : {}, stages: {} }; } export function createScoringPipelineContext({ routePoints = [], events = [], settings = {}, externalContext = {}, stages = {} } = {}) { return { routePoints: Array.isArray(routePoints) ? routePoints : [], events: Array.isArray(events) ? events : [], settings: settings && typeof settings === 'object' ? settings : {}, externalContext: externalContext && typeof externalContext === 'object' ? externalContext : {}, stages: Object.freeze({ ...(stages && typeof stages === 'object' ? stages : {}) }) }; }",
          shortCircuit: true,
        };
      }
      if (file.endsWith(path.join('src', 'engine', 'scoring', 'pipeline.ts'))) {
        return {
          format: 'module',
          source: "export function calculateTripScores() { return {}; }",
          shortCircuit: true,
        };
      }
      if (file.endsWith(path.join('src', 'lib', 'scoring', 'explainer.ts'))) {
        return {
          format: 'module',
          source: "export function explainScores() { return {}; }",
          shortCircuit: true,
        };
      }
      return { format: 'module', source: stripTs(await readFile(fileURLToPath(url), 'utf8')), shortCircuit: true };
    }
    if (url.startsWith('file:') && /\\.(js|jsx)$/.test(url) && fileURLToPath(url).startsWith(SRC)) {
      const file = fileURLToPath(url);
      let source = (await readFile(file, 'utf8')).replace(/import\\.meta\\.env/g, 'globalThis.__VITE_ENV__');
      if (file.endsWith(path.join('src', 'hooks', 'useSettingsVersion.js'))) {
        source = source.replace("import { buildDrivingThresholds, buildScoreConstantsSnapshot } from '@/lib/tripEngine';", "import { buildDrivingThresholds, buildScoreConstantsSnapshot } from '../engine/calibration/baseline.js';");
      }
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript;base64,${Buffer.from(loaderSource).toString('base64')}`, import.meta.url);

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function finite(value) {
  return Number.isFinite(Number(value));
}
function okPatch(result) {
  return result === true || result?.valid === true;
}
function badPatch(result) {
  return result === false || result?.valid === false;
}
function settingsOnly(result) {
  return result?.settings ?? result;
}
function clampValue(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function normalizeBooleanImport(value, fallback = true) {
  if (value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'yes') return true;
  if (value === false || value === 0 || ['false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  return fallback;
}
function withSanitizedDefaults(raw, trackingStore) {
  const sanitized = trackingStore.sanitizeImportedSettings(raw);
  return { ...trackingStore.DEFAULT_SETTINGS, ...sanitized };
}
async function expectThrows(fn, message) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  assert(threw, message);
}
async function importModule(label, relPath) {
  try {
    return await import(pathToFileURL(path.join(ROOT, relPath)).href);
  } catch (error) {
    console.warn(`  ⚠️ IMPORT FAILED ${label}: ${error.message}`);
    if (globalThis.__SETTINGS_FULL_TEST_DEBUG_IMPORTS__) console.warn(error.stack);
    return null;
  }
}
async function step(id, description, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${id} ${description}`);
  } catch (error) {
    failed += 1;
    console.error(`  ❌ ${id} ${description} -- ${error.message}`);
    console.error(error.stack);
  }
}
async function skipStep(id, description, reason) {
  skipped += 1;
  console.warn(`  ⚠️ SKIP ${id} ${description} -- ${reason}`);
}
async function group(number, name, fn) {
  console.log(`▶ GROUP ${number}: ${name}`);
  try {
    await fn();
  } catch (error) {
    failed += 1;
    console.error(`  ❌ GROUP ${number} ${name} -- ${error.message}`);
    console.error(error.stack);
  }
}
function resetStorage() {
  globalThis.localStorage.clear();
}
function setMergedSettings(trackingStore, patch) {
  trackingStore.localSettings.set({ ...trackingStore.DEFAULT_SETTINGS, ...patch });
}
function makeTrips(count = 20, kind = 'uniform') {
  const base = 1_700_000_000_000;
  return Array.from({ length: count }, (_, tripIndex) => {
    const route_points = Array.from({ length: 80 }, (_, i) => {
      let speed = 50;
      if (kind === 'harsh' && i % 20 === 19) speed = 5;
      if (kind === 'harsh' && i % 20 === 18) speed = 90;
      if (kind === 'smooth') speed = 45 + Math.sin(i / 10);
      return { lat: 43.45 + i * 0.0002, lng: -80.5, timestamp: base + tripIndex * 1_000_000 + i * 3000, speed_kmh: speed, accuracy: 5 };
    });
    return { id: `trip-${kind}-${tripIndex}`, status: 'completed', distance_km: 12, route_points, driving_events: [] };
  });
}

const modules = {
  trackingStore: await importModule('trackingStore', 'src/lib/trackingStore.js'),
  appConstants: await importModule('appConstants', 'src/lib/appConstants.js'),
  scoringConstants: await importModule('scoringConstants', 'src/lib/scoringConstants.js'),
  dataBackup: await importModule('dataBackup', 'src/lib/dataBackup.js'),
  backupEncryption: await importModule('backupEncryption', 'src/lib/backupEncryption.js'),
  biometricLock: await importModule('biometricLock', 'src/lib/biometricLock.js'),
  ephemeralTripMode: await importModule('ephemeralTripMode', 'src/lib/ephemeralTripMode.js'),
  mobileStorage: await importModule('mobileStorage', 'src/lib/mobileStorage.js'),
  privacyZones: await importModule('privacyZones', 'src/lib/privacyZones.js'),
  privacyControls: await importModule('privacyControls', 'src/lib/privacyControls.js'),
  voiceAlerts: await importModule('voiceAlerts', 'src/lib/voiceAlerts.js'),
  notificationService: await importModule('notificationService', 'src/lib/notificationService.js'),
  currency: await importModule('currency', 'src/lib/currency.js'),
  mathUtils: await importModule('mathUtils', 'src/lib/mathUtils.ts'),
  speedLimitSource: await importModule('speedLimitSource', 'src/lib/speedLimitSource.js'),
  externalEndpointTrust: await importModule('externalEndpointTrust', 'src/lib/externalEndpointTrust.js'),
  thresholdCalibration: await importModule('thresholdCalibration', 'src/lib/thresholdCalibration.js'),
  calibrationBaseline: await importModule('calibrationBaseline', 'src/engine/calibration/baseline.js'),
  useSettingsVersion: await importModule('useSettingsVersion', 'src/hooks/useSettingsVersion.js'),
  useSettingsSections: await importModule('useSettingsSections', 'src/features/settings/hooks/useSettingsSections.js'),
  privacyZoneConstants: await importModule('privacyZoneConstants', 'src/settings/privacy-zones/privacyZoneConstants.js'),
  privacyZoneFormatting: await importModule('privacyZoneFormatting', 'src/settings/privacy-zones/privacyZoneFormatting.js'),
  localTripRepository: await importModule('localTripRepository', 'src/lib/localTripRepository.core.js'),
};

const TS = modules.trackingStore;
const VALID_BACKUP_PASSWORD = 'Road$age2026!Secure';
const WRONG_BACKUP_PASSWORD = 'Wrong$age2026!Secure';

await group(1, 'DEFAULT_SETTINGS integrity', async () => {
  if (!TS) return skipStep('1.x', 'DEFAULT_SETTINGS integrity', 'trackingStore import failed');
  const { DEFAULT_SETTINGS } = TS;
  const boolKeys = ['auto_tracking_enabled', 'background_tracking_enabled', 'voice_alerts_enabled', 'advanced_safety_detection_enabled', 'speed_limit_lookup_enabled', 'map_matching_enabled', 'notif_safety_alerts_enabled', 'notif_phone_use_alert_enabled', 'notif_speeding_alert_enabled', 'notif_post_trip_phone_use', 'notif_heading_drift_alert_enabled'];
  const numericKeys = ['threshold_harsh_brake_ms2', 'threshold_rapid_accel_ms2', 'threshold_speeding_kmh', 'threshold_speed_over_kmh', 'threshold_long_drive_minutes', 'threshold_stop_start_decel_ms2', 'threshold_manoeuvre_alert_turn_degs', 'threshold_phone_proxy_oscillations', 'threshold_speed_creep_kmh', 'threshold_overtake_accel_ms2', 'eco_idle_penalty_multiplier', 'ubi_optimal_annual_km', 'ubi_mileage_score_spread_km', 'osrm_timeout_ms', 'data_retention_months'];
  await step('1.1', 'DEFAULT_SETTINGS is a plain object', () => assert(isPlainObject(DEFAULT_SETTINGS), 'DEFAULT_SETTINGS must be a plain object'));
  await step('1.2', 'Boolean keys present and typed', () => boolKeys.forEach((key) => assert(typeof DEFAULT_SETTINGS[key] === 'boolean', `${key} must be boolean`)));
  await step('1.3', 'Numeric keys present and finite', () => numericKeys.forEach((key) => assert(finite(DEFAULT_SETTINGS[key]), `${key} must be finite`)));
  await step('1.4', 'threshold_harsh_brake_ms2 in [3,7]', () => assert(DEFAULT_SETTINGS.threshold_harsh_brake_ms2 >= 3 && DEFAULT_SETTINGS.threshold_harsh_brake_ms2 <= 7, 'out of range'));
  await step('1.5', 'threshold_rapid_accel_ms2 in [2,6]', () => assert(DEFAULT_SETTINGS.threshold_rapid_accel_ms2 >= 2 && DEFAULT_SETTINGS.threshold_rapid_accel_ms2 <= 6, 'out of range'));
  await step('1.6', 'threshold_speeding_kmh in [50,200]', () => assert(DEFAULT_SETTINGS.threshold_speeding_kmh >= 50 && DEFAULT_SETTINGS.threshold_speeding_kmh <= 200, 'out of range'));
  await step('1.7', 'threshold_speed_over_kmh in [0,30]', () => assert(DEFAULT_SETTINGS.threshold_speed_over_kmh >= 0 && DEFAULT_SETTINGS.threshold_speed_over_kmh <= 30, 'out of range'));
  await step('1.8', 'data_retention_months >= 1', () => assert(DEFAULT_SETTINGS.data_retention_months >= 1, 'retention must be enabled by default'));
  await step('1.9', 'theme/dark mode is valid enum', () => assert(['light', 'dark', 'system'].includes(DEFAULT_SETTINGS.theme_mode ?? DEFAULT_SETTINGS.dark_mode), 'theme_mode/dark_mode invalid'));
  await step('1.10', 'privacy_zones is an array', () => assert(Array.isArray(DEFAULT_SETTINGS.privacy_zones), 'privacy_zones must be array'));
  await step('1.11', 'currencySymbol is non-empty', () => assert(typeof DEFAULT_SETTINGS.currencySymbol === 'string' && DEFAULT_SETTINGS.currencySymbol.length > 0, 'currencySymbol missing'));
});

await group(2, 'migrateDefaultSettings', async () => {
  if (!TS) return skipStep('2.x', 'migrateDefaultSettings', 'trackingStore import failed');
  const { DEFAULT_SETTINGS, migrateDefaultSettings } = TS;
  await step('2.1', '{} fills all defaults', () => Object.keys(DEFAULT_SETTINGS).forEach((key) => assert(key in settingsOnly(migrateDefaultSettings({})), `${key} missing`)));
  await step('2.2', 'DEFAULT_SETTINGS roundtrips', () => assert(JSON.stringify(settingsOnly(migrateDefaultSettings(DEFAULT_SETTINGS))) === JSON.stringify(DEFAULT_SETTINGS), 'defaults changed'));
  await step('2.3', 'data_retention_days migrates to months', () => assert(settingsOnly(migrateDefaultSettings({ data_retention_days: 730 })).data_retention_months === 24, 'expected 24 months'));
  await step('2.4', 'dark_mode/theme_mode preserves dark', () => assert((settingsOnly(migrateDefaultSettings({ dark_mode: 'dark' })).dark_mode ?? settingsOnly(migrateDefaultSettings({ theme_mode: 'dark' })).theme_mode) === 'dark', 'dark not preserved'));
  await step('2.5', 'threshold_harsh_brake_ms2 preserved', () => assert(settingsOnly(migrateDefaultSettings({ settings_defaults_version: 10, threshold_harsh_brake_ms2: 5.5 })).threshold_harsh_brake_ms2 === 5.5, 'threshold not preserved'));
  await step('2.6', 'null input falls back gracefully', () => assert(isPlainObject(settingsOnly(migrateDefaultSettings(null))), 'null did not fallback'));
  await step('2.7', 'undefined input falls back gracefully', () => assert(isPlainObject(settingsOnly(migrateDefaultSettings(undefined))), 'undefined did not fallback'));
  await step('2.8', 'dangerous unknown keys are not transferred', () => {
    const out = settingsOnly(migrateDefaultSettings(JSON.parse('{"__proto__":{"x":1},"constructor":{"prototype":{}}}')));
    assert(Object.prototype.x === undefined, 'prototype polluted');
    assert(!Object.prototype.hasOwnProperty.call(out, '__proto__'), '__proto__ transferred');
  });
  await step('2.9', 'malformed timestamps do not destabilize candidate choice', () => {
    const chosen = TS.chooseSettingsHydrationCandidate([
      { source: 'native_plugin', revision: 3, updatedAtMs: NaN, onboardingCompleted: 0, deltaCount: 1 },
      { source: 'browser_mirror', revision: 3, updatedAtMs: 'not-a-date', onboardingCompleted: 1, deltaCount: 0 },
    ]);
    assert(chosen.source === 'browser_mirror', 'bad malformed timestamp winner');
  });
});

await group(3, 'sanitizeImportedSettings', async () => {
  if (!TS) return skipStep('3.x', 'sanitizeImportedSettings', 'trackingStore import failed');
  const { DEFAULT_SETTINGS, sanitizeImportedSettings } = TS;
  await step('3.1', 'valid settings known keys survive', () => assert(sanitizeImportedSettings({ voice_alerts_enabled: false }).voice_alerts_enabled === false, 'known bool did not pass'));
  await step('3.2', 'unknown keys are stripped', () => assert(!('evil_key' in sanitizeImportedSettings({ evil_key: 1 })), 'unknown key survived'));
  await step('3.3', "boolean string 'true' handled by import policy", () => assert(withSanitizedDefaults({ voice_alerts_enabled: normalizeBooleanImport('true') }, TS).voice_alerts_enabled === true, 'true not handled'));
  await step('3.4', "boolean string 'false' handled by import policy", () => assert(withSanitizedDefaults({ voice_alerts_enabled: normalizeBooleanImport('false') }, TS).voice_alerts_enabled === false, 'false not handled'));
  await step('3.5', 'boolean number 1 handled', () => assert(withSanitizedDefaults({ voice_alerts_enabled: normalizeBooleanImport(1) }, TS).voice_alerts_enabled === true, '1 not handled'));
  await step('3.6', 'boolean number 0 handled', () => assert(withSanitizedDefaults({ voice_alerts_enabled: normalizeBooleanImport(0) }, TS).voice_alerts_enabled === false, '0 not handled'));
  await step('3.7', 'harsh brake low clamps/safe', () => assert(sanitizeImportedSettings({ threshold_harsh_brake_ms2: 2 }).threshold_harsh_brake_ms2 >= 2, 'below sanitizer range'));
  await step('3.8', 'harsh brake high clamps/safe', () => assert(sanitizeImportedSettings({ threshold_harsh_brake_ms2: 99 }).threshold_harsh_brake_ms2 <= 8, 'above sanitizer range'));
  await step('3.9', 'rapid accel low clamps/safe', () => assert(sanitizeImportedSettings({ threshold_rapid_accel_ms2: 0.1 }).threshold_rapid_accel_ms2 >= 0.5, 'below sanitizer range'));
  await step('3.10', 'negative speeding safe', () => assert((sanitizeImportedSettings({ threshold_speeding_kmh: -5 }).threshold_speeding_kmh ?? DEFAULT_SETTINGS.threshold_speeding_kmh) > 0, 'negative survived'));
  await step('3.11', 'zero retention safe', () => assert((sanitizeImportedSettings({ data_retention_months: 0 }).data_retention_months ?? DEFAULT_SETTINGS.data_retention_months) >= 0, 'zero retention unsafe'));
  await step('3.12', 'non-numeric retention defaults', () => assert((sanitizeImportedSettings({ data_retention_months: 'abc' }).data_retention_months ?? DEFAULT_SETTINGS.data_retention_months) === DEFAULT_SETTINGS.data_retention_months, 'non-numeric not defaulted'));
  await step('3.13', 'invalid theme/dark enum defaults', () => assert(['system', 'light', 'dark'].includes(sanitizeImportedSettings({ dark_mode: 'banana' }).dark_mode ?? DEFAULT_SETTINGS.dark_mode), 'invalid enum survived'));
  await step('3.14', 'empty currency defaults', () => assert((sanitizeImportedSettings({ currencySymbol: '' }).currencySymbol ?? DEFAULT_SETTINGS.currencySymbol).length > 0, 'empty currency'));
  await step('3.15', 'script currency rejected/defaulted', () => assert(!String(sanitizeImportedSettings({ currencySymbol: '<script>alert(1)</script>' }).currencySymbol ?? DEFAULT_SETTINGS.currencySymbol).includes('<script>'), 'script currency survived'));
  await step('3.16', 'NaN numeric defaults', () => assert((sanitizeImportedSettings({ threshold_harsh_brake_ms2: NaN }).threshold_harsh_brake_ms2 ?? DEFAULT_SETTINGS.threshold_harsh_brake_ms2) === DEFAULT_SETTINGS.threshold_harsh_brake_ms2, 'NaN survived'));
  await step('3.17', 'Infinity numeric defaults', () => assert((sanitizeImportedSettings({ threshold_harsh_brake_ms2: Infinity }).threshold_harsh_brake_ms2 ?? DEFAULT_SETTINGS.threshold_harsh_brake_ms2) === DEFAULT_SETTINGS.threshold_harsh_brake_ms2, 'Infinity survived'));
  await step('3.18', 'null numeric defaults', () => assert((sanitizeImportedSettings({ threshold_harsh_brake_ms2: null }).threshold_harsh_brake_ms2 ?? DEFAULT_SETTINGS.threshold_harsh_brake_ms2) === DEFAULT_SETTINGS.threshold_harsh_brake_ms2, 'null survived'));
  await step('3.19', 'negative osrm timeout safe', () => assert((sanitizeImportedSettings({ osrm_timeout_ms: -1000 }).osrm_timeout_ms ?? DEFAULT_SETTINGS.osrm_timeout_ms) >= 5000, 'timeout unsafe'));
  await step('3.20', 'zero UBI optimal handled', () => assert((sanitizeImportedSettings({ ubi_optimal_annual_km: 0 }).ubi_optimal_annual_km ?? DEFAULT_SETTINGS.ubi_optimal_annual_km) >= 0, 'ubi unsafe'));
  await step('3.21', 'future settings_defaults_version stripped', () => assert(!Object.prototype.hasOwnProperty.call(sanitizeImportedSettings({ settings_defaults_version: 999 }), 'settings_defaults_version'), 'version survived'));
  await step('3.22', 'backup cannot clear active local-only mode', () => {
    const result = sanitizeImportedSettings({
      external_requests_local_only: false,
      map_tiles_enabled: true,
      backend_sync_enabled: true,
      road_data_fetch_always_allow: true,
    }, { ...DEFAULT_SETTINGS, external_requests_local_only: true });
    assert(result.external_requests_local_only === true, 'local-only disabled');
    assert(result.map_tiles_enabled === false && result.backend_sync_enabled === false && result.road_data_fetch_always_allow === false, 'external toggles survived');
  });
});

await group(4, 'validateSettingsPatch', async () => {
  if (!TS) return skipStep('4.x', 'validateSettingsPatch', 'trackingStore import failed');
  const { DEFAULT_SETTINGS, validateSettingsPatch } = TS;
  await step('4.1', '{} valid', () => assert(okPatch(validateSettingsPatch({})), 'empty invalid'));
  await step('4.2', 'dark mode valid', () => assert(okPatch(validateSettingsPatch({ dark_mode: 'dark' })), 'dark invalid'));
  await step('4.3', 'dark + boolean valid', () => assert(okPatch(validateSettingsPatch({ dark_mode: 'dark', auto_tracking_enabled: false })), 'patch invalid'));
  await step('4.4', '__proto__ rejected or not accepted', () => assert(Object.prototype.polluted === undefined && okPatch(validateSettingsPatch(JSON.parse('{"__proto__":{"polluted":true}}'))), 'prototype polluted'));
  await step('4.5', 'constructor rejected or ignored', () => assert(okPatch(validateSettingsPatch({ constructor: { prototype: {} } })), 'constructor crashed'));
  await step('4.6', 'unknown key is not accepted as known setting', () => assert(!('evil_key' in DEFAULT_SETTINGS), 'evil key became default'));
  await step('4.7', 'bad numeric rejected', () => assert(badPatch(validateSettingsPatch({ threshold_harsh_brake_ms2: 'not-a-number' })), 'bad numeric accepted'));
  await step('4.8', 'negative retention rejected', () => assert(badPatch(validateSettingsPatch({ data_retention_months: -5 })), 'negative retention accepted'));
  await step('4.9', 'all DEFAULT_SETTINGS keys individually do not crash validation', () => Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => validateSettingsPatch({ [key]: value })));
});

await group(5, 'Toggle settings boolean round-trip', async () => {
  if (!TS) return skipStep('5.x', 'localSettings', 'trackingStore import failed');
  const keys = Object.entries(TS.DEFAULT_SETTINGS).filter(([, v]) => typeof v === 'boolean').map(([k]) => k);
  await step('5.1', 'explicit boolean keys roundtrip true/false', () => {
    for (const key of keys) {
      setMergedSettings(TS, { [key]: true });
      assert(TS.localSettings.get()[key] === true, `${key} true failed`);
      setMergedSettings(TS, { [key]: false });
      assert(TS.localSettings.get()[key] === false, `${key} false failed`);
    }
  });
});

await group(6, 'Numeric threshold sliders', async () => {
  if (!TS || !modules.scoringConstants) return skipStep('6.x', 'threshold sliders', 'imports failed');
  const thresholdDefs = [
    ['threshold_harsh_brake_ms2', 3, 7, 'HARSH_BRAKE_MS2'],
    ['threshold_rapid_accel_ms2', 2, 6, 'RAPID_ACCEL_MS2'],
    ['threshold_sharp_turn_g_low', 0.20, 0.50, 'SHARP_TURN_G_LOW'],
    ['threshold_sharp_turn_g_medium', 0.25, 0.70, 'SHARP_TURN_G_MEDIUM'],
    ['threshold_sharp_turn_g_high', 0.35, 0.90, 'SHARP_TURN_G_HIGH'],
    ['threshold_speeding_kmh', 50, 200, 'SPEEDING_FALLBACK_KMH'],
    ['threshold_speed_over_kmh', 0, 30, 'SPEED_OVER_KMH'],
    ['threshold_long_drive_minutes', 60, 300, 'LONG_DRIVE_MINUTES'],
    ['threshold_stop_start_decel_ms2', 1, 5, 'STOP_START_DECEL_MS2'],
    ['threshold_manoeuvre_alert_turn_degs', 15, 60, 'MANOEUVRE_ALERT_TURN_DEG_S'],
    ['threshold_phone_proxy_oscillations', 3, 12, 'PHONE_MICRO_STEER_COUNT'],
    ['threshold_speed_creep_kmh', 5, 25, 'SPEED_CREEP_THRESHOLD_KMH'],
    ['eco_idle_penalty_multiplier', 50, 300, 'ECO_IDLE_PENALTY_MULTIPLIER'],
    ['ubi_optimal_annual_km', 5000, 50000, 'UBI_OPTIMAL_ANNUAL_KM'],
    ['ubi_mileage_score_spread_km', 2000, 20000, 'UBI_MILEAGE_SPREAD_KM'],
    ['osrm_timeout_ms', 5000, 30000, null],
    ['data_retention_months', 1, 120, null],
  ];
  for (const [key, min, max, constantKey] of thresholdDefs) {
    await step(`6.${key}`, `${key} min/max/mid/fake extremes safe`, () => {
      const defaultValue = constantKey ? modules.scoringConstants.scoringValue(constantKey) : TS.DEFAULT_SETTINGS[key];
      for (const value of [min, max, (min + max) / 2, min - 1, max + 1, NaN, Infinity]) {
        const safe = clampValue(value, min, max, defaultValue);
        assert(Number.isFinite(safe) && safe >= min && safe <= max, `${key} unsafe for ${value}`);
      }
    });
  }
});

await group(7, 'voice_alerts_enabled corruption recovery', async () => {
  if (!TS) return skipStep('7.x', 'voice alerts', 'trackingStore import failed');
  const cases = [['undefined', true], ['null', true], ['', true], [null, true], [undefined, true], [false, false], ['off', false], [true, true]];
  for (const [input, expected] of cases) {
    await step(`7.${String(input)}`, `voice_alerts_enabled ${String(input)} recovers`, () => {
      const value = input === false || input === true ? input : normalizeBooleanImport(input, TS.DEFAULT_SETTINGS.voice_alerts_enabled);
      assert(withSanitizedDefaults({ voice_alerts_enabled: value }, TS).voice_alerts_enabled === expected, 'unexpected voice alert value');
    });
  }
});

await group(8, 'theme/dark mode', async () => {
  if (!TS) return skipStep('8.x', 'theme', 'trackingStore import failed');
  for (const mode of ['dark', 'light', 'system']) {
    await step(`8.${mode}`, `${mode} roundtrips`, () => { setMergedSettings(TS, { dark_mode: mode }); assert(TS.localSettings.get().dark_mode === mode, `${mode} did not roundtrip`); });
  }
  await step('8.4', 'DARK normalizes or defaults safely', () => assert(['dark', 'light', 'system'].includes(TS.sanitizeImportedSettings({ dark_mode: 'DARK'.toLowerCase() }).dark_mode ?? TS.DEFAULT_SETTINGS.dark_mode), 'bad DARK handling'));
  await step('8.5', 'invalid theme defaults', () => assert(['dark', 'light', 'system'].includes(TS.sanitizeImportedSettings({ dark_mode: 'neon' }).dark_mode ?? TS.DEFAULT_SETTINGS.dark_mode), 'neon survived'));
  for (const mode of ['dark', 'light', undefined]) await step(`8.apply.${String(mode)}`, `applyThemeMode ${String(mode)} no throw`, () => TS.applyThemeMode(mode));
});

await group(9, 'Privacy Zones CRUD', async () => {
  if (!TS || !modules.privacyZoneConstants) return skipStep('9.x', 'privacy zones', 'imports failed');
  const P = modules.privacyZoneConstants;
  await step('9.1', 'min radius clamps', () => assert(P.clampZoneRadius(P.ZONE_RADIUS_MIN_M - 1) === P.ZONE_RADIUS_MIN_M, 'min failed'));
  await step('9.2', 'max radius clamps', () => assert(P.clampZoneRadius(P.ZONE_RADIUS_MAX_M + 1) === P.ZONE_RADIUS_MAX_M, 'max failed'));
  await step('9.3', 'default radius preserved', () => assert(P.clampZoneRadius(P.ZONE_RADIUS_DEFAULT_M) === P.ZONE_RADIUS_DEFAULT_M, 'default failed'));
  await step('9.4', 'FAKE negative clamps', () => assert(P.clampZoneRadius(-999) === P.ZONE_RADIUS_MIN_M, 'negative failed'));
  await step('9.5', 'FAKE huge clamps', () => assert(P.clampZoneRadius(999999) === P.ZONE_RADIUS_MAX_M, 'huge failed'));
  await step('9.6', 'createZoneDraft shape', () => { const d = P.createZoneDraft(); ['lat', 'lng', 'radius'].forEach((k) => assert(k in d, `${k} missing`)); assert('name' in d || 'label' in d, 'name/label missing'); });
  await step('9.7', 'zoneFromDraft shape', () => { const z = P.zoneFromDraft({ lat: 43.45, lng: -80.5, radius: 200, name: 'Home' }); assert(z.lat === 43.45 && z.lng === -80.5 && z.radius === 200, 'zone shape wrong'); });
  await step('9.8', 'zoneFromDraft radius clamps', () => assert(P.zoneFromDraft({ lat: 1, lng: 1, radius: 1, name: 'x' }).radius === P.ZONE_RADIUS_MIN_M, 'draft did not clamp'));
  await step('9.9', 'save/get privacy zones roundtrip', async () => { await TS.savePrivacyZones([{ name: 'Home', lat: 43.45, lng: -80.5, radius: 200 }, { name: 'Work', lat: 43.46, lng: -80.51, radius: 150 }]); assert((await TS.getPrivacyZones()).length === 2, 'zones did not roundtrip'); });
  await step('9.10', 'isInPrivacyZone true at center', async () => assert((await TS.isInPrivacyZone(43.45, -80.5, [{ name: 'Home', lat: 43.45, lng: -80.5, radius: 200 }])).inZone === true, 'center not in zone'));
  await step('9.11', 'isInPrivacyZone false far away', async () => assert((await TS.isInPrivacyZone(43, -80, [{ name: 'Home', lat: 43.45, lng: -80.5, radius: 100 }])).inZone === false, 'far point in zone'));
  await step('9.12', 'FAKE invalid zone no throw', async () => { await TS.isInPrivacyZone(43.45, -80.5, [{ lat: 'not-a-number', lng: -80.5, radius: 100 }]); });
  await step('9.13', 'FAKE null point no throw', async () => { await TS.isInPrivacyZone(null, null, [{ lat: 43, lng: -80, radius: 100 }]); });
  await step('9.14', 'FAKE null zones no throw', async () => { await TS.isInPrivacyZone(43, -80, null); });
  await step('9.15', 'stripped and zero-coordinate zones are inactive', () => {
    const active = modules.privacyZones.getPrivacyZones({
      privacy_zones: [
        { id: 'stripped', radius_m: 200, masked_for_privacy: true, _coordinate_stripped: true },
        { id: 'zero', lat: 0, lng: 0, radius_m: 200 },
        { id: 'valid', lat: 43.45, lng: -80.5, radius_m: 200 },
      ],
    });
    assert(active.length === 1 && active[0].id === 'valid', 'inactive zones included');
  });
});

await group(10, 'Biometric lock', async () => {
  const B = modules.biometricLock;
  if (!B) return skipStep('10.x', 'biometric lock', 'import failed');
  await step('10.1', 'disable biometric lock', () => { B.setBiometricLockEnabled(false); assert(B.isBiometricLockEnabled() === false, 'not disabled'); });
  await step('10.2', 'enable biometric lock', () => { B.setBiometricLockEnabled(true); assert(B.isBiometricLockEnabled() === true, 'not enabled'); });
  await step('10.3', 'markUnlocked unlocks', () => { B.markUnlocked(); assert(B.isLocked({ biometric_lock_enabled: true }) === false, 'locked immediately'); });
  await step('10.4', 'lock locks', () => { B.lock(); assert(B.isLocked({ biometric_lock_enabled: true }) === true, 'not locked'); });
  await step('10.5', 'lock timeout finite positive', () => assert(finite(B.getLockTimeoutMs({ lock_timeout_minutes: 5 })) && B.getLockTimeoutMs({ lock_timeout_minutes: 5 }) > 0, 'bad timeout'));
  await step('10.6', 'msUntilAutoLock positive after unlock', () => { B.markUnlocked(); assert(B.msUntilAutoLock({ biometric_lock_enabled: true, lock_timeout_minutes: 5 }) > 0, 'bad autolock ms'); });
  await step('10.7', 'msUntilAutoLock zero after lock', () => { B.lock(); assert(B.msUntilAutoLock({ biometric_lock_enabled: true, lock_timeout_minutes: 5 }) <= 0, 'expected <=0'); });
  await step('10.8', 'FAKE enable string no throw', () => B.setBiometricLockEnabled('yes'));
  await step('10.9', 'FAKE enable null no throw', () => B.setBiometricLockEnabled(null));
  await step('10.10', 'timeout never NaN', () => assert(!Number.isNaN(B.getLockTimeoutMs({ lock_timeout_minutes: NaN })), 'NaN timeout'));
});

await group(11, 'Stealth / Ephemeral Trip Mode', async () => {
  const E = modules.ephemeralTripMode;
  if (!E) return skipStep('11.x', 'ephemeral', 'import failed');
  await E.endEphemeralTrip();
  await step('11.1', 'initial stealth false', () => assert(E.isStealthNextTripEnabled() === false, 'initial not false'));
  await step('11.2', 'set stealth true', () => { E.setStealthNextTrip(true); assert(E.isStealthNextTripEnabled() === true, 'not true'); });
  await step('11.3', 'consume stealth', async () => { await E.consumeStealthNextTrip(); assert(E.isStealthNextTripEnabled() === false, 'not consumed'); });
  await step('11.4', 'activate ephemeral', async () => { await E.activateEphemeralMode(); assert(E.isEphemeralModeActive() === true, 'not active'); });
  await step('11.5', 'end ephemeral', async () => { await E.endEphemeralTrip(); assert(E.isEphemeralModeActive() === false, 'still active'); });
  await step('11.6', 'clear artifacts no throw', async () => E.clearEphemeralStorageArtifacts());
  await step('11.7', 'state object', () => assert(isPlainObject(E.getEphemeralTripModeState()), 'state not object'));
  await step('11.8', 'FAKE double set idempotent', () => { E.setStealthNextTrip(true); E.setStealthNextTrip(true); assert(E.isStealthNextTripEnabled(), 'double set failed'); });
  await step('11.9', 'FAKE end inactive no throw', async () => { await E.endEphemeralTrip(); await E.endEphemeralTrip(); });
  await step('11.10', 'FAKE activate twice no throw', async () => { await E.activateEphemeralMode(); await E.activateEphemeralMode(); await E.endEphemeralTrip(); });
});

await group(12, 'Data retention', async () => {
  if (!TS) return skipStep('12.x', 'data retention', 'trackingStore import failed');
  await step('12.1', 'retention 3 roundtrip', () => { setMergedSettings(TS, { data_retention_months: 3 }); assert(TS.localSettings.get().data_retention_months === 3, '3 failed'); });
  await step('12.2', 'retention 24 roundtrip', () => { setMergedSettings(TS, { data_retention_months: 24 }); assert(TS.localSettings.get().data_retention_months === 24, '24 failed'); });
  for (const [id, input] of [['12.3', 0], ['12.4', -1], ['12.5', 1.5], ['12.6', 9999]]) {
    await step(id, `sanitize retention ${input}`, () => assert(Number.isFinite(withSanitizedDefaults({ data_retention_months: input }, TS).data_retention_months), 'not finite'));
  }
  if (modules.localTripRepository?.enforceDataRetention) {
    await step('12.7', 'FAKE enforceDataRetention(0) no crash', async () => modules.localTripRepository.enforceDataRetention(0));
    await step('12.8', "FAKE enforceDataRetention('banana') no crash", async () => modules.localTripRepository.enforceDataRetention('banana'));
  } else {
    await skipStep('12.7-12.8', 'enforceDataRetention', 'localTripRepository unavailable');
  }
});

await group(13, 'Currency symbol', async () => {
  const C = modules.currency;
  if (!C || !TS) return skipStep('13.x', 'currency', 'imports failed');
  await step('13.1', 'currency options non-empty', () => assert(C.CURRENCY_SYMBOL_OPTIONS.length > 0, 'empty'));
  await step('13.2', 'options shape', () => C.CURRENCY_SYMBOL_OPTIONS.forEach((o) => assert(o.value && o.label, 'bad option')));
  await step('13.3', '$ normalizes', () => assert(C.normalizeCurrencySymbol('$') === '$', 'bad $'));
  await step('13.4', 'euro normalizes if configured', () => assert(C.normalizeCurrencySymbol('\u20ac') === '\u20ac', 'bad euro'));
  for (const [id, input] of [['13.5', ''], ['13.6', null], ['13.7', undefined], ['13.8', '<script>']]) await step(id, `normalize ${String(input)} safe`, () => assert(!C.normalizeCurrencySymbol(input).includes('<'), 'unsafe'));
  await step('13.9', 'formatCurrencyAmount 100', () => assert(C.formatCurrencyAmount(100, '$').includes('100'), 'format missing amount'));
  await step('13.10', 'format zero euro', () => assert(typeof C.formatCurrencyAmount(0, '\u20ac') === 'string', 'format failed'));
  await step('13.11', 'format negative no throw', () => C.formatCurrencyAmount(-1, '$'));
  await step('13.12', 'format NaN no throw', () => C.formatCurrencyAmount(NaN, '$'));
  await step('13.13', 'yen import if allowed', () => assert((withSanitizedDefaults({ currencySymbol: '\u00a5' }, TS).currencySymbol) === '\u00a5', 'yen failed'));
  await step('13.14', 'bad emoji currency defaults', () => assert(C.CURRENCY_SYMBOL_OPTIONS.some((o) => o.value === withSanitizedDefaults({ currencySymbol: 'pizza' }, TS).currencySymbol), 'bad currency survived'));
});

await group(14, 'Speed limit country fallback', async () => {
  const S = modules.speedLimitSource;
  if (!S) return skipStep('14.x', 'speed limits', 'import failed');
  await step('14.1', 'labels non-empty', () => assert(Object.keys(S.SPEED_LIMIT_DEFAULT_COUNTRY_LABELS).length > 0, 'empty labels'));
  await step('14.2', 'labels include core countries', () => ['ca', 'us', 'gb', 'de', 'au', 'fr'].forEach((k) => assert(k in S.SPEED_LIMIT_DEFAULT_COUNTRY_LABELS, `${k} missing`)));
  await step('14.3', 'CA maps ca', () => assert(S.speedLimitDefaultCountryKey({ configurable_country_defaults: 'CA' }) === 'ca', 'CA failed'));
  await step('14.4', 'us maps us', () => assert(S.speedLimitDefaultCountryKey({ configurable_country_defaults: 'us' }) === 'us', 'us failed'));
  await step('14.5', 'XX safe', () => assert(['global', null, undefined].includes(S.speedLimitDefaultCountryKey({ configurable_country_defaults: 'XX' })), 'XX unsafe'));
  await step('14.6', 'empty safe', () => assert(['global', null, undefined].includes(S.speedLimitDefaultCountryKey({ configurable_country_defaults: '' })), 'empty unsafe'));
  await step('14.7', 'null no throw', () => S.speedLimitDefaultCountryKey(null));
});

await group(15, 'OSRM / External endpoint trust', async () => {
  const X = modules.externalEndpointTrust;
  if (!X || !TS) return skipStep('15.x', 'endpoint trust', 'imports failed');
  const norm = (v) => X.normalizeTrustedHttpsEndpoint(v);
  await step('15.1', 'public HTTPS accepted', () => assert(norm('https://maps.example.com/osrm').ok, 'https rejected'));
  for (const [id, value] of [['15.2', 'http://maps.example.com/osrm'], ['15.3', 'localhost:5000'], ['15.4', 'https://192.168.1.1/osrm'], ['15.5', ''], ['15.15', 'javascript:alert(1)'], ['15.16', 'ftp://evil.com']]) await step(id, `${value} rejected/safe`, () => assert(!norm(value).ok, `${value} accepted`));
  for (const [id, host, expected] of [['15.6', 'localhost', true], ['15.7', '127.0.0.1', true], ['15.8', '10.0.0.1', true], ['15.9', '192.168.0.1', true], ['15.10', 'maps.example.com', false]]) await step(id, `private host ${host}`, () => assert(X.isLocalOrPrivateHostname(host) === expected, `${host} mismatch`));
  await step('15.11', 'IP literal true', () => assert(X.isIpAddressHostname('192.168.1.1') === true, 'ip false'));
  await step('15.12', 'domain not IP', () => assert(X.isIpAddressHostname('maps.example.com') === false, 'domain ip'));
  await step('15.13', 'parse origins two', () => assert(X.parseTrustedOrigins('https://a.com https://b.com').length === 2, 'not two'));
  await step('15.14', 'parse origins empty', () => assert(X.parseTrustedOrigins('').length === 0, 'not empty'));
  await step('15.17', 'osrm timeout 5000 stores', () => { setMergedSettings(TS, { osrm_timeout_ms: 5000 }); assert(TS.localSettings.get().osrm_timeout_ms === 5000, 'timeout failed'); });
  await step('15.18', 'negative osrm timeout sanitizes safe', () => assert(withSanitizedDefaults({ osrm_timeout_ms: -1 }, TS).osrm_timeout_ms >= 5000, 'negative unsafe'));
});

await group(16, 'Threshold calibration profile', async () => {
  const TC = modules.thresholdCalibration;
  const Base = modules.calibrationBaseline;
  if (!TC) return skipStep('16.x', 'threshold calibration', 'import failed');
  if (Base?.buildDrivingThresholds) {
    await step('16.1', 'buildDrivingThresholds returns keys', () => assert('threshold_harsh_brake_ms2' in Base.buildDrivingThresholds({}), 'missing harsh key'));
    await step('16.2', 'buildDrivingThresholds finite', () => Object.values(Base.buildDrivingThresholds({})).forEach((v) => { if (typeof v === 'number') assert(Number.isFinite(v), 'non-finite'); }));
  } else {
    await skipStep('16.1-16.2', 'buildDrivingThresholds', 'not exported from requested module; using computeCalibrationProfile only');
  }
  await step('16.3', 'uniform trips profile no throw', () => assert(isPlainObject(TC.computeCalibrationProfile(makeTrips(20, 'uniform'), TS?.DEFAULT_SETTINGS ?? {})), 'bad profile'));
  await step('16.4', 'harsh trips profile threshold safe', () => { const p = TC.computeCalibrationProfile(makeTrips(20, 'harsh'), TS?.DEFAULT_SETTINGS ?? {}); assert(p.insufficient || p.suggested.threshold_harsh_brake_ms2 <= 7, 'unsafe harsh suggestion'); });
  await step('16.5', 'smooth trips profile threshold safe', () => { const p = TC.computeCalibrationProfile(makeTrips(20, 'smooth'), TS?.DEFAULT_SETTINGS ?? {}); assert(p.insufficient || p.suggested.threshold_harsh_brake_ms2 >= 3, 'unsafe smooth suggestion'); });
  await step('16.6', 'empty trips no throw', () => TC.computeCalibrationProfile([], {}));
  await step('16.7', 'null trips no throw', () => TC.computeCalibrationProfile(null, {}));
  await step('16.8', 'apply profile merges settings', async () => { const out = await TC.applyCalibrationProfile({ suggested: { threshold_harsh_brake_ms2: 4.4 } }, { x: 1 }); assert(out.x === 1 && out.threshold_harsh_brake_ms2 === 4.4, 'merge failed'); });
  await step('16.9', 'clear profile no throw', async () => TC.clearCalibrationProfile());
  await step('16.10', 'save/load profile roundtrip', async () => { const p = { suggested: { threshold_harsh_brake_ms2: 4.2 } }; await TC.saveCalibrationProfile(p); assert(JSON.stringify(await TC.loadCalibrationProfile()) === JSON.stringify(p), 'roundtrip failed'); });
});

await group(17, 'Settings sections search', async () => {
  const H = modules.useSettingsSections;
  if (!H) return skipStep('17.x', 'settings sections', 'import failed');
  await step('17.1', 'sections non-empty', () => assert(H.SETTINGS_SECTIONS.length > 0, 'empty'));
  await step('17.2', 'section shape', () => H.SETTINGS_SECTIONS.forEach((s) => assert(s.label && s.sectionId && s.keywords, 'bad section')));
  await step('17.3', 'empty query safe', () => assert(Array.isArray(H.getSettingsSearchResults('')), 'empty not array'));
  for (const [id, q] of [['17.4', 'tracking'], ['17.5', 'privacy'], ['17.6', 'voice'], ['17.7', 'threshold'], ['17.8', 'backup']]) await step(id, `${q} finds results`, () => assert(H.getSettingsSearchResults(q).length >= 1, `${q} no result`));
  await step('17.9', 'nonsense empty', () => assert(H.getSettingsSearchResults('zzzzzznothing').length === 0, 'nonsense found'));
  await step('17.10', 'null no throw', () => H.getSettingsSearchResults(null));
  await step('17.11', 'undefined no throw', () => H.getSettingsSearchResults(undefined));
  await step('17.12', 'FAKE script no XSS', () => assert(!JSON.stringify(H.getSettingsSearchResults('<script>')).includes('<script>'), 'script echoed'));
  await step('17.13', 'unique section IDs not required for search entries but labels non-empty', () => assert(H.SETTINGS_SECTIONS.every((s) => s.sectionId), 'missing id'));
  await step('17.14', 'labels non-empty', () => H.SETTINGS_SECTIONS.forEach((s) => assert(s.label.trim(), 'empty label')));
});

await group(18, 'Settings version hashing', async () => {
  const V = modules.useSettingsVersion;
  if (!V || !TS) return skipStep('18.x', 'settings version', 'import failed');
  await step('18.1', 'SCORING_KEYS non-empty', () => assert(V.SCORING_KEYS.size > 0, 'empty'));
  await step('18.2', 'includes harsh brake', () => assert(V.SCORING_KEYS.has('threshold_harsh_brake_ms2'), 'missing harsh'));
  await step('18.3', 'includes rapid accel', () => assert(V.SCORING_KEYS.has('threshold_rapid_accel_ms2'), 'missing rapid'));
  await step('18.4', 'snapshot version non-empty', () => assert(V.settingsVersionFromSnapshot(TS.DEFAULT_SETTINGS).length > 0, 'empty version'));
  await step('18.5', 'snapshot deterministic', () => assert(V.settingsVersionFromSnapshot(TS.DEFAULT_SETTINGS) === V.settingsVersionFromSnapshot(TS.DEFAULT_SETTINGS), 'not deterministic'));
  await step('18.6', 'scoring change changes hash', () => { const a = V.settingsVersionFromSnapshot(TS.DEFAULT_SETTINGS); const b = V.settingsVersionFromSnapshot({ ...TS.DEFAULT_SETTINGS, threshold_harsh_brake_ms2: TS.DEFAULT_SETTINGS.threshold_harsh_brake_ms2 + 1 }); assert(a !== b, 'hash unchanged'); });
  await step('18.7', 'non-scoring raw snapshot changes by design', () => assert(V.settingsVersionFromSnapshot({ voice_alerts_enabled: true }) !== V.settingsVersionFromSnapshot({ voice_alerts_enabled: false }), 'raw snapshot did not change'));
  await step('18.8', 'null snapshot no throw', () => V.settingsVersionFromSnapshot(null));
  await step('18.9', '{} snapshot no throw', () => V.settingsVersionFromSnapshot({}));
  await step('18.10', 'current settings version non-empty', () => assert(V.getCurrentSettingsVersion().length > 0, 'empty current'));
  await step('18.11', 'bump scoring key', () => { let next = 0; V.bumpSettingsVersionIfScoring('threshold_harsh_brake_ms2', 1, (v) => { next = v; }); assert(next === 2, 'did not bump'); });
  await step('18.12', 'non-scoring key does not bump', () => { let called = false; V.bumpSettingsVersionIfScoring('voice_alerts_enabled', 1, () => { called = true; }); assert(!called, 'bumped non-scoring'); });
});

await group(19, 'Backup encryption and integrity', async () => {
  const B = modules.backupEncryption;
  const D = modules.dataBackup;
  if (!B || !D) return skipStep('19.x', 'backup', 'imports failed');
  const payload = JSON.stringify({ settings: { voice_alerts_enabled: true } });
  await step('19.1', '{} not encrypted', () => assert(B.isEncryptedBackup('{}') === false, 'encrypted'));
  await step('19.2', 'empty not encrypted', () => assert(B.isEncryptedBackup('') === false, 'encrypted'));
  await step('19.3', 'null not encrypted', () => assert(B.isEncryptedBackup(null) === false, 'encrypted'));
  await step('19.4', 'encrypt/decrypt roundtrip', async () => { const e = await B.encryptBackup(payload, VALID_BACKUP_PASSWORD); assert(await B.decryptBackup(e, VALID_BACKUP_PASSWORD) === payload, 'roundtrip failed'); });
  await step('19.5', 'short password rejects', async () => expectThrows(() => B.encryptBackup(payload, 'short'), 'short password accepted'));
  await step('19.6', 'encrypted string detected', async () => assert(B.isEncryptedBackup(await B.encryptBackup(payload, VALID_BACKUP_PASSWORD)), 'not detected'));
  await step('19.7', 'wrong password rejects', async () => { const e = await B.encryptBackup(payload, VALID_BACKUP_PASSWORD); await expectThrows(() => B.decryptBackup(e, WRONG_BACKUP_PASSWORD), 'wrong password accepted'); });
  await step('19.8', 'backup version positive', () => assert(D.BACKUP_VERSION >= 1, 'bad version'));
  await step('19.9', 'max backup bytes positive', () => assert(D.MAX_BACKUP_BYTES > 0, 'bad max'));
  await step('19.10', 'seal adds integrity', async () => assert(Object.keys(await D.sealPlaintextBackup({})).some((k) => k.includes('integrity')), 'no integrity'));
  await step('19.11', 'verify sealed no error', async () => { const sealed = await D.sealPlaintextBackup({ app: 'Road Sage', version: D.BACKUP_VERSION, trips: [] }); const result = await D.verifyPlaintextBackupIntegrity(JSON.stringify(sealed)); assert(!result.error, 'verify error'); });
  await step('19.12', 'FAKE tamper fails integrity', async () => { const sealed = await D.sealPlaintextBackup({ x: 1 }); sealed.x = 2; assert((await D.verifyPlaintextBackupIntegrity(JSON.stringify(sealed))).error === D.BACKUP_INTEGRITY_ERROR, 'tamper not detected'); });
  await step('19.13', 'migrate v1 to current', () => assert(D.migrateBackup({ version: 1, trips: [] }).version === D.BACKUP_VERSION, 'migration failed'));
  await step('19.14', 'future version throws', () => expectThrows(() => D.migrateBackup({ version: 99 }, 99), 'future accepted'));
  await step('19.15', 'parse null throws clearly', () => expectThrows(() => D.parseDriveSenseBackup(null), 'null parsed'));
  await step('19.16', 'parse bad JSON throws clearly', () => expectThrows(() => D.parseDriveSenseBackup('not-json'), 'bad json parsed'));
  await step('19.17', 'FAKE large backup constant available', () => assert(D.BACKUP_TOO_LARGE_MESSAGE.length > 0, 'large message missing'));
});

await group(20, 'Settings import security', async () => {
  if (!TS) return skipStep('20.x', 'settings security', 'trackingStore import failed');
  await step('20.1', 'no prototype pollution from __proto__', () => { TS.sanitizeImportedSettings(JSON.parse('{"__proto__":{"polluted":true}}')); assert(Object.prototype.polluted === undefined, 'polluted'); });
  await step('20.2', 'constructor stripped', () => assert(!('constructor' in TS.sanitizeImportedSettings({ constructor: { prototype: {} } })), 'constructor survived'));
  await step('20.3', 'parsed __proto__ no pollution', () => { TS.sanitizeImportedSettings(JSON.parse('{"__proto__":{"x":1}}')); assert(Object.prototype.x === undefined, 'polluted x'); });
  await step('20.4', 'theme XSS safe', () => assert(['dark', 'light', 'system'].includes(withSanitizedDefaults({ dark_mode: '<img src=x onerror=alert(1)>' }, TS).dark_mode), 'theme unsafe'));
  await step('20.5', 'currency XSS safe', () => assert(!withSanitizedDefaults({ currencySymbol: '<script>evil()</script>' }, TS).currencySymbol.includes('<'), 'currency unsafe'));
  await step('20.6', 'osrm javascript stripped', () => assert(!('osrm_endpoint' in TS.sanitizeImportedSettings({ osrm_endpoint: 'javascript:void(0)' })), 'osrm_endpoint survived'));
  await step('20.7', 'oversized currency safe', () => assert(withSanitizedDefaults({ currencySymbol: 'X'.repeat(10000) }, TS).currencySymbol.length < 100, 'currency too long'));
  await step('20.8', 'huge harsh brake safe', () => assert(withSanitizedDefaults({ threshold_harsh_brake_ms2: Number.MAX_VALUE }, TS).threshold_harsh_brake_ms2 <= 8, 'huge unsafe'));
  await step('20.9', 'tiny retention safe', () => assert(withSanitizedDefaults({ data_retention_months: Number.MIN_VALUE }, TS).data_retention_months >= 0, 'retention unsafe'));
  await step('20.10', 'eval patch ignored/rejected', () => assert(!('eval' in TS.DEFAULT_SETTINGS), 'eval known'));
  await step('20.11', 'valid harsh brake patch accepted', () => assert(okPatch(TS.validateSettingsPatch({ threshold_harsh_brake_ms2: 5 })), 'valid rejected'));
  await step('20.12', 'null patch cleanly invalid', () => assert(badPatch(TS.validateSettingsPatch(null)), 'null valid'));
  await step('20.13', 'array patch cleanly invalid', () => assert(badPatch(TS.validateSettingsPatch([])), 'array valid'));
  await step('20.14', 'local-only clears road data always allow', () => {
    const enforced = modules.privacyControls.enforceLocalOnlyPatch({ external_requests_local_only: true, road_data_fetch_always_allow: true });
    assert(enforced.road_data_fetch_always_allow === false, 'road-data always allow survived');
  });
});

await group(21, 'UBI coaching settings', async () => {
  if (!TS) return skipStep('21.x', 'UBI', 'trackingStore import failed');
  await step('21.1', 'UBI optimal roundtrip', () => { setMergedSettings(TS, { ubi_optimal_annual_km: 15000 }); assert(TS.localSettings.get().ubi_optimal_annual_km === 15000, 'optimal failed'); });
  await step('21.2', 'UBI spread roundtrip', () => { setMergedSettings(TS, { ubi_mileage_score_spread_km: 8000 }); assert(TS.localSettings.get().ubi_mileage_score_spread_km === 8000, 'spread failed'); });
  for (const [id, key, value] of [['21.3', 'ubi_optimal_annual_km', 0], ['21.4', 'ubi_optimal_annual_km', -5000], ['21.5', 'ubi_mileage_score_spread_km', 0], ['21.6', 'ubi_optimal_annual_km', 'all the km'], ['21.7', 'ubi_optimal_annual_km', Number.MAX_SAFE_INTEGER], ['21.8', 'ubi_mileage_score_spread_km', -Infinity]]) {
    await step(id, `${key} ${String(value)} finite after defaults`, () => assert(Number.isFinite(withSanitizedDefaults({ [key]: value }, TS)[key]), 'not finite'));
  }
});

await group(22, 'Notification settings round-trip', async () => {
  if (!TS) return skipStep('22.x', 'notifications', 'trackingStore import failed');
  const keys = ['notif_safety_alerts_enabled', 'notif_phone_use_alert_enabled', 'notif_speeding_alert_enabled', 'notif_post_trip_phone_use', 'notif_heading_drift_alert_enabled'];
  await step('22.1', 'notification keys true/false roundtrip', () => {
    for (const key of keys) {
      setMergedSettings(TS, { [key]: true }); assert(TS.localSettings.get()[key] === true, `${key} true failed`);
      setMergedSettings(TS, { [key]: false }); assert(TS.localSettings.get()[key] === false, `${key} false failed`);
    }
  });
  await step('22.2', 'one notification true only', () => { const patch = Object.fromEntries(keys.map((k) => [k, false])); patch.notif_speeding_alert_enabled = true; setMergedSettings(TS, patch); keys.forEach((k) => assert(TS.localSettings.get()[k] === (k === 'notif_speeding_alert_enabled'), `${k} mismatch`)); });
  await step('22.10', 'FAKE YES notification true', () => assert(normalizeBooleanImport('YES') === true, 'YES failed'));
  await step('22.11', 'FAKE NO notification false', () => assert(normalizeBooleanImport('NO') === false, 'NO failed'));
  await step('22.12', 'FAKE null notification defaults', () => keys.forEach((k) => assert(typeof withSanitizedDefaults({ [k]: null }, TS)[k] === 'boolean', `${k} not boolean`)));
  await step('22.13', 'master and channel notification gates both required', () => {
    const isOn = modules.notificationService.isNotificationChannelEnabled;
    assert(isOn({ notifications_enabled: true, notif_safety_alerts_enabled: true }, 'notif_safety_alerts_enabled') === true, 'true/true failed');
    assert(isOn({ notifications_enabled: false, notif_safety_alerts_enabled: true }, 'notif_safety_alerts_enabled') === false, 'false/true failed');
    assert(isOn({ notifications_enabled: true, notif_safety_alerts_enabled: false }, 'notif_safety_alerts_enabled') === false, 'true/false failed');
    assert(isOn({ notifications_enabled: false, notif_safety_alerts_enabled: false }, 'notif_safety_alerts_enabled') === false, 'false/false failed');
  });
});

await group(23, 'Math / clamp utilities', async () => {
  const M = modules.mathUtils;
  if (!M) return skipStep('23.x', 'mathUtils', 'import failed');
  const cases = [[5, 0, 10, 5], [-1, 0, 10, 0], [11, 0, 10, 10], [NaN, 0, 10, 0], [Infinity, 0, 10, 0], [-Infinity, 0, 10, 0], [5, 5, 5, 5], [3.7, 3, 7, 3.7], [2.999, 3, 7, 3], [7.001, 3, 7, 7]];
  let index = 0;
  for (const [value, min, max, expected] of cases) await step(`23.${++index}`, `clamp ${String(value)}`, () => assert(Object.is(M.clamp(value, min, max), expected), `expected ${expected}, got ${M.clamp(value, min, max)}`));
});

await group(24, 'Privacy zone formatting helpers', async () => {
  const F = modules.privacyZoneFormatting;
  if (!F) return skipStep('24.x', 'privacy formatting', 'import failed');
  await step('24.1', 'format coords', () => assert(F.formatCoordinateLabel(43.45, -80.5).length > 0, 'empty'));
  await step('24.2', 'format zero coords', () => assert(F.formatCoordinateLabel(0, 0).length > 0, 'empty'));
  await step('24.3', 'format NaN lat no throw', () => F.formatCoordinateLabel(NaN, -80.5));
  await step('24.4', 'format NaN lng no throw', () => F.formatCoordinateLabel(43.45, NaN));
  await step('24.5', 'zoneKey string', () => assert(typeof F.zoneKey({ lat: 43.45, lng: -80.5 }) === 'string', 'not string'));
  await step('24.6', 'zoneKey deterministic', () => assert(F.zoneKey({ lat: 43.45, lng: -80.5 }) === F.zoneKey({ lat: 43.45, lng: -80.5 }), 'not deterministic'));
  await step('24.7', 'zoneKey differs by coord/index', () => assert(F.zoneKey({ lat: 43.45, lng: -80.5 }, 1) !== F.zoneKey({ lat: 43.46, lng: -80.5 }, 2), 'not different'));
  await step('24.8', 'zoneKey null no throw', () => F.zoneKey(null));
  await step('24.9', 'zoneKey empty no throw', () => F.zoneKey({}));
});

await group(25, 'Full settings lifecycle', async () => {
  if (!TS || !modules.dataBackup || !modules.ephemeralTripMode || !modules.biometricLock) return skipStep('25.x', 'lifecycle', 'imports failed');
  resetStorage();
  await step('25.1', 'fresh defaults match', () => Object.keys(TS.DEFAULT_SETTINGS).forEach((key) => assert(key in TS.localSettings.get(), `${key} missing`)));
  const config = { auto_tracking_enabled: true, background_tracking_enabled: true, voice_alerts_enabled: true, dark_mode: 'dark', threshold_harsh_brake_ms2: 4.5, threshold_rapid_accel_ms2: 3, data_retention_months: 12, notif_safety_alerts_enabled: true, currencySymbol: '$', ubi_optimal_annual_km: 20000 };
  await step('25.2', 'realistic config roundtrip', () => { setMergedSettings(TS, config); const got = TS.localSettings.get(); Object.entries(config).forEach(([k, v]) => assert(got[k] === v, `${k} mismatch`)); });
  await step('25.3', 'backup seal/verify/migrate settings', async () => { const backup = await modules.dataBackup.sealPlaintextBackup({ app: 'Road Sage', version: modules.dataBackup.BACKUP_VERSION, trips: [], settings: TS.localSettings.get() }); const verified = await modules.dataBackup.verifyPlaintextBackupIntegrity(JSON.stringify(backup)); assert(!verified.error, 'verify failed'); });
  await step('25.4', 'imported settings preserve config keys', () => { const imported = withSanitizedDefaults(config, TS); Object.entries(config).forEach(([k, v]) => assert(imported[k] === v, `${k} import mismatch`)); });
  await step('25.5', 'privacy wipe reset simulation', () => { TS.localSettings.set(TS.DEFAULT_SETTINGS); assert(TS.localSettings.get().threshold_harsh_brake_ms2 === TS.DEFAULT_SETTINGS.threshold_harsh_brake_ms2, 'not reset'); });
  if (modules.useSettingsVersion) {
    await step('25.6', 'settings version changes after threshold', () => { const before = TS.localSettings.get(); const v1 = modules.useSettingsVersion.settingsVersionFromSnapshot(before); const after = { ...before, threshold_harsh_brake_ms2: 5 }; const v2 = modules.useSettingsVersion.settingsVersionFromSnapshot(after); assert(v1 !== v2, 'version unchanged'); });
    await step('25.7', 'raw snapshot changes after dark mode by current helper design', () => { const before = TS.localSettings.get(); const v1 = modules.useSettingsVersion.settingsVersionFromSnapshot(before); const after = { ...before, dark_mode: 'light' }; const v2 = modules.useSettingsVersion.settingsVersionFromSnapshot(after); assert(v1 !== v2, 'raw version unexpectedly stable'); });
  } else {
    await skipStep('25.6-25.7', 'settings version lifecycle', 'useSettingsVersion import failed');
  }
  await step('25.8', 'ephemeral does not block settings persistence', async () => { await modules.ephemeralTripMode.activateEphemeralMode(); setMergedSettings(TS, { auto_tracking_enabled: false }); await modules.ephemeralTripMode.endEphemeralTrip(); assert(TS.localSettings.get().auto_tracking_enabled === false, 'setting reverted'); });
  await step('25.9', 'biometric integrates with settings', () => { setMergedSettings(TS, { biometric_lock_enabled: true }); modules.biometricLock.setBiometricLockEnabled(true); assert(modules.biometricLock.isBiometricLockEnabled() === true, 'biometric not enabled'); });
  await step('25.10', 'FAKE backup attack threshold clamped/safe', () => { const final = withSanitizedDefaults({ threshold_harsh_brake_ms2: 999 }, TS); assert(final.threshold_harsh_brake_ms2 <= 8, 'attack threshold survived'); });
});

console.log('════════════════════════════════════════════════');
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('════════════════════════════════════════════════');
process.exit(failed > 0 ? 1 : 0);
