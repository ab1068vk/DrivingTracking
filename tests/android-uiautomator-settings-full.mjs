// Road Sage Android UIAutomator + WebView settings sweep.
// Run: node tests/android-uiautomator-settings-full.mjs
//
// UIAutomator confirms the app shell is running on the phone. CDP attaches to
// the Capacitor WebView so this can verify real React settings UI and saved
// settings state instead of only confirming that the APK launches.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APP_PACKAGE = 'com.roadsage.app';
const DEBUG_PORT = '9223';
const UI_DUMP_PATH = '/data/local/tmp/roadsage-settings-window.xml';
const SETTINGS_GROUPS = [
  {
    label: 'Tracking',
    requiredText: ['Tracking Mode', 'Manual Only', 'Auto-Detect', 'Background Auto'],
  },
  {
    label: 'Scoring',
    requiredText: ['Detection Features', 'Advanced Models', 'Phone Use Detection', 'Speed Warning'],
  },
  {
    label: 'Privacy & Data',
    requiredText: ['Privacy & Data', 'App lock', 'Stealth Trip Mode', 'Data Retention', 'Export Full Backup'],
  },
  {
    label: 'Privacy zones',
    requiredText: ['Parked Privacy Zones'],
  },
  {
    label: 'Notifications',
    requiredText: ['Notifications', 'Voice Alerts', 'Driving Goals'],
  },
  {
    label: 'Appearance',
    requiredText: ['Appearance', 'Theme', 'Economics', 'Currency symbol'],
  },
  {
    label: 'UBI Coaching',
    requiredText: ['UBI Coaching', 'UBI-style scores', 'UBI optimal annual km', 'UBI mileage spread km'],
  },
];
const SEARCH_CASES = [
  { query: 'tracking', expected: ['Tracking mode'] },
  { query: 'privacy', expected: ['Privacy'] },
  { query: 'voice', expected: ['Voice alerts'] },
  { query: 'threshold', expected: ['threshold'] },
  { query: 'backup', expected: ['backup'] },
];
const BASELINE_SETTINGS = {
  onboarding_completed: true,
  tracking_mode: 'manual',
  auto_tracking_enabled: false,
  background_tracking_enabled: false,
  tracking_paused: false,
  biometric_lock_enabled: false,
  voice_alerts_enabled: true,
  speed_warning_enabled: true,
  notifications_enabled: true,
  dark_mode: 'system',
  units: 'metric',
  data_retention_months: 24,
  currencySymbol: '$',
  ubi_optimal_annual_km: 10000,
  ubi_mileage_score_spread_km: 8000,
  external_context_auto_fetch_enabled: false,
  map_matching_enabled: false,
  osrm_map_matching_url: '',
  osrm_verified_endpoint: '',
};
const RUNTIME_PERMISSIONS = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACTIVITY_RECOGNITION',
  'android.permission.POST_NOTIFICATIONS',
];

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

async function adb(args, { timeoutMs = 30_000, allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('adb', args, {
      encoding: 'utf8',
      maxBuffer: 12 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    if (allowFailure) return `${error.stdout || ''}${error.stderr || ''}`.trim();
    throw error;
  }
}

async function connectedDeviceId() {
  const output = await adb(['devices']);
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
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} -- ${error.message}`);
  }
}

async function skipStep(name, reason) {
  skipped += 1;
  console.warn(`SKIP ${name} -- ${reason}`);
}

async function launchApp() {
  await adb(['logcat', '-c'], { allowFailure: true });
  await adb(['shell', 'am', 'force-stop', APP_PACKAGE], { allowFailure: true });
  const launchOutput = await adb(['shell', 'monkey', '-p', APP_PACKAGE, '1'], { timeoutMs: 15_000 });
  assert(/Events injected:\s*1/.test(launchOutput), 'monkey did not launch the app');
  await sleep(5000);
  launched = true;
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

async function ensureAppLaunched() {
  if (!launched) await launchApp();
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

function cdpCall(socket, idRef, method, params = {}, { timeoutMs = 10_000 } = {}) {
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
      if (message.error) {
        reject(new Error(JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
    }

    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function firstWebViewPage() {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
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
    const readJson = (value) => {
      try { return value ? JSON.parse(value) : null; } catch { return null; }
    };
    const nativePlugin = globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition;
    let nativeSettings = null;
    if (nativePlugin?.getSettings) {
      const native = await Promise.race([
        nativePlugin.getSettings().catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
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
      navLabels: [...document.querySelectorAll('nav button')]
        .map((button) => button.innerText.trim())
        .filter(Boolean),
      buttonLabels: [...document.querySelectorAll('button')]
        .map((button) => button.innerText.trim() || button.getAttribute('aria-label') || '')
        .filter(Boolean),
      selectValues: [...document.querySelectorAll('select')].map((select) => ({
        value: select.value,
        options: [...select.options].map((option) => ({ value: option.value, text: option.textContent.trim() })),
      })),
      inputValues: [...document.querySelectorAll('input')].map((input) => ({
        type: input.type,
        value: input.value,
        placeholder: input.placeholder,
      })),
      settings: nativeSettings || localSettings,
      settingsSource: nativeSettings ? 'native' : 'localStorage',
      plugins: Object.keys(globalThis.Capacitor?.Plugins || {}),
    };
  })()`);
}

async function waitForText(requiredText, { timeoutMs = 20_000 } = {}) {
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
  throw new Error(`Timed out waiting for text: ${requiredText.join(', ')}. Last text: ${(last?.bodyText || '').slice(0, 450)}`);
}

async function normalizeMainAppState() {
  const baseline = JSON.stringify(BASELINE_SETTINGS);
  await evaluateInWebView(`(async () => {
    const patch = ${baseline};
    let current = {};
    try {
      current = JSON.parse(localStorage.getItem('road_sage_settings') || localStorage.getItem('drivesense_settings') || '{}');
    } catch {}
    const settings = { ...current, ...patch };
    localStorage.setItem('road_sage_settings', JSON.stringify(settings));
    localStorage.setItem('road_sage_first_launch_permission_prompted', JSON.stringify(true));
    localStorage.removeItem('road_sage_active_trip');
    localStorage.removeItem('drivesense_active_trip');
    const nativeSave = globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition?.saveSettings?.({
      settingsJson: JSON.stringify(settings),
    });
    if (nativeSave?.then) {
      await Promise.race([
        nativeSave.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    return true;
  })()`);

  await evaluateInWebView(`(() => {
    history.pushState({}, '', '/settings');
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    return location.pathname;
  })()`);
  await waitForText(['Settings', 'Tracking'], { timeoutMs: 30_000 });
}

async function clickButton(label) {
  const result = await evaluateInWebView(`(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const button = [...document.querySelectorAll('button')].find((candidate) => {
      const text = (candidate.innerText || candidate.getAttribute('aria-label') || '').trim().toLowerCase();
      return text === wanted || text.includes(wanted);
    });
    if (!button) return { clicked: false, buttons: [...document.querySelectorAll('button')].map((b) => b.innerText.trim() || b.getAttribute('aria-label') || '') };
    button.click();
    return { clicked: true, text: button.innerText.trim() || button.getAttribute('aria-label') || '' };
  })()`);
  assert(result.clicked, `button not found: ${label}. Buttons: ${(result.buttons || []).join(' | ')}`);
  await sleep(800);
  return result.text;
}

async function setSearch(query) {
  const result = await evaluateInWebView(`(() => {
    const input = [...document.querySelectorAll('input')].find((candidate) => /search settings/i.test(candidate.placeholder || ''));
    if (!input) return { changed: false, reason: 'search input not found' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { changed: true };
  })()`);
  assert(result.changed, result.reason || 'search input not changed');
  await sleep(700);
  return snapshot();
}

async function clearSearch() {
  await evaluateInWebView(`(() => {
    const input = [...document.querySelectorAll('input')].find((candidate) => /search settings/i.test(candidate.placeholder || ''));
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
}

async function waitForSettingValue(key, expected, { timeoutMs = 5000 } = {}) {
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

async function toggleRowByLabel(label) {
  const result = await evaluateInWebView(`(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const rows = [...document.querySelectorAll('div')].filter((node) => {
      const text = (node.innerText || '').trim().toLowerCase();
      return text.includes(wanted) && node.querySelector('button');
    });
    rows.sort((a, b) => a.innerText.length - b.innerText.length);
    for (const row of rows) {
      const buttons = [...row.querySelectorAll('button')];
      if (buttons.length > 0) {
        const button = buttons[buttons.length - 1];
        button.click();
        return { clicked: true, rowText: row.innerText.trim(), buttonText: button.innerText.trim() || button.getAttribute('aria-label') || '' };
      }
    }
    return { clicked: false, candidates: rows.map((row) => row.innerText.trim()).slice(0, 8) };
  })()`);
  assert(result.clicked, `toggle row not found: ${label}`);
  await sleep(800);
  return result;
}

async function setSelectNearLabel(label, value) {
  const result = await evaluateInWebView(`(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const desired = ${JSON.stringify(String(value))};
    const rows = [...document.querySelectorAll('div')].filter((node) => {
      const text = (node.innerText || '').trim().toLowerCase();
      return text.includes(wanted) && node.querySelector('select');
    });
    rows.sort((a, b) => a.innerText.length - b.innerText.length);
    const row = rows[0];
    if (!row) return { changed: false, reason: 'row not found' };
    const select = row.querySelector('select');
    const option = [...select.options].find((candidate) => candidate.value === desired || candidate.textContent.trim() === desired);
    if (!option) return { changed: false, reason: 'option not found', options: [...select.options].map((candidate) => ({ value: candidate.value, text: candidate.textContent.trim() })) };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { changed: true, value: option.value, text: option.textContent.trim() };
  })()`);
  assert(result.changed, `${label} select not changed: ${result.reason || 'unknown'} ${(result.options || []).map((option) => `${option.value}:${option.text}`).join(', ')}`);
  await sleep(800);
  return result.value;
}

async function setInputNearLabel(label, value) {
  const result = await evaluateInWebView(`(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const rows = [...document.querySelectorAll('div')].filter((node) => {
      const text = (node.innerText || '').trim().toLowerCase();
      return text.includes(wanted) && node.querySelector('input');
    });
    rows.sort((a, b) => a.innerText.length - b.innerText.length);
    const row = rows[0];
    if (!row) return { changed: false, reason: 'row not found' };
    const input = row.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    return { changed: true, type: input.type, value: input.value };
  })()`);
  assert(result.changed, `${label} input not changed: ${result.reason || 'unknown'}`);
  await sleep(900);
  return result;
}

async function main() {
  let deviceId = null;

  await runStep('ADB connected phone is available', async () => {
    deviceId = await connectedDeviceId();
    assert(deviceId, 'no adb device is connected');
    return deviceId;
  });

  if (!deviceId) {
    await skipStep('phone settings sweep', 'no connected Android device');
    process.exitCode = 1;
    return;
  }

  try {
    await runStep('APK package is installed on phone', async () => {
      const output = await adb(['shell', 'pm', 'path', APP_PACKAGE], { timeoutMs: 10_000 });
      assert(output.includes(APP_PACKAGE), `${APP_PACKAGE} is not installed`);
      return output.split(/\r?\n/)[0];
    });

    await runStep('runtime permissions needed by settings controls are granted', async () => {
      return grantRuntimePermissions();
    });

    await runStep('UIAutomator sees Road Sage WebView shell', async () => {
      await ensureAppLaunched();
      const hierarchy = await dumpUiHierarchy();
      assert(hierarchy.length > 500, 'UI hierarchy was empty');
      assert(new RegExp(`package="${APP_PACKAGE}"`).test(hierarchy), 'Road Sage package was not in hierarchy');
      assert(/class="android\.webkit\.WebView"/.test(hierarchy), 'Android WebView was not visible to UIAutomator');
    });

    await runStep('WebView debugger attaches and settings route renders', async () => {
      await attachWebViewDebugger();
      await normalizeMainAppState();
      const snap = await waitForText(['Settings', 'Tracking Mode']);
      assert(snap.title === 'Road Sage', `unexpected document title ${snap.title}`);
      assert(snap.plugins.includes('DriveSenseActivityRecognition'), 'DriveSenseActivityRecognition native bridge missing');
      return `route=${snap.pathname}`;
    });

    await runStep('settings nav exposes all expected groups', async () => {
      const snap = await snapshot();
      for (const group of SETTINGS_GROUPS) {
        assert(snap.navLabels.some((label) => label.includes(group.label)), `missing nav group ${group.label}`);
      }
      return snap.navLabels.join(' | ');
    });

    for (const group of SETTINGS_GROUPS) {
      await runStep(`settings group renders: ${group.label}`, async () => {
        await clearSearch();
        await clickButton(group.label);
        const snap = await waitForText(group.requiredText, { timeoutMs: 25_000 });
        assert(snap.bodyText.length > 800, `${group.label} rendered too little content`);
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

    await runStep('tracking mode buttons persist Auto-Detect then Manual Only', async () => {
      await clickButton('Tracking');
      await clickButton('Auto-Detect');
      await waitForSettingValue('tracking_mode', 'auto_detect');
      await waitForSettingValue('auto_tracking_enabled', true);
      await clickButton('Manual Only');
      await waitForSettingValue('tracking_mode', 'manual');
      await waitForSettingValue('auto_tracking_enabled', false);
    });

    await runStep('appearance theme buttons persist dark, light, and system', async () => {
      await clickButton('Appearance');
      await clickButton('Dark');
      await waitForSettingValue('dark_mode', 'dark');
      await clickButton('Light');
      await waitForSettingValue('dark_mode', 'light');
      await clickButton('System');
      await waitForSettingValue('dark_mode', 'system');
    });

    await runStep('voice alerts toggle persists off and on', async () => {
      await clickButton('Notifications');
      await toggleRowByLabel('Voice alerts');
      await waitForSettingValue('voice_alerts_enabled', false);
      await toggleRowByLabel('Voice alerts');
      await waitForSettingValue('voice_alerts_enabled', true);
    });

    await runStep('speed warning toggle persists off and on', async () => {
      await clickButton('Scoring');
      await toggleRowByLabel('Live Speed Warning');
      await waitForSettingValue('speed_warning_enabled', false);
      await toggleRowByLabel('Live Speed Warning');
      await waitForSettingValue('speed_warning_enabled', true);
    });

    await runStep('privacy data retention select persists', async () => {
      await clickButton('Privacy & Data');
      await setSelectNearLabel('Data Retention', '12');
      await waitForSettingValue('data_retention_months', 12);
      await setSelectNearLabel('Data Retention', '24');
      await waitForSettingValue('data_retention_months', 24);
    });

    await runStep('currency select persists a non-dollar symbol and restores dollar', async () => {
      await clickButton('Appearance');
      const chosen = await setSelectNearLabel('Currency symbol', '€');
      const expected = chosen;
      const snap = await snapshot();
      assert(snap.settings.currencySymbol === expected || snap.settings.currency_symbol === expected, `currency did not persist as ${expected}`);
      await setSelectNearLabel('Currency symbol', '$').catch(async () => setSelectNearLabel('Currency symbol', 'USD'));
    });

    await runStep('UBI numeric input persists optimal annual km', async () => {
      await clickButton('UBI Coaching');
      await setInputNearLabel('UBI optimal annual km', '15000');
      await waitForSettingValue('ubi_optimal_annual_km', 15000);
      await setInputNearLabel('UBI optimal annual km', '10000');
      await waitForSettingValue('ubi_optimal_annual_km', 10000);
    });

    await runStep('native settings bridge accepts current settings payload', async () => {
      const result = await evaluateInWebView(`(async () => {
        const current = await Promise.race([
          globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition?.getSettings?.().catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        const settingsJson = current?.settingsJson || localStorage.getItem('road_sage_settings') || '{}';
        const saveSettings = globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition?.saveSettings;
        if (!saveSettings) return { saved: false, reason: 'bridge missing' };
        await Promise.race([
          saveSettings({ settingsJson }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('saveSettings timed out')), 3000)),
        ]);
        return { saved: true, size: settingsJson.length };
      })()`);
      assert(result.saved, result.reason || 'native saveSettings returned false');
      return `payloadBytes=${result.size}`;
    });

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
      assert(!/FATAL EXCEPTION|AndroidRuntime.*Exception/i.test(log), 'fatal Android exception found in logcat');
      assert(!/Uncaught \(in promise\)|ReferenceError|TypeError|SyntaxError/i.test(log), 'JavaScript exception found in logcat');
    });
  } finally {
    await adb(['forward', '--remove', `tcp:${DEBUG_PORT}`], { allowFailure: true });
  }

  console.log('');
  console.log(`RESULT settings phone sweep: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed > 0 ? 1 : 0;
}

await main();
