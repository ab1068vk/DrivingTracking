// Road Sage Android UIAutomator + WebView onboarding regression sweep.
// Run after installing the debug APK:
//   node tests/android-uiautomator-onboarding.mjs
//
// UIAutomator verifies the native WebView shell. CDP drives the React
// onboarding UI and native storage bridges so restarts exercise the same
// startup path a real Android user hits.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APP_PACKAGE = 'com.roadsage.app';
const DEBUG_PORT = '9225';
const UI_DUMP_PATH = '/data/local/tmp/roadsage-onboarding-window.xml';
const SETTINGS_KEY = 'road_sage_settings';
const LEGACY_SETTINGS_KEY = 'drivesense_settings';
const FIRST_LAUNCH_PROMPTED_KEY = 'road_sage_first_launch_permission_prompted';
const ONBOARDING_COMPLETED_KEY = 'road_sage_onboarding_completed_v1';
const SETUP_TIMEOUT_BUFFER_MS = 31_000;

const RUNTIME_PERMISSIONS = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACTIVITY_RECOGNITION',
  'android.permission.POST_NOTIFICATIONS',
];

const BASELINE_SETTINGS = {
  onboarding_completed: true,
  tracking_mode: 'manual',
  auto_tracking_enabled: false,
  background_tracking_enabled: false,
  tracking_paused: false,
  biometric_lock_enabled: false,
  notifications_enabled: true,
  notification_permission_granted: true,
  location_permission_granted: true,
  activity_permission_granted: true,
  background_location_granted: false,
  external_context_auto_fetch_enabled: true,
  dark_mode: 'system',
  units: 'metric',
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
  launched = false;
  debuggerAttached = false;
  webviewProcessId = null;
  await adb(['forward', '--remove', `tcp:${DEBUG_PORT}`], { allowFailure: true });
  const launchOutput = await adb(['shell', 'monkey', '-p', APP_PACKAGE, '1'], { timeoutMs: 15_000 });
  assert.match(launchOutput, /Events injected:\s*1/, 'monkey did not launch the app');
  await sleep(5_000);
  launched = true;
}

async function ensureAppLaunched() {
  if (!launched) await launchApp();
}

async function dumpUiHierarchy() {
  await adb(['shell', 'uiautomator', 'dump', UI_DUMP_PATH], { timeoutMs: 30_000, allowFailure: true });
  return adb(['exec-out', 'cat', UI_DUMP_PATH], { timeoutMs: 30_000 });
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
  return evaluateInWebView(`(async () => {
    const readJson = (value, fallback = null) => {
      try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
    };
    const encrypted = globalThis.Capacitor?.Plugins?.EncryptedCapacitorPlugin;
    const native = globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition;
    let encryptedMarker = null;
    let nativeSettings = null;
    if (encrypted?.get) {
      encryptedMarker = await Promise.race([
        encrypted.get({ key: ${JSON.stringify(ONBOARDING_COMPLETED_KEY)} }).then((result) => readJson(result?.value, null)).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
      ]);
    }
    if (native?.getSettings) {
      nativeSettings = await Promise.race([
        native.getSettings().then((result) => readJson(result?.settingsJson, null)).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
      ]);
    }
    return {
      title: document.title,
      url: location.href,
      pathname: location.pathname,
      readyState: document.readyState,
      rootExists: Boolean(document.querySelector('#root')),
      rootChildren: document.querySelector('#root')?.children.length ?? 0,
      bodyText: document.body?.innerText ?? '',
      buttons: [...document.querySelectorAll('button')]
        .map((button) => button.innerText.trim() || button.getAttribute('aria-label') || '')
        .filter(Boolean),
      localSettings: readJson(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}), {}),
      nativeSettings,
      settings: nativeSettings || readJson(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}), {}),
      localMarker: readJson(localStorage.getItem(${JSON.stringify(ONBOARDING_COMPLETED_KEY)}), null),
      encryptedMarker,
      plugins: Object.keys(globalThis.Capacitor?.Plugins || {}),
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
  throw new Error(`Timed out waiting for text: ${requiredText.join(', ')}. Last text: ${(last?.bodyText || '').slice(0, 600)}`);
}

async function clickButton(label, { allowMissing = false } = {}) {
  const result = await evaluateInWebView(`(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const button = [...document.querySelectorAll('button')].find((candidate) => {
      const text = (candidate.innerText || candidate.getAttribute('aria-label') || '').trim().toLowerCase();
      return text === wanted || text.includes(wanted);
    });
    if (!button) {
      return {
        clicked: false,
        buttons: [...document.querySelectorAll('button')].map((b) => b.innerText.trim() || b.getAttribute('aria-label') || ''),
      };
    }
    button.click();
    return { clicked: true, text: button.innerText.trim() || button.getAttribute('aria-label') || '' };
  })()`);
  if (!allowMissing) {
    assert.equal(result.clicked, true, `button not found: ${label}. Buttons: ${(result.buttons || []).join(' | ')}`);
  }
  await sleep(900);
  return result;
}

async function saveOnboardingState({
  onboardingCompleted,
  markerCompleted = null,
  firstLaunchPrompted = true,
  trackingMode = 'manual',
} = {}) {
  const settings = {
    ...BASELINE_SETTINGS,
    onboarding_completed: Boolean(onboardingCompleted),
    tracking_mode: trackingMode,
    auto_tracking_enabled: trackingMode !== 'manual',
    background_tracking_enabled: trackingMode === 'background_auto',
  };

  await evaluateInWebView(`(async () => {
    const settings = ${JSON.stringify(settings)};
    const markerCompleted = ${JSON.stringify(markerCompleted)};
    const firstLaunchPrompted = ${JSON.stringify(firstLaunchPrompted)};
    const encrypted = globalThis.Capacitor?.Plugins?.EncryptedCapacitorPlugin;
    const native = globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition;
    const serialized = JSON.stringify(settings);

    localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, serialized);
    localStorage.setItem(${JSON.stringify(LEGACY_SETTINGS_KEY)}, serialized);
    localStorage.setItem(${JSON.stringify(FIRST_LAUNCH_PROMPTED_KEY)}, JSON.stringify(Boolean(firstLaunchPrompted)));
    if (markerCompleted === null) {
      localStorage.removeItem(${JSON.stringify(ONBOARDING_COMPLETED_KEY)});
    } else {
      localStorage.setItem(${JSON.stringify(ONBOARDING_COMPLETED_KEY)}, JSON.stringify(Boolean(markerCompleted)));
    }

    if (encrypted?.set) {
      await Promise.race([
        encrypted.set({ key: ${JSON.stringify(SETTINGS_KEY)}, value: serialized }).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
      if (markerCompleted === null && encrypted.remove) {
        await Promise.race([
          encrypted.remove({ key: ${JSON.stringify(ONBOARDING_COMPLETED_KEY)} }).catch(() => null),
          new Promise((resolve) => setTimeout(resolve, 1200)),
        ]);
      } else if (markerCompleted !== null) {
        await Promise.race([
          encrypted.set({ key: ${JSON.stringify(ONBOARDING_COMPLETED_KEY)}, value: JSON.stringify(Boolean(markerCompleted)) }).catch(() => null),
          new Promise((resolve) => setTimeout(resolve, 1200)),
        ]);
      }
    }
    if (native?.saveSettings) {
      await Promise.race([
        native.saveSettings({ settingsJson: serialized }).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
    }
    return { settings, markerCompleted, firstLaunchPrompted };
  })()`);
}

async function clearAppDataForFreshOnboarding({ grantPermissions = true } = {}) {
  await adb(['shell', 'am', 'force-stop', APP_PACKAGE], { allowFailure: true });
  const output = await adb(['shell', 'pm', 'clear', APP_PACKAGE], {
    timeoutMs: 20_000,
    allowFailure: true,
  });
  assert.match(output, /Success/i, `pm clear failed: ${output}`);
  launched = false;
  debuggerAttached = false;
  webviewProcessId = null;
  if (grantPermissions) await grantRuntimePermissions();
}

async function relaunchAndAttach() {
  await launchApp();
  await attachWebViewDebugger();
}

async function openFreshOnboarding({ grantPermissions = true } = {}) {
  await clearAppDataForFreshOnboarding({ grantPermissions });
  await relaunchAndAttach();
  await attachWebViewDebugger();
  await saveOnboardingState({
    onboardingCompleted: false,
    markerCompleted: null,
    firstLaunchPrompted: true,
    trackingMode: 'manual',
  });
  await relaunchAndAttach();
  return waitForText(['Welcome to Road Sage', 'Continue'], { timeoutMs: 45_000 });
}

async function walkToTrackingStepWithSkips() {
  let snap = await waitForText(['Welcome to Road Sage', 'Continue'], { timeoutMs: 45_000 });
  assert.match(snap.bodyText, /Your intelligent driving companion/i);

  await clickButton('Continue');
  snap = await waitForText(['Location Access', 'Grant Location Access', 'Skip for now']);
  assert.match(snap.bodyText, /Required for trip tracking/i);

  await clickButton('Skip for now');
  snap = await waitForText(['Motion & Activity', 'Skip for now']);
  assert.match(snap.bodyText, /smarter trip detection/i);

  await clickButton('Skip for now');
  snap = await waitForText(['Notifications', 'Skip for now']);
  assert.match(snap.bodyText, /Optional but recommended/i);

  await clickButton('Skip for now');
  snap = await waitForText(['Tracking Mode', 'Manual Only', 'Auto-Detect', 'Background Auto', 'Get Started']);
  assert.match(snap.bodyText, /Setup checklist/i);
  assert.match(snap.bodyText, /Automatic road data/i);
  return snap;
}

async function installHangingLocationShim() {
  return evaluateInWebView(`(() => {
    const plugins = globalThis.Capacitor?.Plugins || {};
    const geo = plugins.Geolocation;
    if (!geo) return { installed: false, reason: 'Geolocation plugin missing' };
    geo.__roadSageOriginalCheckPermissions = geo.checkPermissions;
    geo.__roadSageOriginalRequestPermissions = geo.requestPermissions;
    geo.checkPermissions = async () => ({ location: 'denied', coarseLocation: 'denied' });
    geo.requestPermissions = () => new Promise(() => {});
    return { installed: true };
  })()`);
}

async function removeHangingLocationShim() {
  return evaluateInWebView(`(() => {
    const geo = globalThis.Capacitor?.Plugins?.Geolocation;
    if (!geo) return false;
    if (geo.__roadSageOriginalCheckPermissions) geo.checkPermissions = geo.__roadSageOriginalCheckPermissions;
    if (geo.__roadSageOriginalRequestPermissions) geo.requestPermissions = geo.__roadSageOriginalRequestPermissions;
    return true;
  })()`, { timeoutMs: 5_000 }).catch(() => false);
}

async function assertNoRequestingText({ timeoutMs = 35_000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await snapshot();
    if (!/Requesting/i.test(last.bodyText || '')) return last;
    await sleep(700);
  }
  throw new Error(`onboarding still showed requesting text. Last text: ${(last?.bodyText || '').slice(0, 600)}`);
}

async function waitForSettingValue(key, expected, { timeoutMs = 12_000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await snapshot();
    if (Object.is(last.settings?.[key], expected)) return last;
    await sleep(500);
  }
  throw new Error(`setting ${key} expected ${JSON.stringify(expected)} but was ${JSON.stringify(last?.settings?.[key])}`);
}

async function waitForCompletionMarker({ timeoutMs = 12_000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await snapshot();
    if (last.localMarker === true || last.encryptedMarker === true) return last;
    await sleep(500);
  }
  throw new Error(`completion marker was not persisted. local=${last?.localMarker} encrypted=${last?.encryptedMarker}`);
}

async function main() {
  let deviceId = null;

  await runStep('ADB connected phone is available', async () => {
    deviceId = await connectedDeviceId();
    assert.ok(deviceId, 'no adb device is connected');
    return deviceId;
  });

  if (!deviceId) {
    await skipStep('onboarding UIAutomator sweep', 'no connected Android device');
    process.exitCode = 1;
    return;
  }

  try {
    await runStep('APK package is installed on phone', async () => {
      const output = await adb(['shell', 'pm', 'path', APP_PACKAGE], { timeoutMs: 10_000 });
      assert.match(output, new RegExp(escapeRegExp(APP_PACKAGE)), `${APP_PACKAGE} is not installed`);
      return output.split(/\r?\n/)[0];
    });

    await runStep('runtime permissions needed for non-blocking completion are granted', grantRuntimePermissions);

    await runStep('UIAutomator sees Road Sage WebView shell', async () => {
      await launchApp();
      const hierarchy = await dumpUiHierarchy();
      assert.ok(hierarchy.length > 500, 'UI hierarchy was empty');
      assert.match(hierarchy, new RegExp(`package="${APP_PACKAGE}"`), 'Road Sage package was not in hierarchy');
      assert.match(hierarchy, /class="android\.webkit\.WebView"/, 'Android WebView was not visible');
    });

    await runStep('fresh launch renders the welcome onboarding step', async () => {
      const snap = await openFreshOnboarding();
      assert.equal(snap.title, 'Road Sage');
      assert.match(snap.bodyText, /Welcome to Road Sage/i);
      assert.match(snap.bodyText, /All data stays on your device/i);
    });

    await runStep('skip path covers location, motion, notifications, and tracking choices', async () => {
      await walkToTrackingStepWithSkips();
      await clickButton('Auto-Detect');
      await waitForText(['Auto-Detect', 'Get Started']);
      await clickButton('Manual Only');
      const snap = await waitForText(['Manual Only', 'Get Started']);
      assert.match(snap.bodyText, /Location/i);
      assert.match(snap.bodyText, /Notifications/i);
      assert.match(snap.bodyText, /Motion and activity/i);
    });

    await runStep('individual permission request recovers from requesting timeout', async () => {
      await openFreshOnboarding({ grantPermissions: false });
      await clickButton('Continue');
      await waitForText(['Location Access', 'Grant Location Access']);
      const shim = await installHangingLocationShim();
      assert.equal(shim.installed, true, shim.reason || 'location shim was not installed');
      await clickButton('Grant Location Access');
      await sleep(SETUP_TIMEOUT_BUFFER_MS);
      const snap = await assertNoRequestingText({ timeoutMs: 8_000 });
      assert.match(snap.bodyText, /Grant Location Access|Location setup did not finish|Continue/i);
      await removeHangingLocationShim();
    });

    await runStep('Get Started saves onboarding completion marker', async () => {
      await openFreshOnboarding();
      await walkToTrackingStepWithSkips();
      await clickButton('Manual Only');
      await clickButton('Get Started');
      await waitForText(['Dashboard', 'Ready to drive?'], { timeoutMs: 45_000 });
      const snap = await waitForCompletionMarker();
      return `marker local=${snap.localMarker} encrypted=${snap.encryptedMarker}`;
    });

    await runStep('completed onboarding survives app close and reopen', async () => {
      await relaunchAndAttach();
      const snap = await waitForText(['Dashboard', 'Ready to drive?'], { timeoutMs: 45_000 });
      assert.doesNotMatch(snap.bodyText, /Welcome to Road Sage|Location Access/i, 'onboarding returned after relaunch');
    });

    await runStep('completion marker beats stale native onboarding=false snapshot', async () => {
      await saveOnboardingState({
        onboardingCompleted: false,
        markerCompleted: true,
        firstLaunchPrompted: true,
        trackingMode: 'manual',
      });
      await relaunchAndAttach();
      const snap = await waitForText(['Dashboard', 'Ready to drive?'], { timeoutMs: 45_000 });
      assert.doesNotMatch(snap.bodyText, /Welcome to Road Sage|Get Started/i, 'stale native settings reopened onboarding');
      assert.ok(snap.localMarker === true || snap.encryptedMarker === true, 'completion marker should still be present');
    });

    await runStep('launch log has no fatal onboarding crash or JavaScript exception', async () => {
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
      assert.doesNotMatch(log, /FATAL EXCEPTION|AndroidRuntime.*Exception/i, 'fatal Android exception found in logcat');
      assert.doesNotMatch(log, /Uncaught \(in promise\)|ReferenceError|TypeError|SyntaxError/i, 'JavaScript exception found in logcat');
    });
  } finally {
    await removeHangingLocationShim();
    await adb(['forward', '--remove', `tcp:${DEBUG_PORT}`], { allowFailure: true });
  }

  console.log('');
  console.log(`RESULT onboarding UIAutomator sweep: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed > 0 ? 1 : 0;
}

await main();
