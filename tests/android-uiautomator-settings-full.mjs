// Road Sage Android UIAutomator + WebView settings persistence audit.
// Run after installing the debug APK:
//   node tests/android-uiautomator-settings-full.mjs
//
// This is intentionally a UI-driven test. It taps/changes the real Settings
// controls, waits until the native settings bridge has the new values, then
// force-stops and relaunches the app to prove those values survived process
// death. The final restart assertion is the important part for regressions
// like "App lock looked enabled until the app was closed."

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APP_PACKAGE = 'com.roadsage.app';
const DEBUG_PORT = '9223';
const UI_DUMP_PATH = '/data/local/tmp/roadsage-settings-window.xml';
const SETTINGS_ROUTE = '/settings';
const NATIVE_SETTINGS_READ_TIMEOUT_MS = 5_000;

const RUNTIME_PERMISSIONS = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACTIVITY_RECOGNITION',
  'android.permission.POST_NOTIFICATIONS',
];

const SETTINGS_GROUPS = [
  { label: 'Tracking', requiredText: ['Tracking Mode', 'Manual Only', 'Auto-Detect', 'Background Auto'] },
  { label: 'Scoring', requiredText: ['Detection Features', 'Advanced Models', 'Phone Use Detection', 'Speed Warning'] },
  { label: 'Privacy & Data', requiredText: ['Privacy & Data', 'App lock', 'Stealth Trip Mode', 'Data Retention', 'Export Full Backup'] },
  { label: 'Privacy zones', requiredText: ['Parked Privacy Zones'] },
  { label: 'Notifications', requiredText: ['Notifications', 'Voice Alerts', 'Driving Goals'] },
  { label: 'Appearance', requiredText: ['Appearance', 'Theme', 'Economics', 'Currency symbol'] },
  { label: 'UBI Coaching', requiredText: ['UBI Coaching', 'UBI-style scores', 'UBI optimal annual km', 'UBI mileage spread km'] },
];

const SEARCH_CASES = [
  { query: 'tracking', expected: ['Tracking mode'] },
  { query: 'privacy', expected: ['Privacy'] },
  { query: 'voice', expected: ['Voice alerts'] },
  { query: 'threshold', expected: ['threshold'] },
  { query: 'backup', expected: ['backup'] },
  { query: 'app lock', expected: ['App lock'] },
  { query: 'osrm', expected: ['OSRM'] },
];

const BASELINE_SETTINGS = {
  onboarding_completed: true,
  settings_defaults_version: 11,
  tracking_mode: 'manual',
  auto_tracking_enabled: false,
  background_tracking_enabled: false,
  tracking_paused: false,
  biometric_lock_enabled: false,
  lock_timeout_minutes: 5,
  calibration_sharing_enabled: false,
  notifications_enabled: true,
  notification_permission_granted: true,
  voice_alerts_enabled: true,
  voice_alert_rate: 1.0,
  voice_alert_volume: 0.9,
  voice_alerts_min_severity: 1,
  voice_earcon_enabled: true,
  voice_quiet_hours_enabled: false,
  voice_quiet_hours_start: '22:00',
  voice_quiet_hours_end: '06:00',
  dark_mode: 'system',
  units: 'metric',
  data_retention_months: 24,
  currencySymbol: '$',
  co2_baseline_kg_per_100km: 12,
  default_ev_kwh_per_100km: 18,
  grid_co2_kg_per_kwh: 0.04,
  tree_co2_kg_per_year: 21,
  advanced_safety_detection_enabled: true,
  lane_change_score_enabled: true,
  speed_warning_enabled: true,
  threshold_speed_over_kmh: 5,
  speed_limit_lookup_enabled: true,
  weather_context_enabled: true,
  external_context_auto_fetch_enabled: true,
  country_code: '',
  configurable_country_defaults: 'global',
  night_detection_mode: 'sunset',
  night_start_time: '22:00',
  night_end_time: '05:00',
  phone_use_detection_enabled: true,
  phone_use_live_alert_enabled: true,
  phone_use_show_on_map: true,
  phone_use_affects_score: true,
  phone_use_sensitivity: 'medium',
  sensor_fusion_enabled: true,
  crash_detection_enabled: true,
  emergency_workflow_enabled: false,
  predictive_route_risk_enabled: true,
  map_matching_enabled: false,
  osrm_map_matching_url: '',
  osrm_verified_endpoint: '',
  osrm_verified_origin: '',
  osrm_verified_domain: '',
  osrm_timeout_ms: 12000,
  weekly_goal_harsh_brakes: 5,
  weekly_goal_speeding_events: 5,
  weekly_goal_min_avg_score: 80,
  weekly_goal_max_night_km: 20,
  weekly_goal_max_night_trips: 3,
  threshold_harsh_brake_ms2: 4.5,
  threshold_rapid_accel_ms2: 3.0,
  threshold_speeding_kmh: 100,
  ubi_optimal_annual_km: 10000,
  ubi_mileage_score_spread_km: 8000,
  notif_quiet_hours_enabled: false,
  notif_quiet_start: '22:00',
  notif_quiet_end: '07:00',
  notif_safety_alerts_enabled: true,
  notif_speeding_alert_enabled: true,
  notif_post_trip_summary_enabled: true,
  notif_min_score_for_post_trip: 0,
  notif_inactive_nudge_enabled: true,
  notif_inactive_nudge_days: 7,
  privacy_zones: [],
};

const EXPECTED_PERSISTED_SETTINGS = {
  tracking_mode: 'auto_detect',
  auto_tracking_enabled: true,
  background_tracking_enabled: false,
  tracking_paused: false,
  biometric_lock_enabled: true,
  lock_timeout_minutes: 15,
  calibration_sharing_enabled: true,
  data_retention_months: 12,
  notifications_enabled: true,
  notif_quiet_hours_enabled: true,
  notif_quiet_start: '21:30',
  notif_quiet_end: '06:30',
  notif_speeding_alert_enabled: false,
  notif_min_score_for_post_trip: 65,
  notif_inactive_nudge_days: 14,
  voice_alerts_enabled: true,
  voice_alert_rate: 1.2,
  voice_alert_volume: 0.6,
  voice_alerts_min_severity: 2,
  voice_earcon_enabled: false,
  voice_quiet_hours_enabled: true,
  voice_quiet_hours_start: '20:15',
  voice_quiet_hours_end: '05:45',
  dark_mode: 'dark',
  units: 'imperial',
  currencySymbol: 'kr',
  co2_baseline_kg_per_100km: 14.2,
  default_ev_kwh_per_100km: 19.5,
  grid_co2_kg_per_kwh: 0.123,
  tree_co2_kg_per_year: 25.5,
  advanced_safety_detection_enabled: false,
  lane_change_score_enabled: false,
  speed_warning_enabled: false,
  threshold_speed_over_kmh: 15,
  speed_limit_lookup_enabled: false,
  weather_context_enabled: false,
  external_context_auto_fetch_enabled: false,
  country_code: 'GB',
  configurable_country_defaults: 'gb',
  night_detection_mode: 'custom',
  night_start_time: '21:00',
  night_end_time: '06:00',
  phone_use_detection_enabled: true,
  phone_use_live_alert_enabled: false,
  phone_use_show_on_map: false,
  phone_use_affects_score: false,
  phone_use_sensitivity: 'high',
  sensor_fusion_enabled: false,
  crash_detection_enabled: false,
  emergency_workflow_enabled: true,
  predictive_route_risk_enabled: false,
  osrm_timeout_ms: 18000,
  weekly_goal_harsh_brakes: 3,
  weekly_goal_speeding_events: 2,
  weekly_goal_min_avg_score: 90,
  weekly_goal_max_night_km: 40,
  weekly_goal_max_night_trips: 5,
  threshold_harsh_brake_ms2: 5.5,
  threshold_rapid_accel_ms2: 3.5,
  threshold_speeding_kmh: 120,
  ubi_optimal_annual_km: 15000,
  ubi_mileage_score_spread_km: 12000,
};

let passed = 0;
let failed = 0;
let skipped = 0;
let launched = false;
let debuggerAttached = false;
let webviewProcessId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function comparable(value) {
  if (typeof value === 'number') return Number(value.toFixed(6));
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value;
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

async function runStep(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`PASS ${name}${detail ? ` -- ${detail}` : ''}`);
    return true;
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} -- ${error.message}`);
    if (error.stack) console.error(error.stack);
    return false;
  }
}

async function skipStep(name, reason) {
  skipped += 1;
  console.warn(`SKIP ${name} -- ${reason}`);
}

async function grantRuntimePermissions() {
  const results = [];
  for (const permission of RUNTIME_PERMISSIONS) {
    const output = await adb(['shell', 'pm', 'grant', APP_PACKAGE, permission], {
      timeoutMs: 10_000,
      allowFailure: true,
    });
    results.push(output ? `${permission}: ${output}` : `${permission}: granted`);
  }
  return results.join(' | ');
}

async function launchApp({ clearLog = false } = {}) {
  if (clearLog) await adb(['logcat', '-c'], { allowFailure: true });
  await adb(['shell', 'am', 'force-stop', APP_PACKAGE], { allowFailure: true });
  await adb(['forward', '--remove', `tcp:${DEBUG_PORT}`], { allowFailure: true });
  launched = false;
  debuggerAttached = false;
  webviewProcessId = null;

  const launchOutput = await adb(['shell', 'monkey', '-p', APP_PACKAGE, '1'], { timeoutMs: 15_000 });
  assert(/Events injected:\s*1/.test(launchOutput), 'monkey did not launch the app');
  await sleep(5_000);
  launched = true;
}

async function ensureAppLaunched() {
  if (!launched) await launchApp({ clearLog: true });
}

async function dumpUiHierarchy() {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dumpOutput = await adb(['shell', 'uiautomator', 'dump', UI_DUMP_PATH], { timeoutMs: 30_000, allowFailure: true });
    for (let readAttempt = 0; readAttempt < 5; readAttempt += 1) {
      await sleep(300);
      const hierarchy = await adb(['exec-out', 'cat', UI_DUMP_PATH], { timeoutMs: 30_000, allowFailure: true });
      last = `${dumpOutput}\n${hierarchy}`.trim();
      if (hierarchy.length > 500) return hierarchy;
    }
  }
  return last;
}

async function attachWebViewDebugger() {
  await ensureAppLaunched();
  const pidOutput = await adb(['shell', 'pidof', APP_PACKAGE], { timeoutMs: 10_000 });
  const nextProcessId = pidOutput.trim().split(/\s+/)[0];
  assert(/^\d+$/.test(nextProcessId ?? ''), 'app process id was not available');
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
  throw new Error('WebView page target was not exposed');
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

async function snapshot() {
  return evaluateInWebView(`(async () => {
    const readJson = (value, fallback = null) => {
      try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
    };
    const textOf = (element) => (
      element.innerText ||
      element.textContent ||
      element.getAttribute('aria-label') ||
      element.title ||
      ''
    ).trim();
    const plugins = globalThis.Capacitor?.Plugins || {};
    let nativeSettings = null;
    if (plugins.DriveSenseActivityRecognition?.getSettings) {
      const native = await Promise.race([
        plugins.DriveSenseActivityRecognition.getSettings().catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), ${NATIVE_SETTINGS_READ_TIMEOUT_MS})),
      ]);
      nativeSettings = readJson(native?.settingsJson);
    }
    const localSettings =
      readJson(localStorage.getItem('road_sage_settings')) ||
      readJson(localStorage.getItem('drivesense_settings')) ||
      {};
    return {
      title: document.title,
      url: location.href,
      pathname: location.pathname,
      readyState: document.readyState,
      rootExists: Boolean(document.querySelector('#root')),
      rootChildren: document.querySelector('#root')?.children.length ?? 0,
      bodyText: document.body?.innerText ?? '',
      navLabels: [...document.querySelectorAll('nav button')].map(textOf).filter(Boolean),
      buttonLabels: [...document.querySelectorAll('button')].map(textOf).filter(Boolean),
      fields: [...document.querySelectorAll('input, select, textarea')].map((field) => ({
        tag: field.tagName.toLowerCase(),
        type: field.type || '',
        value: field.type === 'password' ? '<password>' : field.value,
        placeholder: field.getAttribute('placeholder') || '',
        ariaLabel: field.getAttribute('aria-label') || '',
        disabled: Boolean(field.disabled || field.getAttribute('aria-disabled') === 'true'),
      })),
      settings: nativeSettings || localSettings,
      nativeSettings,
      localSettings,
      settingsSource: nativeSettings ? 'native' : 'localStorage',
      plugins: Object.keys(plugins),
      hasNativeSettingsBridge: Boolean(plugins.DriveSenseActivityRecognition?.saveSettings),
      biometricGateAvailable: Boolean(plugins.BiometricGate),
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

async function waitForSettingsHomeControls({ timeoutMs = 30_000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await snapshot();
    const hasSearch = last.fields?.some((field) => /search settings/i.test(field.placeholder || ''));
    const hasGroups = SETTINGS_GROUPS.every((group) => (
      last.navLabels?.some((label) => label.includes(group.label))
    ));
    if (last.readyState === 'complete' && hasSearch && hasGroups) return last;
    await sleep(500);
  }
  throw new Error(
    `Settings home controls did not mount. ` +
    `Nav: ${(last?.navLabels || []).join(' | ')}. ` +
    `Fields: ${(last?.fields || []).map((field) => field.placeholder || field.ariaLabel || field.type).join(' | ')}. ` +
    `Text: ${(last?.bodyText || '').slice(0, 500)}`
  );
}

async function navigateToSettings() {
  await evaluateInWebView(`(() => {
    history.pushState({}, '', ${JSON.stringify(SETTINGS_ROUTE)});
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    return location.pathname;
  })()`);
  await waitForText(['Settings', 'Tracking'], { timeoutMs: 45_000 });
  await waitForSettingsHomeControls({ timeoutMs: 45_000 });
}

async function saveSettingsDirect(settings) {
  await evaluateInWebView(`(async () => {
    const settings = ${JSON.stringify(settings)};
    localStorage.setItem('road_sage_settings', JSON.stringify(settings));
    localStorage.setItem('drivesense_settings', JSON.stringify(settings));
    localStorage.setItem('road_sage_onboarding_completed', JSON.stringify(true));
    localStorage.setItem('road_sage_first_launch_permission_prompted', JSON.stringify(true));
    localStorage.removeItem('road_sage_active_trip');
    localStorage.removeItem('drivesense_active_trip');
    const nativeSave = globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition?.saveSettings?.({
      settingsJson: JSON.stringify(settings),
    });
    if (nativeSave?.then) {
      const result = await Promise.race([
        nativeSave.then(() => ({ saved: true })).catch((error) => ({ error: error?.message || String(error) })),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 20_000)),
      ]);
      if (!result?.saved) throw new Error(result?.error || 'native saveSettings timed out');
    }
    return true;
  })()`);
}

async function normalizeMainAppState() {
  await saveSettingsDirect({ ...BASELINE_SETTINGS });
  await waitForSettings(BASELINE_SETTINGS, { timeoutMs: 45_000, requireNative: true });
  await navigateToSettings();
  await evaluateInWebView(`(() => {
    const plugins = globalThis.Capacitor?.Plugins || {};
    if (plugins.BiometricGate) {
      plugins.BiometricGate.isAvailable = async () => ({ available: true });
      plugins.BiometricGate.authenticate = async () => ({ status: 'success' });
    }
    window.confirm = () => false;
    window.prompt = () => null;
    return true;
  })()`);
}

async function clickButton(label, { exact = false, allowMissing = false } = {}) {
  const result = await evaluateInWebView(`(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const exact = ${JSON.stringify(exact)};
    const textOf = (element) => (
      element.innerText ||
      element.textContent ||
      element.getAttribute('aria-label') ||
      element.title ||
      ''
    ).trim();
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((candidate) => {
      const text = textOf(candidate).toLowerCase();
      return exact ? text === wanted : (text === wanted || text.includes(wanted));
    });
    if (!button) return { clicked: false, buttons: buttons.map(textOf).filter(Boolean) };
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      return { clicked: false, disabled: true, text: textOf(button) };
    }
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    button.click();
    return { clicked: true, text: textOf(button) };
  })()`);
  if (!result.clicked && allowMissing) return result;
  assert(result.clicked, `button not found or disabled: ${label}. Buttons: ${(result.buttons || []).join(' | ')}`);
  await sleep(900);
  return result.text;
}

async function clickSettingsGroup(label) {
  await clickButton(label);
  await sleep(1200);
}

async function setSearch(query) {
  const started = Date.now();
  let result = null;
  while (Date.now() - started < 12_000) {
    result = await evaluateInWebView(`(() => {
      const input = [...document.querySelectorAll('input')].find((candidate) => /search settings/i.test(candidate.placeholder || ''));
      if (!input) return { changed: false, reason: 'search input not found' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter.call(input, ${JSON.stringify(query)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { changed: true };
    })()`);
    if (result.changed) break;
    await sleep(500);
  }
  assert(result.changed, result.reason || 'search input not changed');
  await sleep(800);
  return snapshot();
}

async function clearSearch() {
  await setSearch('');
}

async function rowAction(label, actionBody) {
  const result = await evaluateInWebView(`(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const textOf = (element) => (
      element.innerText ||
      element.textContent ||
      element.getAttribute('aria-label') ||
      element.title ||
      ''
    ).trim();
    const rows = [...document.querySelectorAll('label, div')].filter((node) => {
      const text = textOf(node).toLowerCase();
      return text.includes(wanted);
    });
    rows.sort((a, b) => textOf(a).length - textOf(b).length);
    for (const row of rows) {
      const result = ((row) => { ${actionBody} })(row);
      if (result?.changed || result?.clicked) return { ...result, rowText: textOf(row).slice(0, 200) };
    }
    return { changed: false, clicked: false, reason: 'matching control not found', candidates: rows.map(textOf).slice(0, 8) };
  })()`);
  assert(result.changed || result.clicked, `${label} control not changed: ${result.reason || 'unknown'} ${(result.candidates || []).join(' | ')}`);
  await sleep(900);
  return result;
}

async function rowActionInSection(sectionId, label, actionBody) {
  const result = await evaluateInWebView(`(() => {
    const section = document.getElementById(${JSON.stringify(sectionId)});
    if (!section) return { changed: false, clicked: false, reason: 'section not found' };
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const textOf = (element) => (
      element.innerText ||
      element.textContent ||
      element.getAttribute('aria-label') ||
      element.title ||
      ''
    ).trim();
    const scopeNodes = [];
    let current = section.nextElementSibling;
    while (current && !(current.id && current.id.startsWith('settings-'))) {
      scopeNodes.push(current);
      current = current.nextElementSibling;
    }
    const rowSet = new Set();
    for (const node of scopeNodes) {
      if (textOf(node).toLowerCase().includes(wanted)) rowSet.add(node);
      for (const child of node.querySelectorAll('label, div')) {
        if (textOf(child).toLowerCase().includes(wanted)) rowSet.add(child);
      }
    }
    const rows = [...rowSet];
    rows.sort((a, b) => textOf(a).length - textOf(b).length);
    for (const row of rows) {
      const result = ((row) => { ${actionBody} })(row);
      if (result?.changed || result?.clicked) return { ...result, rowText: textOf(row).slice(0, 200) };
    }
    return { changed: false, clicked: false, reason: 'matching section control not found', candidates: rows.map(textOf).slice(0, 8) };
  })()`);
  assert(result.changed || result.clicked, `${sectionId}/${label} control not changed: ${result.reason || 'unknown'} ${(result.candidates || []).join(' | ')}`);
  await sleep(900);
  return result;
}

async function toggleRowTo(label, desired) {
  const result = await rowAction(label, `
    const control = row.querySelector('button, [role="switch"], [role="checkbox"], input[type="checkbox"]');
    if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') return null;
    const current =
      control.matches('input[type="checkbox"]') ? control.checked :
      control.getAttribute('aria-checked') === 'true' ||
      control.getAttribute('aria-pressed') === 'true' ||
      control.getAttribute('data-state') === 'checked' ||
      control.className.includes('bg-primary');
    const desired = ${JSON.stringify(desired)};
    if (current === desired) return { changed: true, already: true, current };
    control.scrollIntoView({ block: 'center', inline: 'nearest' });
    const PointerCtor = window.PointerEvent || MouseEvent;
    control.dispatchEvent(new PointerCtor('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    control.dispatchEvent(new PointerCtor('pointerup', { bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    control.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { changed: true, clicked: true, before: current, desired };
  `);
  return result;
}

async function toggleRowToInSection(sectionId, label, desired) {
  return rowActionInSection(sectionId, label, `
    const control = row.querySelector('button, [role="switch"], [role="checkbox"], input[type="checkbox"]');
    if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') return null;
    const current =
      control.matches('input[type="checkbox"]') ? control.checked :
      control.getAttribute('aria-checked') === 'true' ||
      control.getAttribute('aria-pressed') === 'true' ||
      control.getAttribute('data-state') === 'checked' ||
      control.className.includes('bg-primary');
    const desired = ${JSON.stringify(desired)};
    if (current === desired) return { changed: true, already: true, current };
    control.scrollIntoView({ block: 'center', inline: 'nearest' });
    const PointerCtor = window.PointerEvent || MouseEvent;
    control.dispatchEvent(new PointerCtor('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    control.dispatchEvent(new PointerCtor('pointerup', { bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    control.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { changed: true, clicked: true, before: current, desired };
  `);
}

async function setCheckboxByLabel(label, desired) {
  const result = await evaluateInWebView(`(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const desired = ${JSON.stringify(desired)};
    const textOf = (element) => (
      element.innerText ||
      element.textContent ||
      element.getAttribute('aria-label') ||
      element.title ||
      ''
    ).trim();
    const rows = [...document.querySelectorAll('label, div')]
      .filter((node) => textOf(node).toLowerCase().includes(wanted) && node.querySelector('[role="checkbox"], input[type="checkbox"]'));
    rows.sort((a, b) => textOf(a).length - textOf(b).length);
    const row = rows[0];
    if (!row) return { changed: false, reason: 'checkbox row not found' };
    const control = row.querySelector('[role="checkbox"], input[type="checkbox"]');
    if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') {
      return { changed: false, reason: 'checkbox disabled' };
    }
    const current =
      control.matches('input[type="checkbox"]') ? control.checked :
      control.getAttribute('aria-checked') === 'true' ||
      control.getAttribute('data-state') === 'checked';
    if (current === desired) return { changed: true, already: true, current };
    control.scrollIntoView({ block: 'center', inline: 'nearest' });
    const PointerCtor = window.PointerEvent || MouseEvent;
    control.dispatchEvent(new PointerCtor('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    control.dispatchEvent(new PointerCtor('pointerup', { bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    control.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { changed: true, clicked: true, before: current, desired, rowText: textOf(row).slice(0, 200) };
  })()`);
  assert(result.changed, `${label} checkbox not changed: ${result.reason || 'unknown'}`);
  await sleep(900);
  return result;
}

async function setSelectNearLabel(label, value) {
  const result = await rowAction(label, `
    const select = row.querySelector('select');
    if (!select || select.disabled) return null;
    const desired = ${JSON.stringify(String(value))};
    const option = [...select.options].find((candidate) => (
      candidate.value === desired ||
      candidate.textContent.trim() === desired ||
      candidate.textContent.trim().toLowerCase().includes(desired.toLowerCase())
    ));
    if (!option) return { changed: false, reason: 'option not found', options: [...select.options].map((candidate) => candidate.value + ':' + candidate.textContent.trim()) };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { changed: true, value: option.value, text: option.textContent.trim() };
  `);
  return result.value;
}

async function setSelectNearLabelInSection(sectionId, label, value) {
  const result = await rowActionInSection(sectionId, label, `
    const select = row.querySelector('select');
    if (!select || select.disabled) return null;
    const desired = ${JSON.stringify(String(value))};
    const option = [...select.options].find((candidate) => (
      candidate.value === desired ||
      candidate.textContent.trim() === desired ||
      candidate.textContent.trim().toLowerCase().includes(desired.toLowerCase())
    ));
    if (!option) return { changed: false, reason: 'option not found', options: [...select.options].map((candidate) => candidate.value + ':' + candidate.textContent.trim()) };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { changed: true, value: option.value, text: option.textContent.trim() };
  `);
  return result.value;
}

async function setFieldNearLabel(label, value, { selector = 'input, textarea', disabledOk = false } = {}) {
  const result = await rowAction(label, `
    const field = row.querySelector(${JSON.stringify(selector)});
    if (!field || (!${JSON.stringify(disabledOk)} && field.disabled)) return null;
    const desired = ${JSON.stringify(String(value))};
    const proto = field.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    field.scrollIntoView({ block: 'center', inline: 'nearest' });
    setter.call(field, desired);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();
    return { changed: true, tag: field.tagName, type: field.type, value: field.value };
  `);
  return result;
}

async function setFieldNearLabelInSection(sectionId, label, value, { selector = 'input, textarea', disabledOk = false } = {}) {
  return rowActionInSection(sectionId, label, `
    const field = row.querySelector(${JSON.stringify(selector)});
    if (!field || (!${JSON.stringify(disabledOk)} && field.disabled)) return null;
    const desired = ${JSON.stringify(String(value))};
    const proto = field.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    field.scrollIntoView({ block: 'center', inline: 'nearest' });
    setter.call(field, desired);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();
    return { changed: true, tag: field.tagName, type: field.type, value: field.value };
  `);
}

async function setRangeNearLabel(label, value) {
  return setFieldNearLabel(label, value, { selector: 'input[type="range"]' });
}

async function setRangeNearLabelInSection(sectionId, label, value) {
  return setFieldNearLabelInSection(sectionId, label, value, { selector: 'input[type="range"]' });
}

async function waitForSettingValue(key, expected, { timeoutMs = 10_000 } = {}) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    const snap = await snapshot();
    lastValue = snap.settings?.[key];
    if (Object.is(comparable(lastValue), comparable(expected))) return snap;
    await sleep(350);
  }
  throw new Error(`setting ${key} expected ${JSON.stringify(expected)} but was ${JSON.stringify(lastValue)}`);
}

async function waitForSettings(expected, { timeoutMs = 15_000, requireNative = false } = {}) {
  const started = Date.now();
  let last = null;
  const mismatches = () => Object.entries(expected).filter(([key, expectedValue]) => (
    !Object.is(comparable(last?.settings?.[key]), comparable(expectedValue))
  ));

  while (Date.now() - started < timeoutMs) {
    last = await snapshot();
    const remaining = mismatches();
    if (remaining.length === 0 && (!requireNative || last.settingsSource === 'native')) return last;
    await sleep(500);
  }

  const remaining = mismatches()
    .map(([key, expectedValue]) => `${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(last?.settings?.[key])}`)
    .join('; ');
  const nativeSuffix = requireNative && last?.settingsSource !== 'native'
    ? `; native settings were not available before timeout (last source=${last?.settingsSource || 'unknown'})`
    : '';
  throw new Error(`settings did not match: ${remaining}${nativeSuffix}`);
}

async function assertSettingsPersistedAcrossRestart(expected) {
  const beforeRestart = await waitForSettings(expected, { timeoutMs: 30_000, requireNative: true });
  const beforeSerialized = JSON.stringify(beforeRestart.nativeSettings || beforeRestart.settings || {});

  await launchApp({ clearLog: false });
  await attachWebViewDebugger();

  const after = await waitForSettings(expected, { timeoutMs: 90_000, requireNative: true });
  const afterSerialized = JSON.stringify(after.nativeSettings || after.settings || {});
  assert(beforeSerialized.includes('"biometric_lock_enabled":true'), 'native settings did not contain App lock before restart');
  assert(afterSerialized.includes('"biometric_lock_enabled":true'), 'native settings did not contain App lock after restart');
  return `verified ${Object.keys(expected).length} settings after force-stop/relaunch from ${after.settingsSource}`;
}

async function mutateSettingsThroughUi() {
  await clickSettingsGroup('Tracking');
  await clickButton('Auto-Detect', { exact: false });
  await waitForSettingValue('tracking_mode', 'auto_detect');
  await toggleRowTo('Pause All Tracking', false);

  await clickSettingsGroup('Privacy & Data');
  await setCheckboxByLabel('Share anonymized calibration labels', true);
  await waitForSettingValue('calibration_sharing_enabled', true);
  await toggleRowTo('App lock', true);
  await waitForSettingValue('biometric_lock_enabled', true);
  await setSelectNearLabel('Auto-lock after', '15');
  await setSelectNearLabel('Data Retention', '12');

  await clickSettingsGroup('Notifications');
  await toggleRowTo('Enable all notifications', true);
  await toggleRowToInSection('settings-notifications', 'Quiet hours', true);
  await setFieldNearLabelInSection('settings-notifications', 'Start', '21:30', { selector: 'input[type="time"]' });
  await setFieldNearLabelInSection('settings-notifications', 'End', '06:30', { selector: 'input[type="time"]' });
  await toggleRowTo('Speeding alert', false);
  await setRangeNearLabelInSection('settings-notifications', 'Only notify if score is at least', 65);
  await setSelectNearLabelInSection('settings-notifications', 'Nudge after', '14');

  await toggleRowTo('Voice alerts', true);
  await setSelectNearLabel('Alert speech rate', '1.2');
  await setSelectNearLabel('Alert volume', '0.6');
  await setSelectNearLabel('Minimum alert level', '2');
  await toggleRowTo('Alert tone', false);
  await toggleRowToInSection('settings-voice-alerts', 'Quiet hours', true);
  await setFieldNearLabelInSection('settings-voice-alerts', 'Start', '20:15', { selector: 'input[type="time"]' });
  await setFieldNearLabelInSection('settings-voice-alerts', 'End', '05:45', { selector: 'input[type="time"]' });

  await setRangeNearLabel('Max harsh brakes', 3);
  await setRangeNearLabel('Max speeding events', 2);
  await setRangeNearLabel('Minimum average score', 90);
  await setRangeNearLabel('Max night km', 40);
  await setRangeNearLabel('Max night trips', 5);

  await clickSettingsGroup('Appearance');
  await clickButton('Dark', { exact: false });
  await clickButton('Imperial', { exact: false });
  await setSelectNearLabel('Currency symbol', 'kr');
  await setFieldNearLabel('Average vehicle CO2 baseline', 14.2, { selector: 'input[type="number"]' });
  await setFieldNearLabel('Default EV efficiency', 19.5, { selector: 'input[type="number"]' });
  await setFieldNearLabel('Grid CO2 intensity', 0.123, { selector: 'input[type="number"]' });
  await setFieldNearLabel('Tree-year equivalent', 25.5, { selector: 'input[type="number"]' });

  await clickSettingsGroup('UBI Coaching');
  await setRangeNearLabel('UBI optimal annual km', 15000);
  await setRangeNearLabel('UBI mileage spread km', 12000);

  await clickSettingsGroup('Scoring');
  await clickButton('Locked', { allowMissing: true });
  await setRangeNearLabel('Harsh Braking', 5.5);
  await setRangeNearLabel('Rapid Acceleration', 3.5);
  await setRangeNearLabel('Speeding (fallback)', 120);
  await toggleRowTo('Lane-change diagnostic', false);
  await toggleRowTo('Advanced Safety Detection', false);
  await toggleRowTo('Automatic road-data fetching', false);
  await toggleRowTo('Get posted speed limits', false);
  await setSelectNearLabel('Fallback limit country', 'gb');
  await toggleRowTo('Get trip weather', false);
  await setRangeNearLabel('Warn when over limit by', 15);
  await toggleRowTo('Live Speed Warning', false);
  await clickButton('Custom', { exact: false });
  await setFieldNearLabelInSection('settings-night-window', 'Start', '21:00', { selector: 'input[type="time"]' });
  await setFieldNearLabelInSection('settings-night-window', 'End', '06:00', { selector: 'input[type="time"]' });
  await toggleRowTo('Emergency workflow', true);
  await toggleRowTo('Crash / incident detection', false);
  await toggleRowTo('Sensor fusion model', false);
  await setRangeNearLabel('Network timeout', 18);
  await toggleRowTo('Historical context estimate', false);
  await toggleRowTo('Detect phone use while driving', true);
  await toggleRowTo('Phone use live alert', false);
  await clickButton('High', { exact: false });
  await waitForSettingValue('phone_use_sensitivity', 'high');
  await toggleRowTo('Show on trip map', false);
  await toggleRowTo('Include in trip score', false);
}

async function main() {
  let deviceId = null;
  let packageInstalled = false;

  await runStep('ADB connected phone is available', async () => {
    deviceId = await connectedDeviceId();
    assert(deviceId, 'no adb device is connected');
    return deviceId;
  });

  if (!deviceId) {
    await skipStep('settings persistence audit', 'no connected Android device');
    process.exitCode = 1;
    return;
  }

  try {
    await runStep('APK package is installed on phone', async () => {
      const output = await adb(['shell', 'pm', 'path', APP_PACKAGE], { timeoutMs: 10_000 });
      assert(output.includes(APP_PACKAGE), `${APP_PACKAGE} is not installed`);
      packageInstalled = true;
      return output.split(/\r?\n/)[0];
    });

    if (!packageInstalled) {
      await skipStep('settings persistence audit', `${APP_PACKAGE} is not installed; install the debug APK first`);
      process.exitCode = 1;
      return;
    }

    await runStep('runtime permissions needed by settings controls are granted', grantRuntimePermissions);

    await runStep('UIAutomator sees Road Sage WebView shell', async () => {
      await launchApp({ clearLog: true });
      const hierarchy = await dumpUiHierarchy();
      assert(hierarchy.length > 500, 'UI hierarchy was empty');
      assert(new RegExp(`package="${APP_PACKAGE}"`).test(hierarchy), 'Road Sage package was not in hierarchy');
      assert(/class="android\.webkit\.WebView"/.test(hierarchy), 'Android WebView was not visible to UIAutomator');
    });

    const settingsReady = await runStep('WebView debugger attaches and clean settings route renders', async () => {
      await attachWebViewDebugger();
      await normalizeMainAppState();
      const snap = await waitForText(['Settings', 'Tracking Mode']);
      assert(snap.title === 'Road Sage', `unexpected document title ${snap.title}`);
      assert(snap.plugins.includes('DriveSenseActivityRecognition'), 'DriveSenseActivityRecognition native bridge missing');
      assert(snap.hasNativeSettingsBridge, 'native settings bridge missing');
      return `route=${snap.pathname}; source=${snap.settingsSource}`;
    });
    if (!settingsReady) return;

    await runStep('settings nav exposes every expected group', async () => {
      const snap = await waitForSettingsHomeControls();
      for (const group of SETTINGS_GROUPS) {
        assert(snap.navLabels.some((label) => label.includes(group.label)), `missing nav group ${group.label}`);
      }
      return snap.navLabels.join(' | ');
    });

    for (const group of SETTINGS_GROUPS) {
      await runStep(`settings group renders: ${group.label}`, async () => {
        await clearSearch();
        await clickSettingsGroup(group.label);
        const snap = await waitForText(group.requiredText, { timeoutMs: 30_000 });
        assert(snap.bodyText.length > 500, `${group.label} rendered too little content`);
      });
    }

    for (const searchCase of SEARCH_CASES) {
      await runStep(`settings search returns useful result: ${searchCase.query}`, async () => {
        const snap = await setSearch(searchCase.query);
        assert(!/No matching settings found/i.test(snap.bodyText), `search returned no results for ${searchCase.query}`);
        for (const expected of searchCase.expected) {
          assert(new RegExp(escapeRegExp(expected), 'i').test(snap.bodyText), `missing search text ${expected}`);
        }
      });
    }
    await clearSearch();

    const mutatedSettings = await runStep('all major settings controls save through the real UI', async () => {
      await mutateSettingsThroughUi();
      const snap = await waitForSettings(EXPECTED_PERSISTED_SETTINGS, { timeoutMs: 30_000 });
      return `changed ${Object.keys(EXPECTED_PERSISTED_SETTINGS).length} keys via UI; source=${snap.settingsSource}`;
    });

    if (mutatedSettings) {
      await runStep('changed settings survive app force-stop and relaunch', async () => {
        return assertSettingsPersistedAcrossRestart(EXPECTED_PERSISTED_SETTINGS);
      });
    } else {
      await skipStep('changed settings survive app force-stop and relaunch', 'settings mutation failed');
    }

    await runStep('launch log has no fatal crash or JavaScript exception', async () => {
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
      assert(!/FATAL EXCEPTION|AndroidRuntime.*Exception/i.test(appCrashLog), 'fatal Android exception found in logcat');
      assert(!/Uncaught \(in promise\)|ReferenceError|TypeError|SyntaxError/i.test(log), 'JavaScript exception found in logcat');
    });
  } finally {
    await adb(['forward', '--remove', `tcp:${DEBUG_PORT}`], { allowFailure: true });
  }

  console.log('');
  console.log(`RESULT settings persistence audit: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed > 0 ? 1 : 0;
}

await main();
