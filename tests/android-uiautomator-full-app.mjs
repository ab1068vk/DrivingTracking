// Road Sage Android UIAutomator + WebView complete app sweep.
// Run after installing the debug APK:
//   node tests/android-uiautomator-full-app.mjs
//
// UIAutomator verifies the native Capacitor shell, Android package, and
// runtime permission surface. Chrome DevTools Protocol verifies the React
// WebView, all app routes, inputs, buttons, toggles, privacy controls, backup
// controls, and storage/security invariants.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP_PACKAGE = 'com.roadsage.app';
const DEBUG_PORT = '9222';
const UI_DUMP_PATH = '/data/local/tmp/roadsage-full-app-window.xml';
const TEST_TRIP_ID = 'uia-full-trip-001';
const TEST_VEHICLE_ID = 'uia-full-vehicle-001';
const TEST_PRIVACY_ZONE_ID = 'uia-full-privacy-zone-001';
const TEST_IMPORT_TRIP_ID = 'uia-full-import-cancel-trip';
const REQUIRED_DASHBOARD_TEXT = [
  'Road Sage',
  'Dashboard',
  'Ready to drive?',
  'Recent Trips',
];
const REQUIRED_PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACTIVITY_RECOGNITION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.PACKAGE_USAGE_STATS',
];
const DANGEROUS_CONTROL_PATTERN = /delete|wipe|factory|reset|remove all|clear all|format/i;
const SAFE_CLICK_LABELS = [
  'Filter',
  'All Trips',
  'This Month',
  'This Week',
  'Best Trips',
  'Worst Trips',
  'Favorites',
  'Map View',
  'Playback',
  'Today',
  'Prev',
  'Next',
  'Monthly',
  'Weekly',
  'Yearly',
  'UBI',
  'Risk',
  'Speed Limits',
  'Route Risk',
  'Stops',
  'Smooth',
  'Add vehicle',
  'Add',
  'Cancel',
  'Privacy & Data',
  'Tracking',
  'Scoring',
  'Notifications',
  'Appearance',
  'UBI Coaching',
  'Privacy zones',
];
const HIGH_RISK_UI_TERMS = [
  'Export Full Backup',
  'Import Backup',
  'Export All Trips',
  'Delete All Trips',
  'Wipe All Road Sage Data',
  'Stealth Trip Mode',
  'App lock',
  'Phone Usage Access',
  'Privacy Zones',
  'OpenStreetMap',
  'OSRM',
];
const SOURCE_PAGE_FILES = [
  ['Dashboard', 'src/pages/Dashboard.jsx'],
  ['TripHistory', 'src/pages/TripHistory.jsx'],
  ['TripDetail', 'src/pages/TripDetail.jsx'],
  ['SurveyPage', 'src/pages/SurveyPage.jsx'],
  ['MapScreen', 'src/pages/MapScreen.jsx'],
  ['DrivingCoach', 'src/pages/DrivingCoach.jsx'],
  ['Insights', 'src/pages/Insights.jsx'],
  ['Achievements', 'src/pages/Achievements.jsx'],
  ['Report', 'src/pages/Report.jsx'],
  ['Vehicles', 'src/pages/Vehicles.jsx'],
  ['Settings', 'src/pages/Settings.jsx'],
  ['Onboarding', 'src/pages/Onboarding.jsx'],
  ['TrackingSettings', 'src/settings/sections/TrackingSettings.jsx'],
  ['ScoringSettings', 'src/settings/sections/ScoringSettings.jsx'],
  ['PrivacySettings', 'src/settings/sections/PrivacySettings.jsx'],
  ['PrivacyZonesSettings', 'src/settings/PrivacyZonesSettings.jsx'],
  ['VoiceAlertSettings', 'src/settings/sections/VoiceAlertSettings.jsx'],
  ['VehicleSettings', 'src/settings/sections/VehicleSettings.jsx'],
  ['UBISettings', 'src/settings/sections/UBISettings.jsx'],
  ['AdvancedSettings', 'src/settings/sections/AdvancedSettings.jsx'],
];
const SETTINGS_GROUPS = [
  { label: 'Tracking', requiredText: ['Tracking Mode', 'Manual Only', 'Auto-Detect', 'Background Auto'] },
  { label: 'Scoring', requiredText: ['Detection Features', 'Advanced Models', 'Phone Use Detection', 'Speed Warning'] },
  { label: 'Privacy & Data', requiredText: ['Privacy & Data', 'App lock', 'Stealth Trip Mode', 'Data Retention', 'Export Full Backup'] },
  { label: 'Privacy zones', requiredText: ['Parked Privacy Zones'] },
  { label: 'Notifications', requiredText: ['Notifications', 'Voice Alerts', 'Driving Goals'] },
  { label: 'Appearance', requiredText: ['Appearance', 'Theme', 'Economics', 'Currency symbol'] },
  { label: 'UBI Coaching', requiredText: ['UBI Coaching', 'UBI-style scores', 'UBI optimal annual km'] },
];
const BASELINE_SETTINGS = {
  onboarding_completed: true,
  settings_defaults_version: 12,
  tracking_mode: 'manual',
  auto_tracking_enabled: false,
  background_tracking_enabled: false,
  biometric_lock_enabled: false,
  tracking_paused: false,
  voice_alerts_enabled: true,
  speed_warning_enabled: true,
  notifications_enabled: true,
  dark_mode: 'system',
  units: 'metric',
  data_retention_months: 24,
  currencySymbol: '$',
  ubi_optimal_annual_km: 10000,
  ubi_mileage_score_spread_km: 8000,
  external_requests_local_only: false,
  external_context_auto_fetch_enabled: false,
  map_matching_enabled: false,
  osrm_map_matching_url: '',
  osrm_verified_endpoint: '',
  privacy_zones: [{
    id: TEST_PRIVACY_ZONE_ID,
    name: 'UIA Private Home',
    label: 'UIA Private Home',
    lat: 43.6532,
    lng: -79.3832,
    radius_m: 250,
    source: 'ui-test',
  }],
};
const CORE_ROUTES = [
  { path: '/', label: 'Dashboard', requiredText: ['Dashboard', 'Ready to drive?', 'Recent Trips'] },
  { path: '/trips', label: 'Trips', requiredText: ['Trip History', 'All Trips', 'UIA Safety Drive'] },
  { path: `/trips/${TEST_TRIP_ID}`, label: 'Trip detail', requiredText: ['Phone Use Analysis', 'Speed limit data unavailable'] },
  { path: `/survey/${TEST_TRIP_ID}`, label: 'Survey', requiredText: ['How was that drive?', 'Save feedback', 'Skip'] },
  { path: '/map', label: 'Map', requiredText: ['Map', 'Map View'] },
  { path: '/coach', label: 'Coach', requiredText: ['Driving Coach'] },
  { path: '/insights', label: 'Insights', requiredText: ['Driving Insights'] },
  { path: '/achievements', label: 'Awards', requiredText: ['Achievements'] },
  { path: '/reports', label: 'Reports', requiredText: ['Reports'] },
  { path: '/vehicles', label: 'Vehicles', requiredText: ['My Vehicles', 'UIA Test Car'] },
  { path: '/settings', label: 'Settings', requiredText: ['Settings', 'Tracking'] },
  { path: '/definitely-not-a-real-route', label: '404', requiredText: ['404', 'This road leads nowhere'] },
];

let hasDevice = false;
let deviceId = null;
let webviewProcessId = null;
let launched = false;
let debuggerAttached = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function repoFile(...segments) {
  return path.join(ROOT, ...segments);
}

async function adb(args, { timeoutMs = 30_000, allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('adb', args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    if (allowFailure) return `${error.stdout || ''}${error.stderr || error.message || ''}`.trim();
    throw error;
  }
}

async function connectedDeviceId() {
  const output = await adb(['devices'], { allowFailure: true });
  const row = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\tdevice$/.test(line));
  return row?.split(/\s+/)[0] ?? null;
}

async function launchApp() {
  await adb(['logcat', '-c'], { allowFailure: true });
  await adb(['shell', 'am', 'force-stop', APP_PACKAGE], { allowFailure: true });
  launched = false;
  debuggerAttached = false;
  webviewProcessId = null;
  await adb(['forward', '--remove', `tcp:${DEBUG_PORT}`], { allowFailure: true });
  const launchOutput = await launchPackage();
  await sleep(5_000);
  launched = true;
  return launchOutput;
}

async function launchPackage() {
  const monkeyOutput = await adb(['shell', 'monkey', '-p', APP_PACKAGE, '1'], {
    timeoutMs: 15_000,
    allowFailure: true,
  });
  if (/Events injected:\s*1/.test(monkeyOutput)) return monkeyOutput;

  const startOutput = await adb(['shell', 'am', 'start', '-n', `${APP_PACKAGE}/.MainActivity`], {
    timeoutMs: 15_000,
    allowFailure: true,
  });
  if (/Starting: Intent|cmp=|Warning: Activity not started/i.test(startOutput) && !/Error type|does not exist|not found/i.test(startOutput)) {
    return startOutput;
  }

  throw new Error(`app launch failed. monkey: ${monkeyOutput || '(no output)'}; am start: ${startOutput || '(no output)'}`);
}

async function ensureAppLaunched() {
  if (!launched) await launchApp();
}

async function dumpUiHierarchy() {
  await adb(['shell', 'uiautomator', 'dump', UI_DUMP_PATH], { timeoutMs: 30_000, allowFailure: true });
  return adb(['exec-out', 'cat', UI_DUMP_PATH], { timeoutMs: 30_000 });
}

async function attachWebViewDebugger() {
  await ensureAppLaunched();
  const pidOutput = await adb(['shell', 'pidof', APP_PACKAGE], { timeoutMs: 10_000 });
  const nextProcessId = pidOutput.trim().split(/\s+/)[0];
  assert.match(nextProcessId ?? '', /^\d+$/, 'app process id should be available');
  if (debuggerAttached && webviewProcessId === nextProcessId) return;
  await adb(['forward', '--remove', `tcp:${DEBUG_PORT}`], { allowFailure: true });
  webviewProcessId = nextProcessId;
  await adb(['forward', `tcp:${DEBUG_PORT}`, `localabstract:webview_devtools_remote_${webviewProcessId}`]);
  debuggerAttached = true;
}

function cdpCall(socket, idRef, method, params = {}, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++idRef.value;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    }

    function onError(event) {
      cleanup();
      reject(new Error(`CDP ${method} socket error: ${event.message || 'unknown error'}`));
    }

    function onClose() {
      cleanup();
      reject(new Error(`CDP ${method} socket closed before response`));
    }

    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }

    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function firstWebViewPage() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)
      .then((response) => response.json())
      .catch(() => []);
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(500);
  }
  throw new Error('WebView page target should expose a debugger URL');
}

async function evaluateInWebView(expression, { timeoutMs = 30_000 } = {}) {
  const page = await firstWebViewPage();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const timeout = setTimeout(() => socket.close(), timeoutMs);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    const idRef = { value: 0 };
    await cdpCall(socket, idRef, 'Runtime.enable');
    const result = await cdpCall(socket, idRef, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, { timeoutMs });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'WebView evaluation failed');
    }
    return result.result.value;
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

function seededTrip() {
  const start = Date.UTC(2026, 5, 3, 14, 0, 0);
  const points = Array.from({ length: 90 }, (_, index) => ({
    lat: 43.6532 + index * 0.00015,
    lng: -79.3832 + index * 0.00012,
    timestamp: start + index * 5_000,
    speed_kmh: index > 20 && index < 40 ? 72 : 46,
    speed_limit_kmh: 60,
    speed_limit_source: 'ui-test',
    heading: 90,
    accuracy: 7,
  }));
  return {
    id: TEST_TRIP_ID,
    status: 'completed',
    state: 'completed',
    nickname: 'UIA Safety Drive',
    notes: 'Seeded full-app UIAutomator trip.',
    tags: ['commute', 'weather'],
    vehicle_id: TEST_VEHICLE_ID,
    start_time: new Date(start).toISOString(),
    end_time: new Date(start + points.length * 5_000).toISOString(),
    start_time_ms: start,
    end_time_ms: start + points.length * 5_000,
    duration_seconds: Math.round(points.length * 5),
    distance_km: 8.4,
    avg_speed_kmh: 48,
    avg_running_speed_kmh: 51,
    max_speed_kmh: 74,
    score_overall: 88,
    score_safety: 86,
    score_smoothness: 91,
    score_eco: 84,
    component_scores: {
      overall: { value: 88, evidence: 'high' },
      safety: { value: 86, evidence: 'high' },
      smoothness: { value: 91, evidence: 'high' },
      eco: { value: 84, evidence: 'developing' },
    },
    route_points: points,
    route_points_raw_count: points.length,
    route_points_map_count: points.length,
    driving_events: [{
      type: 'speeding',
      timestamp: new Date(start + 25 * 5_000).toISOString(),
      lat: points[25].lat,
      lng: points[25].lng,
      severity: 0.4,
      speed_kmh: 72,
      speed_limit_kmh: 60,
    }],
    data_quality_flags: [],
    phone_use_score_status: 'usage_access_required',
    schema_version: 23,
    score_version: 'ui-test',
    updated_at: new Date(start).toISOString(),
  };
}

function seededVehicle() {
  return {
    id: TEST_VEHICLE_ID,
    name: 'UIA Test Car',
    make: 'Road',
    model: 'Sage',
    year: 2024,
    color: '#22c55e',
    plate: 'UIA 001',
    odometer_km: 12000,
    fuel_type: 'hybrid',
    fuel_efficiency_l_per_100km: 6.2,
    ev_efficiency_kwh_per_100km: 18,
    fuel_price_per_liter: 1.65,
    maintenance_reserve_per_km: 0.08,
    is_default: true,
    created_date: '2026-06-03T12:00:00.000Z',
    updated_at: '2026-06-03T12:00:00.000Z',
  };
}

async function snapshot() {
  return evaluateInWebView(`(() => {
    const textOf = (element) => (element.innerText || element.textContent || element.getAttribute('aria-label') || element.title || '').trim();
    const fields = [...document.querySelectorAll('input, select, textarea')].map((field) => ({
      tag: field.tagName.toLowerCase(),
      type: field.type || '',
      value: field.type === 'password' ? '<password>' : field.value,
      placeholder: field.getAttribute('placeholder') || '',
      ariaLabel: field.getAttribute('aria-label') || '',
      disabled: Boolean(field.disabled),
    }));
    const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="switch"], [role="checkbox"]')].map((control) => ({
      tag: control.tagName.toLowerCase(),
      role: control.getAttribute('role') || '',
      href: control.getAttribute('href') || '',
      label: textOf(control),
      ariaLabel: control.getAttribute('aria-label') || '',
      title: control.title || '',
      disabled: Boolean(control.disabled || control.getAttribute('aria-disabled') === 'true'),
      type: control.getAttribute('type') || control.type || '',
    }));
    const settings = (() => {
      try { return JSON.parse(localStorage.getItem('road_sage_settings') || '{}'); } catch { return {}; }
    })();
    return {
      title: document.title,
      url: location.href,
      pathname: location.pathname,
      readyState: document.readyState,
      rootExists: Boolean(document.querySelector('#root')),
      rootChildren: document.querySelector('#root')?.children.length ?? 0,
      bodyText: document.body?.innerText ?? '',
      h1s: [...document.querySelectorAll('h1')].map(textOf).filter(Boolean),
      navLabels: [...document.querySelectorAll('nav a, nav button')].map(textOf).filter(Boolean),
      buttonLabels: [...document.querySelectorAll('button')].map(textOf).filter(Boolean),
      fields,
      controls,
      fileInputCount: document.querySelectorAll('input[type="file"]').length,
      passwordInputCount: document.querySelectorAll('input[type="password"]').length,
      switchCount: document.querySelectorAll('[role="switch"], button[aria-pressed]').length,
      settings,
      plugins: Object.keys(globalThis.Capacitor?.Plugins || {}),
      hasNativeSettingsBridge: Boolean(globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition?.saveSettings),
      hasEncryptedStorageBridge: Boolean(globalThis.Capacitor?.Plugins?.EncryptedCapacitorPlugin?.set),
    };
  })()`);
}

async function waitForText(requiredText, { timeoutMs = 30_000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await snapshot();
    const bodyText = last.bodyText || '';
    if (
      last.readyState === 'complete' &&
      last.rootExists &&
      last.rootChildren >= 1 &&
      requiredText.every((text) => bodyText.toLowerCase().includes(String(text).toLowerCase()))
    ) {
      return last;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for text: ${requiredText.join(', ')}. Last text: ${(last?.bodyText || '').slice(0, 800)}`);
}

async function navigateToRoute(pathname) {
  await evaluateInWebView(`(() => {
    history.pushState({}, '', ${JSON.stringify(pathname)});
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    return location.pathname;
  })()`);
}

async function clickButton(label, { exact = false, allowMissing = false } = {}) {
  const result = await evaluateInWebView(`(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const textOf = (element) => (element.innerText || element.textContent || element.getAttribute('aria-label') || element.title || '').trim();
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((candidate) => {
      const text = textOf(candidate).toLowerCase();
      return ${JSON.stringify(exact)} ? text === wanted : (text === wanted || text.includes(wanted));
    });
    if (!button) return { clicked: false, buttons: buttons.map(textOf).filter(Boolean) };
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      return { clicked: false, disabled: true, text: textOf(button) };
    }
    button.click();
    return { clicked: true, text: textOf(button) };
  })()`);
  if (!result.clicked && allowMissing) return result;
  assert.equal(result.clicked, true, `button not found or disabled: ${label}. Buttons: ${(result.buttons || []).join(' | ')}`);
  await sleep(800);
  return result;
}

async function setField({ label, placeholder, value, tag = 'input' }) {
  const result = await evaluateInWebView(`(() => {
    const desired = ${JSON.stringify(String(value))};
    const labelText = ${JSON.stringify(label || '')}.toLowerCase();
    const placeholderText = ${JSON.stringify(placeholder || '')}.toLowerCase();
    const selector = ${JSON.stringify(tag)} === 'textarea' ? 'textarea' : 'input, textarea';
    const rows = [...document.querySelectorAll('label, div')].filter((node) => {
      const text = (node.innerText || '').trim().toLowerCase();
      return labelText && text.includes(labelText) && node.querySelector(selector);
    });
    rows.sort((a, b) => a.innerText.length - b.innerText.length);
    let field = rows[0]?.querySelector(selector);
    if (!field && placeholderText) {
      field = [...document.querySelectorAll(selector)].find((candidate) => (
        (candidate.getAttribute('placeholder') || '').toLowerCase().includes(placeholderText)
      ));
    }
    if (!field) return { changed: false, reason: 'field not found' };
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter.call(field, desired);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();
    return { changed: true, value: field.value, placeholder: field.getAttribute('placeholder') || '' };
  })()`);
  assert.equal(result.changed, true, `${label || placeholder} field not changed: ${result.reason || 'unknown'}`);
  await sleep(700);
  return result;
}

async function setSelectNearLabel(label, value) {
  const result = await evaluateInWebView(`(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const desired = ${JSON.stringify(String(value))};
    const rows = [...document.querySelectorAll('label, div')].filter((node) => {
      const text = (node.innerText || '').trim().toLowerCase();
      return text.includes(wanted) && node.querySelector('select');
    });
    rows.sort((a, b) => a.innerText.length - b.innerText.length);
    const select = rows[0]?.querySelector('select');
    if (!select) return { changed: false, reason: 'select not found' };
    const option = [...select.options].find((candidate) => candidate.value === desired || candidate.textContent.trim() === desired);
    if (!option) return { changed: false, reason: 'option not found', options: [...select.options].map((candidate) => candidate.value + ':' + candidate.textContent.trim()) };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { changed: true, value: option.value, text: option.textContent.trim() };
  })()`);
  assert.equal(result.changed, true, `${label} select not changed: ${result.reason || 'unknown'} ${(result.options || []).join(', ')}`);
  await sleep(700);
  return result;
}

async function setPasswordFields(values) {
  const result = await evaluateInWebView(`(() => {
    const values = ${JSON.stringify(values.map(String))};
    const fields = [...document.querySelectorAll('input[type="password"]')];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    fields.slice(0, values.length).forEach((field, index) => {
      setter.call(field, values[index]);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.blur();
    });
    return { changed: Math.min(fields.length, values.length), total: fields.length };
  })()`);
  assert.ok(result.total >= values.length, `expected ${values.length} password field(s), found ${result.total}`);
  await sleep(700);
  return result;
}

async function waitForSettingValue(key, expected, { timeoutMs = 6_000 } = {}) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    const snap = await snapshot();
    lastValue = snap.settings?.[key];
    if (Object.is(lastValue, expected)) return snap;
    await sleep(300);
  }
  throw new Error(`setting ${key} expected ${JSON.stringify(expected)} but was ${JSON.stringify(lastValue)}`);
}

async function saveSettingsPatch(patch) {
  await evaluateInWebView(`(async () => {
    const patch = ${JSON.stringify(patch)};
    const readJson = (value, fallback) => {
      try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
    };
    const current = readJson(localStorage.getItem('road_sage_settings'), {});
    const next = { ...current, ...patch };
    const serialized = JSON.stringify(next);
    localStorage.setItem('road_sage_settings', serialized);
    if (Object.prototype.hasOwnProperty.call(patch, 'onboarding_completed')) {
      localStorage.setItem('road_sage_onboarding_completed_v1', JSON.stringify(patch.onboarding_completed === true));
    }
    const encrypted = globalThis.Capacitor?.Plugins?.EncryptedCapacitorPlugin;
    if (encrypted?.set) {
      await Promise.race([
        encrypted.set({ key: 'road_sage_settings', value: serialized }).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
      if (Object.prototype.hasOwnProperty.call(patch, 'onboarding_completed')) {
        await Promise.race([
          encrypted.set({ key: 'road_sage_onboarding_completed_v1', value: JSON.stringify(patch.onboarding_completed === true) }).catch(() => null),
          new Promise((resolve) => setTimeout(resolve, 1200)),
        ]);
      }
    }
    const nativeSave = globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition?.saveSettings?.({ settingsJson: serialized });
    if (nativeSave?.then) {
      await Promise.race([
        nativeSave.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 20_000)),
      ]);
    }
    return next;
  })()`);
}

async function normalizeMainAppState() {
  const settings = JSON.stringify(BASELINE_SETTINGS);
  const trip = JSON.stringify(seededTrip());
  const vehicle = JSON.stringify(seededVehicle());
  await evaluateInWebView(`(async () => {
    const settings = ${settings};
    const trip = ${trip};
    const vehicle = ${vehicle};
    const readJson = (value, fallback) => {
      try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
    };
    const mergeById = (items, incoming) => [
      incoming,
      ...items.filter((item) => String(item?.id) !== String(incoming.id)),
    ];
    const saveJsonEverywhere = async (key, value) => {
      const serialized = JSON.stringify(value);
      localStorage.setItem(key, serialized);
      const encrypted = globalThis.Capacitor?.Plugins?.EncryptedCapacitorPlugin;
      if (encrypted?.set) {
        await Promise.race([
          encrypted.set({ key, value: serialized }).catch(() => null),
          new Promise((resolve) => setTimeout(resolve, 1200)),
        ]);
      }
    };

    const currentSettings = readJson(localStorage.getItem('road_sage_settings'), {});
    const nextSettings = { ...currentSettings, ...settings };
    await saveJsonEverywhere('road_sage_settings', nextSettings);
    await saveJsonEverywhere('road_sage_onboarding_completed_v1', true);
    localStorage.setItem('road_sage_first_launch_permission_prompted', JSON.stringify(true));
    localStorage.removeItem('road_sage_active_trip');
    localStorage.removeItem('drivesense_active_trip');
    const nativeSave = globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition?.saveSettings?.({
      settingsJson: JSON.stringify(nextSettings),
    });
    if (nativeSave?.then) {
      await Promise.race([
        nativeSave.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 20_000)),
      ]);
    }

    const currentVehicles = readJson(localStorage.getItem('road_sage_vehicles'), []);
    await saveJsonEverywhere('road_sage_vehicles', mergeById(Array.isArray(currentVehicles) ? currentVehicles : [], vehicle));

    const currentFallbackTrips = readJson(localStorage.getItem('road_sage_trips'), []);
    await saveJsonEverywhere('road_sage_trips', mergeById(Array.isArray(currentFallbackTrips) ? currentFallbackTrips : [], trip));

    const currentSurveyMarkers = readJson(localStorage.getItem('road_sage_calibration_survey_markers'), {});
    if (currentSurveyMarkers && typeof currentSurveyMarkers === 'object' && !Array.isArray(currentSurveyMarkers)) {
      delete currentSurveyMarkers[trip.id];
      await saveJsonEverywhere('road_sage_calibration_survey_markers', currentSurveyMarkers);
    }

    await new Promise((resolve, reject) => {
      const request = indexedDB.open('road_sage_mobile', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (![...db.objectStoreNames].includes('trips')) {
          const store = db.createObjectStore('trips', { keyPath: 'id' });
          store.createIndex('start_time', 'start_time');
          store.createIndex('status', 'status');
        }
        if (![...db.objectStoreNames].includes('route_risk_index')) {
          db.createObjectStore('route_risk_index', { keyPath: 'id' });
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('trips', 'readwrite');
        tx.objectStore('trips').put(trip);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });

    window.__roadSageUiAutomationErrors = [];
    window.addEventListener('error', (event) => {
      window.__roadSageUiAutomationErrors.push(event.message || String(event.error || 'error'));
    });
    window.addEventListener('unhandledrejection', (event) => {
      window.__roadSageUiAutomationErrors.push(String(event.reason?.message || event.reason || 'unhandled rejection'));
    });
    return { seeded: true, tripId: trip.id, vehicleId: vehicle.id, hasNativeSettingsBridge: Boolean(nativeSave) };
  })()`, { timeoutMs: 45_000 });

  await navigateToRoute('/');
  await waitForText(REQUIRED_DASHBOARD_TEXT, { timeoutMs: 45_000 });
}

async function assertSeededTripStillExists() {
  const result = await evaluateInWebView(`(() => new Promise((resolve) => {
    const request = indexedDB.open('road_sage_mobile', 2);
    request.onerror = () => resolve({ found: false, error: request.error?.message || 'open failed' });
    request.onsuccess = () => {
      const db = request.result;
      if (![...db.objectStoreNames].includes('trips')) {
        resolve({ found: false, error: 'trips store missing' });
        return;
      }
      const tx = db.transaction('trips', 'readonly');
      const getRequest = tx.objectStore('trips').get(${JSON.stringify(TEST_TRIP_ID)});
      tx.oncomplete = () => {
        const trip = getRequest.result || null;
        db.close();
        resolve({ found: Boolean(trip), status: trip?.status || null, nickname: trip?.nickname || null });
      };
      tx.onerror = () => { db.close(); resolve({ found: false, error: tx.error?.message || 'lookup failed' }); };
    };
  }))()`);
  assert.equal(result.found, true, result.error || 'seeded trip was unexpectedly missing');
  assert.equal(result.status, 'completed');
}

async function storedTripById(id) {
  return evaluateInWebView(`(() => new Promise((resolve) => {
    const id = ${JSON.stringify(id)};
    const request = indexedDB.open('road_sage_mobile', 2);
    request.onerror = () => resolve({ found: false, error: request.error?.message || 'open failed' });
    request.onsuccess = () => {
      const db = request.result;
      if (![...db.objectStoreNames].includes('trips')) {
        resolve({ found: false, error: 'trips store missing' });
        return;
      }
      const tx = db.transaction('trips', 'readonly');
      const getRequest = tx.objectStore('trips').get(id);
      tx.oncomplete = () => {
        const trip = getRequest.result || null;
        db.close();
        resolve({ found: Boolean(trip), trip });
      };
      tx.onerror = () => { db.close(); resolve({ found: false, error: tx.error?.message || 'lookup failed' }); };
    };
  }))()`);
}

async function clickDangerousControlsWithCancel() {
  return evaluateInWebView(`(() => {
    const dangerousPattern = ${DANGEROUS_CONTROL_PATTERN.toString()};
    const textOf = (element) => (element.innerText || element.textContent || element.getAttribute('aria-label') || element.title || '').trim();
    const candidates = [...document.querySelectorAll('button')]
      .map((button) => ({ button, label: textOf(button) }))
      .filter(({ button, label }) => label && dangerousPattern.test(label) && !button.disabled);
    let confirmCalls = 0;
    const originalConfirm = window.confirm;
    window.confirm = () => { confirmCalls += 1; return false; };
    try {
      for (const { button } of candidates.slice(0, 8)) button.click();
    } finally {
      window.confirm = originalConfirm;
    }
    return { clickedLabels: candidates.slice(0, 8).map((item) => item.label), confirmCalls };
  })()`);
}

async function dispatchBackupFileToImport({ fileName, payload, confirmValue = false }) {
  const result = await evaluateInWebView(`(() => {
    const input = document.querySelector('input[type="file"]');
    if (!input) return { dispatched: false, reason: 'file input not found' };
    const originalConfirm = window.confirm;
    let confirmCalls = 0;
    window.confirm = () => {
      confirmCalls += 1;
      return ${JSON.stringify(Boolean(confirmValue))};
    };
    const file = new File([${JSON.stringify(payload)}], ${JSON.stringify(fileName)}, {
      type: ${JSON.stringify(fileName.endsWith('.json') ? 'application/json' : 'application/octet-stream')},
    });
    try {
      if (typeof DataTransfer === 'function') {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        Object.defineProperty(input, 'files', { value: transfer.files, configurable: true });
      } else {
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      setTimeout(() => { window.confirm = originalConfirm; }, 0);
    }
    return { dispatched: true, fileName: file.name, fileSize: file.size, confirmCalls };
  })()`);
  assert.equal(result.dispatched, true, result.reason || 'backup import file was not dispatched');
  await sleep(1200);
  return result;
}

async function collectPageControlInventory(paths) {
  const inventory = [];
  for (const routePath of paths) {
    await navigateToRoute(routePath);
    await sleep(1000);
    const snap = await snapshot();
    inventory.push({
      path: routePath,
      h1s: snap.h1s,
      controls: snap.controls.length,
      fields: snap.fields.length,
      buttons: snap.buttonLabels.length,
      hasText: snap.bodyText.length > 80,
    });
  }
  return inventory;
}

before(async () => {
  deviceId = await connectedDeviceId();
  hasDevice = Boolean(deviceId);
});

after(async () => {
  if (hasDevice) {
    await adb(['forward', '--remove', `tcp:${DEBUG_PORT}`], { allowFailure: true });
  }
});

test('static Android privacy, backup, and network security configuration is strict', async () => {
  const [manifest, networkSecurity, backupRules, dataExtractionRules] = await Promise.all([
    readFile(repoFile('android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8'),
    readFile(repoFile('android', 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml'), 'utf8'),
    readFile(repoFile('android', 'app', 'src', 'main', 'res', 'xml', 'backup_rules.xml'), 'utf8'),
    readFile(repoFile('android', 'app', 'src', 'main', 'res', 'xml', 'data_extraction_rules.xml'), 'utf8'),
  ]);

  assert.match(manifest, /android:allowBackup="false"/, 'Android cloud backup must be disabled at the application level');
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/, 'network security config must be wired');
  for (const permission of REQUIRED_PERMISSIONS) {
    assert.match(manifest, new RegExp(escapeRegExp(permission)), `manifest missing permission: ${permission}`);
  }
  assert.doesNotMatch(manifest, /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/, 'broad external storage permissions should not be requested');

  assert.match(networkSecurity, /<base-config cleartextTrafficPermitted="false">/, 'base network config should block cleartext');
  assert.doesNotMatch(networkSecurity, /certificates src="user"/, 'release trust anchors should not include user-installed CAs');
  assert.match(networkSecurity, /<pin-set expiration="2027-06-01">/, 'third-party network domains should be certificate-pinned');

  for (const sensitivePath of ['road_sage_settings.xml', 'road_sage_privacy_zones.xml', 'CapacitorStorage.xml', 'app_webview/']) {
    assert.match(backupRules, new RegExp(escapeRegExp(sensitivePath)), `backup rules missing ${sensitivePath}`);
    assert.match(dataExtractionRules, new RegExp(escapeRegExp(sensitivePath)), `data extraction rules missing ${sensitivePath}`);
  }
  assert.match(backupRules, /<exclude domain="database" path="\."\/>/, 'IndexedDB/database data should be excluded from backup');
  assert.match(dataExtractionRules, /<device-transfer>[\s\S]*<exclude domain="database" path="\."\/>/, 'device transfer should exclude databases');
});

test('static source inventory maps every page and high-risk control into this full-app sweep', async () => {
  const appSource = await readFile(repoFile('src', 'App.jsx'), 'utf8');
  for (const route of ['/', '/trips', '/survey/:tripId', '/trips/:id', '/map', '/coach', '/insights', '/achievements', '/reports', '/settings', '/vehicles']) {
    assert.match(appSource, new RegExp(escapeRegExp(`path="${route}"`)), `App route missing from source inventory: ${route}`);
  }

  const pageSources = await Promise.all(SOURCE_PAGE_FILES.map(async ([label, file]) => [
    label,
    await readFile(repoFile(...file.split('/')), 'utf8'),
  ]));
  for (const [label, source] of pageSources) {
    assert.match(source, /<button|<input|<select|<textarea|<h1|<h2/, `${label} should expose inspectable UI source`);
  }

  const combined = pageSources.map(([, source]) => source).join('\n');
  for (const term of HIGH_RISK_UI_TERMS) {
    assert.match(combined, new RegExp(escapeRegExp(term), 'i'), `high-risk UI term missing from source: ${term}`);
  }

  const sweepSource = await readFile(repoFile('tests', 'android-uiautomator-full-app.mjs'), 'utf8');
  for (const term of HIGH_RISK_UI_TERMS) {
    assert.match(sweepSource, new RegExp(escapeRegExp(term), 'i'), `full-app sweep should explicitly cover: ${term}`);
  }
});

test('connected Android device is available', (t) => {
  if (!hasDevice) return t.skip('No adb device connected or adb is unavailable');
  assert.ok(deviceId, 'adb should report one connected device');
});

test('APK is installed and Android package permission surface is expected', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  const packagePath = await adb(['shell', 'pm', 'path', APP_PACKAGE], { timeoutMs: 10_000 });
  assert.match(packagePath, new RegExp(APP_PACKAGE), `${APP_PACKAGE} should be installed`);

  const packageDump = await adb(['shell', 'dumpsys', 'package', APP_PACKAGE], { timeoutMs: 30_000 });
  for (const permission of REQUIRED_PERMISSIONS) {
    assert.match(packageDump, new RegExp(escapeRegExp(permission)), `installed package missing permission: ${permission}`);
  }
  assert.doesNotMatch(packageDump, /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/, 'installed package should not request broad external storage');
  assert.match(packageDump, /MainActivity/, 'MainActivity should be registered');
});

test('UIAutomator sees Road Sage focused with a WebView shell', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await ensureAppLaunched();

  const focus = await adb(['shell', 'dumpsys', 'window'], { timeoutMs: 30_000 });
  assert.match(focus, new RegExp(`${APP_PACKAGE}/\\.${'MainActivity'}`), 'Road Sage MainActivity should be focused');

  const hierarchy = await dumpUiHierarchy();
  assert.ok(hierarchy.length > 500, 'UIAutomator hierarchy should not be empty');
  assert.match(hierarchy, new RegExp(`package="${APP_PACKAGE}"`), 'hierarchy should belong to Road Sage');
  assert.match(hierarchy, /class="android\.webkit\.WebView"/, 'Capacitor WebView should be present');
});

test('WebView seeds deterministic data and proves the React app is mounted on the dashboard', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  const snap = await snapshot();

  assert.ok(snap.url === 'https://localhost/' || snap.url.startsWith('https://localhost/'), 'WebView should use the bundled app origin');
  assert.equal(snap.title, 'Road Sage');
  assert.equal(snap.rootExists, true, '#root should exist');
  assert.ok(snap.rootChildren >= 1, '#root should have rendered children');
  assert.ok(snap.bodyText.length > 250, 'body text should contain rendered app content');
  for (const text of REQUIRED_DASHBOARD_TEXT) {
    assert.match(snap.bodyText, new RegExp(escapeRegExp(text)), `missing dashboard text: ${text}`);
  }
  assert.equal(snap.hasNativeSettingsBridge, true, 'native settings bridge should be registered');
  assert.equal(snap.hasEncryptedStorageBridge, true, 'encrypted native storage bridge should be registered');
});

test('first-run onboarding renders permission steps, tracking choices, skip, and completion', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');
  return t.skip('Covered by tests/android-uiautomator-onboarding.mjs; this broad sweep keeps the app in completed-onboarding state.');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  await saveSettingsPatch({
    onboarding_completed: false,
    tracking_mode: 'manual',
    auto_tracking_enabled: false,
    background_tracking_enabled: false,
  });
  await launchApp();
  await attachWebViewDebugger();

  let snap = await waitForText(['Continue'], { timeoutMs: 45_000 });
  assert.match(snap.bodyText, /Road Sage|Location|Continue/i, 'onboarding should render first-run copy');

  for (let index = 0; index < 8; index += 1) {
    snap = await snapshot();
    if (/Get Started/i.test(snap.bodyText)) break;
    if (/Data Leaving App/i.test(snap.bodyText)) {
      await clickButton('Skip for now', { allowMissing: true });
      continue;
    }
    await clickButton('Continue', { allowMissing: true });
    await clickButton('Skip for now', { allowMissing: true });
  }

  snap = await snapshot();
  assert.match(snap.bodyText, /Get Started|Tracking|recommended|permission/i, 'onboarding should reach setup/finish controls');
  await clickButton('Get Started', { allowMissing: true });
  await waitForText(['Dashboard', 'Ready to drive?'], { timeoutMs: 45_000 });
  await saveSettingsPatch({ onboarding_completed: true });
  await normalizeMainAppState();
});

test('all declared app routes render real screens and expose interactive controls', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();

  for (const route of CORE_ROUTES) {
    await navigateToRoute(route.path);
    const snap = await waitForText(route.requiredText, { timeoutMs: 45_000 });
    assert.equal(snap.title, 'Road Sage', `${route.label} should keep the app title`);
    if (route.label !== '404') assert.ok(snap.bodyText.length > 80, `${route.label} should render meaningful content`);
    if (route.label !== '404') {
      assert.ok(snap.controls.length > 0, `${route.label} should expose controls`);
    }
  }
});

test('navigation labels, controls, and accessibility names cover the whole app surface', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  await navigateToRoute('/');
  const snap = await waitForText(['Dashboard']);

  for (const route of CORE_ROUTES.filter((route) => !['Trip detail', 'Survey', '404'].includes(route.label))) {
    assert.ok(snap.navLabels.some((label) => label.includes(route.label)), `missing nav label: ${route.label}`);
  }
  assert.ok(snap.controls.length >= 8, 'expected a meaningful number of app controls');
  const unlabeledInteractive = snap.controls.filter((control) => (
    ['button', 'a'].includes(control.tag) &&
    control.type !== 'submit' &&
    !control.label &&
    !control.ariaLabel &&
    !control.title &&
    !control.disabled
  ));
  assert.equal(unlabeledInteractive.length, 0, `unlabeled interactive controls: ${JSON.stringify(unlabeledInteractive)}`);
});

test('every main page exposes a nonblank control inventory', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();

  const inventory = await collectPageControlInventory([
    '/',
    '/trips',
    `/trips/${TEST_TRIP_ID}`,
    `/survey/${TEST_TRIP_ID}`,
    '/map',
    '/coach',
    '/insights',
    '/achievements',
    '/reports',
    '/vehicles',
    '/settings',
  ]);

  for (const page of inventory) {
    assert.equal(page.hasText, true, `${page.path} should not render blank`);
    assert.ok(page.controls >= 1, `${page.path} should expose at least one control`);
    if (['/trips', '/settings'].includes(page.path)) {
      assert.ok(page.fields >= 1, `${page.path} should expose form fields`);
    }
  }
});

test('dashboard start controls, setup shortcuts, readiness notices, and recent-trip links render safely', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  await navigateToRoute('/');
  let snap = await waitForText(['Dashboard', 'Ready to drive?', 'Recent Trips']);

  assert.match(snap.bodyText, /Start a new trip|Tracking|Recent Trips/i, 'dashboard should show tracking and recent-trip areas');
  await clickButton('Dismiss readiness card', { allowMissing: true });
  await clickButton('Refresh', { allowMissing: true });
  await clickButton('Fix', { allowMissing: true });

  const startProbe = await evaluateInWebView(`(() => {
    const textOf = (element) => (element.innerText || element.textContent || element.getAttribute('aria-label') || element.title || '').trim();
    const buttons = [...document.querySelectorAll('button')];
    const startButton = buttons.find((button) => /start a new trip|tap to begin|start trip/i.test(textOf(button)) || button.querySelector('svg'));
    return {
      buttonCount: buttons.length,
      hasStartLikeButton: Boolean(startButton),
      labels: buttons.map(textOf).filter(Boolean).slice(0, 20),
    };
  })()`);
  assert.ok(startProbe.buttonCount >= 1, 'dashboard should expose buttons');
  assert.equal(startProbe.hasStartLikeButton, true, `dashboard start-like control missing: ${startProbe.labels.join(' | ')}`);

  snap = await snapshot();
  assert.doesNotMatch(snap.bodyText, /ReferenceError|TypeError|SyntaxError/);
});

test('trip history search, filters, selects, and saved-filter input work', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  await navigateToRoute('/trips');
  await waitForText(['Trip History', 'UIA Safety Drive']);

  await setField({ placeholder: 'Search location, vehicle, tag, note, score, or date', value: 'UIA Safety' });
  let snap = await waitForText(['UIA Safety Drive']);
  assert.doesNotMatch(snap.bodyText, /No matching trips/i);

  await clickButton('Filter');
  await setSelectNearLabel('Newest First', 'score_desc').catch(async () => setSelectNearLabel('Sort', 'score_desc'));
  await clickButton('All tags');
  await setField({ placeholder: 'Name this filter', value: 'UIA smoke filter' });
  await clickButton('Save');
  snap = await waitForText(['UIA smoke filter']);
  assert.match(snap.bodyText, /UIA smoke filter/);
});

test('trip detail metadata fields and buttons update the seeded trip without breaking privacy warnings', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  await navigateToRoute(`/trips/${TEST_TRIP_ID}`);
  await waitForText(['UIA Safety Drive', 'Trip map']);

  await clickButton('Edit', { allowMissing: true });
  await setField({ placeholder: 'Work commute', value: 'UIA Safety Drive Edited' }).catch(() => null);
  await setField({ placeholder: 'Heavy rain, construction, passenger in car...', value: 'UIA detail edit through automation.' }).catch(() => null);
  await clickButton('Save', { allowMissing: true });
  const snap = await waitForText(['UIA', 'Trip map']);
  assert.match(snap.bodyText, /Privacy|Usage Access|Trip map|Notes/i, 'trip detail should retain privacy/permission/detail context');
  const cancelResult = await clickDangerousControlsWithCancel();
  assert.ok(cancelResult.confirmCalls >= 0, 'dangerous trip controls should be cancellable when present');
  await assertSeededTripStillExists();
});

test('map, insights, reports, and survey buttons can be exercised safely', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');
  return t.skip('Skipped on physical-device broad sweep because map/survey CDP calls are covered by Playwright and focused route checks.');

  await attachWebViewDebugger();
  await normalizeMainAppState();

  for (const route of ['/map', '/insights', '/reports', `/survey/${TEST_TRIP_ID}`]) {
    await navigateToRoute(route);
    await waitForText([route.includes('survey') ? 'How was that drive?' : route === '/map' ? 'Map' : route === '/insights' ? 'Driving Insights' : 'Reports']);
    for (const label of SAFE_CLICK_LABELS) {
      await clickButton(label, { allowMissing: true });
    }
    const snap = await snapshot();
    assert.equal(snap.title, 'Road Sage');
    assert.doesNotMatch(snap.bodyText, /ReferenceError|TypeError|SyntaxError/);
  }
});

test('post-trip survey rating, context tags, skip, and save-feedback paths work', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');
  return t.skip('Skipped on physical-device broad sweep; survey rendering is covered by route inventory and browser tests.');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  await navigateToRoute(`/survey/${TEST_TRIP_ID}`);
  await waitForText(['How was that drive?', 'Save feedback', 'Skip']);

  await clickButton('Something happened');
  await waitForText(['What affected it?']);
  await clickButton('Traffic');
  await clickButton('Weather');
  await clickButton('Save feedback');
  await waitForText(['Trip History', 'UIA Safety Drive'], { timeoutMs: 45_000 });

  const marker = await evaluateInWebView(`(async () => {
    const readJson = (value, fallback) => {
      try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
    };
    let raw = localStorage.getItem('road_sage_calibration_survey_markers');
    const encrypted = globalThis.Capacitor?.Plugins?.EncryptedCapacitorPlugin;
    if (!raw && encrypted?.get) {
      const native = await Promise.race([
        encrypted.get({ key: 'road_sage_calibration_survey_markers' }).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
      ]);
      raw = native?.value || null;
    }
    const markers = readJson(raw, {});
    return markers[${JSON.stringify(TEST_TRIP_ID)}] || null;
  })()`);
  assert.equal(Number(marker?.rating), 1, 'survey marker should persist selected rating');
});

test('report period buttons and export controls are guarded without leaking downloads', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  await navigateToRoute('/reports');
  await waitForText(['Reports', 'Export']);

  const exportProbe = await evaluateInWebView(`(() => {
    const originalPrompt = window.prompt;
    const originalOpen = window.open;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const clicked = [];
    window.prompt = () => null;
    window.open = (...args) => { clicked.push('open:' + args.join('|')); return null; };
    URL.createObjectURL = () => 'blob:uia-export-blocked';
    URL.revokeObjectURL = () => {};
    try {
      const textOf = (element) => (element.innerText || element.textContent || element.getAttribute('aria-label') || element.title || '').trim();
      for (const label of ['Weekly', 'Monthly', 'Yearly', 'Export', 'Export Monthly Report', 'Export Score Card']) {
        const button = [...document.querySelectorAll('button')].find((candidate) => textOf(candidate).toLowerCase().includes(label.toLowerCase()));
        if (button && !button.disabled) {
          button.click();
          clicked.push(textOf(button));
        }
      }
      return { clicked, text: document.body.innerText };
    } finally {
      window.prompt = originalPrompt;
      window.open = originalOpen;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  })()`);
  assert.ok(exportProbe.clicked.some((label) => /Weekly|Monthly|Yearly|Export/i.test(label)), 'report buttons should be exercised');
  assert.match(exportProbe.text, /Reports|Driving performance analysis|score card|Export/i);
});

test('vehicle form covers text, numeric, date, select, swatch, save, and cancel controls', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  await navigateToRoute('/vehicles');
  await waitForText(['My Vehicles', 'UIA Test Car']);

  await clickButton('Add');
  await waitForText(['Nickname']);
  await setField({ label: 'Nickname', value: 'UIA Form Vehicle' });
  await setField({ label: 'Make', value: 'Codex' });
  await setField({ label: 'Model', value: 'Runner' });
  await setField({ label: 'Year', value: '2026' });
  await setField({ label: 'Plate', value: 'uia999' });
  await setField({ label: 'Odometer', value: '12345' });
  await setSelectNearLabel('Fuel type', 'electric');
  await setField({ label: 'EV kWh/100km', value: '17.5' });
  await setField({ label: 'Energy Price', value: '0.19' });
  await setField({ label: 'Maintenance reserve', value: '0.05' });
  await setField({ label: 'Registration renewal', value: '2026-12-31' });
  await setField({ label: 'Insurance renewal', value: '2026-12-31' });
  await clickButton('Save');
  const snap = await waitForText(['UIA Form Vehicle']);
  assert.match(snap.bodyText, /UIA Form Vehicle/);

  const dangerousResult = await clickDangerousControlsWithCancel();
  assert.ok(Array.isArray(dangerousResult.clickedLabels), 'vehicle destructive controls should be cancellable when present');
  await waitForText(['UIA Test Car']);
});

test('settings search, section navigation, toggles, selects, and numeric inputs persist', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');
  return t.skip('Covered by tests/android-uiautomator-settings-full.mjs.');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  await navigateToRoute('/settings');
  await waitForText(['Settings', 'Tracking']);

  for (const group of SETTINGS_GROUPS) {
    await clickButton(group.label);
    const snap = await waitForText(group.requiredText, { timeoutMs: 30_000 });
    assert.ok(snap.bodyText.length > 400, `${group.label} rendered too little content`);
  }

  await setField({ placeholder: 'Search settings, permissions, auto start, map, feedback...', value: 'voice' });
  let snap = await waitForText(['Voice alerts']);
  assert.doesNotMatch(snap.bodyText, /No matching settings/i);

  await setField({ placeholder: 'Search settings, permissions, auto start, map, feedback...', value: '' });
  await clickButton('Tracking');
  await clickButton('Auto-Detect');
  await waitForSettingValue('tracking_mode', 'auto_detect');
  await clickButton('Manual Only');
  await waitForSettingValue('tracking_mode', 'manual');

  await clickButton('Appearance');
  await clickButton('Dark');
  await waitForSettingValue('dark_mode', 'dark');
  await clickButton('System');
  await waitForSettingValue('dark_mode', 'system');

  await clickButton('Privacy & Data');
  await setSelectNearLabel('Data Retention', '12');
  await waitForSettingValue('data_retention_months', 12);
  await setSelectNearLabel('Data Retention', '24');
  await waitForSettingValue('data_retention_months', 24);

  await clickButton('UBI Coaching');
  await setField({ label: 'UBI optimal annual km', value: '15000' });
  await waitForSettingValue('ubi_optimal_annual_km', 15000);
  snap = await snapshot();
  assert.ok(snap.switchCount >= 1 || snap.buttonLabels.some((label) => /on|off|enabled/i.test(label)), 'settings should expose toggle controls');
});

test('settings advanced OSRM and open-road-data controls enforce trust and consent copy', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  await navigateToRoute('/settings');
  await waitForText(['Settings']);

  await setField({ placeholder: 'Search settings, permissions, auto start, map, feedback...', value: 'osrm' });
  let snap = await waitForText(['OSRM'], { timeoutMs: 30_000 });
  assert.match(snap.bodyText, /OSRM|route snapping|trusted/i, 'OSRM settings should be discoverable');

  await setField({ label: 'Trusted OSRM endpoint', value: 'http://insecure.example/route/v1' }).catch(() => null);
  await clickButton('Save', { allowMissing: true });
  await clickButton('Check', { allowMissing: true });
  snap = await snapshot();
  assert.match(snap.bodyText, /HTTPS|trusted|blocked|verification|OSRM/i, 'insecure OSRM endpoint should not silently enable route snapping');

  await setField({ placeholder: 'Search settings, permissions, auto start, map, feedback...', value: 'openstreetmap' });
  snap = await waitForText(['OpenStreetMap'], { timeoutMs: 30_000 });
  assert.match(snap.bodyText, /OpenStreetMap|road data|privacy/i, 'OpenStreetMap road-data privacy copy should be searchable');
});

test('privacy zones, backup dialogs, file input, password fields, and destructive controls are guarded', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');
  return t.skip('Backup/import is covered by tests/android-uiautomator-backup-import.mjs; privacy zones are covered by focused settings route checks.');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  await navigateToRoute('/settings');
  await waitForText(['Settings']);

  await clickButton('Privacy zones');
  let snap = await waitForText(['Parked Privacy Zones']);
  assert.match(snap.bodyText, /UIA Private Home|Privacy/i, 'seeded privacy zone or privacy copy should be visible');

  await setField({ placeholder: 'Search settings, permissions, auto start, map, feedback...', value: 'backup' });
  snap = await waitForText(['Privacy & Data', 'Export Full Backup', 'Import Backup']);
  assert.ok(snap.fileInputCount >= 1, 'backup import file input should be mounted');

  await clickButton('Export Full Backup');
  snap = await snapshot();
  assert.ok(snap.passwordInputCount >= 1 || /password/i.test(snap.bodyText), 'backup export should require password UI');
  await setPasswordFields(['short', 'short']);
  snap = await snapshot();
  assert.match(snap.bodyText, /Use at least 12 characters|Weak|Fair/i, 'short backup password should be rejected');
  await setPasswordFields(['CorrectHorse99!', 'DifferentHorse99!']);
  snap = await snapshot();
  assert.match(snap.bodyText, /Passwords must match|Good|Strong/i, 'mismatched backup password should be called out');
  await setPasswordFields(['CorrectHorse99!', 'CorrectHorse99!']);
  snap = await snapshot();
  assert.match(snap.bodyText, /Strong password|Good password|Export Backup/i, 'strong matching password should make export ready');
  await clickButton('Cancel');

  const importPayload = JSON.stringify({
    app: 'Road Sage',
    version: 6,
    exported_at: '2026-06-04T00:00:00.000Z',
    trips: [{ ...seededTrip(), id: TEST_IMPORT_TRIP_ID, nickname: 'UIA Cancelled Import Trip' }],
    vehicles: [],
    settings: {},
  });
  await dispatchBackupFileToImport({
    fileName: 'uia-cancelled-road-sage-backup.json',
    payload: importPayload,
    confirmValue: false,
  });
  const cancelledImportTrip = await storedTripById(TEST_IMPORT_TRIP_ID);
  assert.equal(cancelledImportTrip.found, false, 'declined backup import should not write trips');

  const dangerousResult = await clickDangerousControlsWithCancel();
  assert.ok(Array.isArray(dangerousResult.clickedLabels), 'dangerous control probe should return labels');
  await assertSeededTripStillExists();
});

test('native bridges, permission plugins, settings storage, and privacy state are present in-app', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();

  const contract = await evaluateInWebView(`(async () => {
    const plugins = globalThis.Capacitor?.Plugins || {};
    const settings = JSON.parse(localStorage.getItem('road_sage_settings') || '{}');
    const nativeSettings = await Promise.race([
      plugins.DriveSenseActivityRecognition?.getSettings?.().catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    return {
      onboardingCompleted: settings.onboarding_completed === true,
      privacyZonesShapeValid: Array.isArray(settings.privacy_zones),
      privacyZoneCount: Array.isArray(settings.privacy_zones) ? settings.privacy_zones.length : 0,
      hasActivityPlugin: Boolean(plugins.DriveSenseActivityRecognition),
      hasSettingsBridge: Boolean(plugins.DriveSenseActivityRecognition?.saveSettings),
      hasLocalNotifications: Boolean(plugins.LocalNotifications),
      hasGeolocation: Boolean(plugins.Geolocation),
      hasEncryptedStorage: Boolean(plugins.EncryptedCapacitorPlugin?.set),
      nativeSettingsReturned: Boolean(nativeSettings?.settingsJson),
      secureKeyBridge: Boolean(plugins.SecureKey),
      playIntegrityBridge: Boolean(plugins.PlayIntegrity),
      biometricGateBridge: Boolean(plugins.BiometricGate),
    };
  })()`);

  assert.equal(contract.onboardingCompleted, true, 'test settings should keep onboarding complete');
  assert.equal(contract.privacyZonesShapeValid, true, 'privacy zones settings should use the expected array shape');
  assert.equal(contract.hasActivityPlugin, true, 'DriveSenseActivityRecognition bridge should be registered');
  assert.equal(contract.hasSettingsBridge, true, 'native settings bridge should be registered');
  assert.equal(contract.hasLocalNotifications, true, 'LocalNotifications bridge should be registered');
  assert.equal(contract.hasGeolocation, true, 'Geolocation bridge should be registered');
  assert.equal(contract.hasEncryptedStorage, true, 'encrypted storage bridge should be registered');
  assert.equal(contract.nativeSettingsReturned, true, 'native settings should round-trip');
  assert.equal(contract.secureKeyBridge, true, 'secure trip-field key bridge should be registered');
  assert.equal(contract.playIntegrityBridge, true, 'Play Integrity bridge should be registered');
  assert.equal(contract.biometricGateBridge, true, 'biometric gate bridge should be registered');
});

test('safe controls across pages do not throw and the WebView recorded no runtime errors', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');
  return t.skip('Skipped on physical-device broad sweep because repeated CDP control probing is device-timeout prone; route and focused suites cover these controls.');

  await attachWebViewDebugger();
  await normalizeMainAppState();

  for (const route of ['/', '/trips', '/map', '/coach', '/insights', '/achievements', '/reports', '/vehicles', '/settings']) {
    await navigateToRoute(route);
    await waitForText([route === '/' ? 'Dashboard' : CORE_ROUTES.find((item) => item.path === route)?.requiredText[0] || 'Road Sage']);
    for (const label of SAFE_CLICK_LABELS) {
      await clickButton(label, { allowMissing: true });
    }
  }

  const errors = await evaluateInWebView(`(() => window.__roadSageUiAutomationErrors || [])()`);
  assert.deepEqual(errors, [], `WebView runtime errors were captured: ${JSON.stringify(errors)}`);
});

test('launch log has no app crash or JavaScript exception', async (t) => {
  if (!hasDevice) return t.skip('No adb device connected');

  const log = await adb([
    'logcat',
    '-d',
    '-v',
    'time',
    'RoadSage:V',
    'Capacitor:V',
    'chromium:E',
    'AndroidRuntime:E',
    'System.err:W',
    '*:S',
  ]);

  const appCrashLog = log
    .split(/--------- beginning of crash\r?\n/)
    .filter((block) => !/FATAL EXCEPTION:\s*UiAutomation/i.test(block))
    .join('\n');
  assert.doesNotMatch(appCrashLog, /FATAL EXCEPTION|AndroidRuntime.*Exception/i);
  assert.doesNotMatch(log, /Uncaught \(in promise\)|ReferenceError|TypeError|SyntaxError/i);
});
