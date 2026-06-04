// Road Sage Android UIAutomator + WebView backup import regression test.
// Run after installing the debug APK:
//   node tests/android-uiautomator-backup-import.mjs

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APP_PACKAGE = 'com.roadsage.app';
const DEBUG_PORT = '9224';
const UI_DUMP_PATH = '/data/local/tmp/roadsage-backup-import-window.xml';
const IMPORT_TRIP_ID = `uia-import-trip-${Date.now()}`;
const IMPORT_TRIP_NAME = `Legacy JSON Restore ${IMPORT_TRIP_ID}`;
const IMPORT_VEHICLE_ID = `uia-import-vehicle-${Date.now()}`;

let passed = 0;
let failed = 0;
let launched = false;
let debuggerAttached = false;
let webviewProcessId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function connectedDeviceId() {
  const output = await adb(['devices']);
  const row = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\tdevice$/.test(line));
  return row?.split(/\s+/)[0] ?? null;
}

async function launchApp() {
  await adb(['logcat', '-c'], { allowFailure: true });
  await adb(['shell', 'am', 'force-stop', APP_PACKAGE], { allowFailure: true });
  const launchOutput = await launchPackage();
  await sleep(5000);
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
  assert.match(nextProcessId ?? '', /^\d+$/, 'app process id was not available');
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
  return evaluateInWebView(`(() => ({
    title: document.title,
    pathname: location.pathname,
    readyState: document.readyState,
    rootChildren: document.querySelector('#root')?.children.length ?? 0,
    bodyText: document.body?.innerText ?? '',
    buttons: [...document.querySelectorAll('button')]
      .map((button) => button.innerText.trim() || button.getAttribute('aria-label') || '')
      .filter(Boolean),
    hasFileInput: Boolean(document.querySelector('input[type="file"]')),
  }))()`);
}

async function waitForText(requiredText, { timeoutMs = 30_000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await snapshot();
    const bodyText = last.bodyText || '';
    if (
      last.readyState === 'complete' &&
      last.rootChildren >= 1 &&
      requiredText.every((text) => bodyText.toLowerCase().includes(String(text).toLowerCase()))
    ) {
      return last;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for text: ${requiredText.join(', ')}. Last text: ${(last?.bodyText || '').slice(0, 600)}`);
}

async function navigateToRoute(path) {
  const escapedPath = JSON.stringify(path);
  await evaluateInWebView(`(() => {
    history.pushState({}, '', ${escapedPath});
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    return location.pathname;
  })()`);
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
  assert.equal(result.clicked, true, `button not found: ${label}. Buttons: ${(result.buttons || []).join(' | ')}`);
  await sleep(800);
}

async function normalizeAppForImport() {
  await evaluateInWebView(`(async () => {
    const patch = {
      onboarding_completed: true,
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      biometric_lock_enabled: false,
      tracking_paused: false,
      data_retention_months: 24,
    };
    let current = {};
    try {
      current = JSON.parse(localStorage.getItem('road_sage_settings') || localStorage.getItem('drivesense_settings') || '{}');
    } catch {}
    const settings = { ...current, ...patch };
    localStorage.setItem('road_sage_settings', JSON.stringify(settings));
    localStorage.setItem('road_sage_first_launch_permission_prompted', JSON.stringify(true));
    const saveSettings = globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition?.saveSettings;
    if (saveSettings) {
      await Promise.race([
        saveSettings({ settingsJson: JSON.stringify(settings) }).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    return true;
  })()`);
}

function backupPayload() {
  return {
    app: 'Road Sage',
    version: 6,
    exported_at: '2026-06-01T12:00:00.000Z',
    settings: {
      onboarding_completed: true,
      data_retention_months: 24,
      tracking_mode: 'manual',
    },
    vehicles: [{
      id: IMPORT_VEHICLE_ID,
      name: 'UI Import Vehicle',
      make: 'Test',
      model: 'Restore',
      year: 2020,
      fuel_type: 'gasoline',
    }],
    trips: [{
      id: IMPORT_TRIP_ID,
      status: 'completed',
      nickname: IMPORT_TRIP_NAME,
      notes: 'Restored from legacy JSON by Android UIAutomator.',
      vehicle_id: IMPORT_VEHICLE_ID,
      start_time: '2020-01-01T12:00:00.000Z',
      end_time: '2020-01-01T12:18:00.000Z',
      duration_seconds: 1080,
      distance_km: 8.2,
      avg_speed_kmh: 27.3,
      avg_running_speed_kmh: 29.1,
      max_speed_kmh: 55,
      score_overall: 91,
      score_safety: 93,
      score_smoothness: 90,
      score_eco: 88,
      route_points: [
        { lat: 43.6532, lng: -79.3832, speed_kmh: 0, accuracy: 8, timestamp: '2020-01-01T12:00:00.000Z' },
        { lat: 43.6592, lng: -79.3772, speed_kmh: 35, accuracy: 8, timestamp: '2020-01-01T12:09:00.000Z' },
        { lat: 43.6662, lng: -79.3712, speed_kmh: 0, accuracy: 8, timestamp: '2020-01-01T12:18:00.000Z' },
      ],
      driving_events: [],
      event_feedback: {},
    }],
  };
}

async function importBackupThroughSettingsInput() {
  const payload = JSON.stringify(backupPayload());
  const result = await evaluateInWebView(`(() => {
    const input = document.querySelector('input[type="file"]');
    if (!input) return { dispatched: false, reason: 'backup file input not found' };
    window.confirm = () => true;
    const file = new File([${JSON.stringify(payload)}], 'legacy-road-sage-backup.json', { type: 'application/json' });
    if (typeof DataTransfer === 'function') {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      Object.defineProperty(input, 'files', { value: transfer.files, configurable: true });
    } else {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { dispatched: true, fileName: file.name, fileSize: file.size };
  })()`);
  assert.equal(result.dispatched, true, result.reason || 'backup import change event did not dispatch');
  return `${result.fileName} ${result.fileSize} bytes`;
}

async function importedTripFromIndexedDb() {
  return evaluateInWebView(`(() => new Promise((resolve) => {
    const request = indexedDB.open('road_sage_mobile');
    request.onerror = () => resolve({ found: false, error: request.error?.message || 'IndexedDB open failed' });
    request.onsuccess = () => {
      const db = request.result;
      if (![...db.objectStoreNames].includes('trips')) {
        resolve({ found: false, error: 'trips store missing' });
        return;
      }
      const tx = db.transaction('trips', 'readonly');
      const getRequest = tx.objectStore('trips').get(${JSON.stringify(IMPORT_TRIP_ID)});
      tx.oncomplete = () => {
        const trip = getRequest.result || null;
        resolve({
          found: Boolean(trip),
          id: trip?.id || null,
          status: trip?.status || null,
          nickname: trip?.nickname || null,
          routeKey: trip?.route_points?._key || null,
          notesKey: trip?.notes?._key || null,
        });
      };
      tx.onerror = () => resolve({ found: false, error: tx.error?.message || 'trip lookup failed' });
    };
  }))()`);
}

async function waitForImportedTrip({ timeoutMs = 60_000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await importedTripFromIndexedDb();
    if (last?.found) return last;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for imported trip in IndexedDB. Last result: ${JSON.stringify(last)}`);
}

async function main() {
  let deviceId = null;

  await runStep('ADB connected phone is available', async () => {
    deviceId = await connectedDeviceId();
    assert.ok(deviceId, 'no adb device is connected');
    return deviceId;
  });

  if (!deviceId) {
    process.exitCode = 1;
    return;
  }

  try {
    await runStep('APK package is installed on phone', async () => {
      const output = await adb(['shell', 'pm', 'path', APP_PACKAGE], { timeoutMs: 10_000 });
      assert.match(output, new RegExp(APP_PACKAGE), `${APP_PACKAGE} is not installed`);
      return output.split(/\r?\n/)[0];
    });

    await runStep('UIAutomator sees the Road Sage WebView shell', async () => {
      await ensureAppLaunched();
      const hierarchy = await dumpUiHierarchy();
      assert.ok(hierarchy.length > 500, 'UI hierarchy was empty');
      assert.match(hierarchy, new RegExp(`package="${APP_PACKAGE}"`), 'Road Sage package was not in hierarchy');
      assert.match(hierarchy, /class="android\.webkit\.WebView"/, 'Android WebView was not visible');
    });

    await runStep('Settings privacy import control is available', async () => {
      await attachWebViewDebugger();
      await normalizeAppForImport();
      await navigateToRoute('/settings');
      await waitForText(['Settings', 'Tracking']);
      await clickButton('Privacy & Data');
      const snap = await waitForText(['Privacy & Data', 'Import Backup', 'Data Retention']);
      assert.equal(snap.hasFileInput, true, 'hidden backup file input was not mounted');
      return `route=${snap.pathname}`;
    });

    await runStep('Legacy plaintext JSON backup imports through Settings UI', async () => {
      const detail = await importBackupThroughSettingsInput();
      const imported = await waitForImportedTrip({ timeoutMs: 60_000 });
      assert.equal(imported.status, 'completed');
      assert.equal(imported.nickname, IMPORT_TRIP_NAME);
      return `${detail}; stored with ${imported.routeKey || 'unknown'} route key`;
    });

    await runStep('Imported legacy trip detail is visible from Trip History route', async () => {
      await navigateToRoute(`/trips/${encodeURIComponent(IMPORT_TRIP_ID)}`);
      const snap = await waitForText([IMPORT_TRIP_NAME], { timeoutMs: 60_000 });
      assert.match(snap.bodyText, new RegExp(IMPORT_TRIP_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return IMPORT_TRIP_ID;
    });

    await runStep('Launch log has no crash or JavaScript exception', async () => {
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
  } finally {
    await adb(['forward', '--remove', `tcp:${DEBUG_PORT}`], { allowFailure: true });
  }

  console.log('');
  console.log(`RESULT backup import phone test: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

await main();
