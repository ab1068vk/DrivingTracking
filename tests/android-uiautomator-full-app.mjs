// Road Sage Android UIAutomator + WebView full-app smoke test.
// Run: node tests/android-uiautomator-full-app.mjs
//
// UIAutomator can see the native Capacitor shell and WebView container. It
// usually cannot see React text inside the WebView, so this test also attaches
// to WebView DevTools to verify the actual app text and walk the main routes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APP_PACKAGE = 'com.roadsage.app';
const DEBUG_PORT = '9222';
const UI_DUMP_PATH = '/sdcard/roadsage-window.xml';
const REQUIRED_DASHBOARD_TEXT = [
  'Road Sage',
  'Dashboard',
  'Ready to drive?',
  'Recent Trips',
];
const TEST_SETTINGS_PATCH = {
  onboarding_completed: true,
  tracking_mode: 'manual',
  auto_tracking_enabled: false,
  background_tracking_enabled: false,
  biometric_lock_enabled: false,
  tracking_paused: false,
  external_context_auto_fetch_enabled: false,
};
const CORE_ROUTES = [
  { path: '/', label: 'Dashboard', requiredText: ['Dashboard', 'Ready to drive?', 'Recent Trips'] },
  { path: '/trips', label: 'Trips', requiredText: ['Trip History', 'All Trips'] },
  { path: '/map', label: 'Map', requiredText: ['Map', 'Map View', 'Map layers'] },
  { path: '/coach', label: 'Coach', requiredText: ['Driving Coach', 'Actionable driving patterns'] },
  { path: '/insights', label: 'Insights', requiredText: ['Driving Insights'] },
  { path: '/achievements', label: 'Awards', requiredText: ['Achievements'] },
  { path: '/reports', label: 'Reports', requiredText: ['Reports'] },
  { path: '/vehicles', label: 'Vehicles', requiredText: ['My Vehicles'] },
  { path: '/settings', label: 'Settings', requiredText: ['Settings'] },
];

let hasDevice = false;
let deviceId = null;
let webviewProcessId = null;
let launched = false;
let debuggerAttached = false;

async function adb(args, { timeoutMs = 30_000, allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('adb', args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
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

async function launchApp() {
  await adb(['logcat', '-c'], { allowFailure: true });
  await adb(['shell', 'am', 'force-stop', APP_PACKAGE], { allowFailure: true });
  const launchOutput = await adb(['shell', 'monkey', '-p', APP_PACKAGE, '1'], { timeoutMs: 15_000 });
  assert.match(launchOutput, /Events injected:\s*1/, 'monkey launch should inject one launch event');
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  launched = true;
}

async function ensureAppLaunched() {
  if (!launched) await launchApp();
}

async function currentFocus() {
  return adb(['shell', 'dumpsys', 'window'], { timeoutMs: 30_000 });
}

async function dumpUiHierarchy() {
  await adb(['shell', 'uiautomator', 'dump', UI_DUMP_PATH], { timeoutMs: 30_000 });
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

async function inspectWebViewDom() {
  let lastResult = null;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
    const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    assert.ok(pages.length > 0, 'WebView page target should expose a debugger URL');

    for (const page of pages) {
      const dom = await inspectWebViewPage(page);
      lastResult = { target: page, dom };
      const hasRoadSageContent = dom.title === 'Road Sage' || dom.bodyText?.includes('Road Sage');
      const hasRenderedApp = dom.rootExists && dom.rootChildren >= 1 && dom.bodyText?.length > 250;
      if (hasRoadSageContent && hasRenderedApp) {
        return lastResult;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return lastResult;
}

async function firstWebViewPage() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 500));
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
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'WebView evaluation failed');
    }
    return result.result.value;
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

async function inspectWebViewPage(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  const idRef = { value: 0 };
  await cdpCall(socket, idRef, 'Runtime.enable');

  const expression = `(() => ({
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    rootExists: Boolean(document.querySelector('#root')),
    rootChildren: document.querySelector('#root')?.children.length ?? 0,
    bodyText: document.body?.innerText ?? '',
    buttonText: [...document.querySelectorAll('button')]
      .map((button) => button.innerText.trim())
      .filter(Boolean),
    hasBluetoothPermissionBridge: Boolean(
      globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition?.requestBluetoothPermission
    ),
  }))()`;

  const result = await cdpCall(socket, idRef, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  socket.close();
  return result.result.value;
}

async function normalizeMainAppState() {
  const patch = JSON.stringify(TEST_SETTINGS_PATCH);
  await evaluateInWebView(`(async () => {
    const patch = ${patch};
    let current = {};
    try {
      current = JSON.parse(
        localStorage.getItem('road_sage_settings') ||
        localStorage.getItem('drivesense_settings') ||
        '{}'
      );
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
    return {
      saved: true,
      onboardingCompleted: settings.onboarding_completed === true,
      hasNativeSettingsBridge: Boolean(globalThis.Capacitor?.Plugins?.DriveSenseActivityRecognition?.saveSettings),
    };
  })()`);

  await evaluateInWebView(`(() => {
    location.href = 'https://localhost/';
    return true;
  })()`).catch(() => true);
  await waitForDomText(['Dashboard', 'Ready to drive?', 'Recent Trips'], { timeoutMs: 30_000 });
}

async function navigateToRoute(path) {
  const escapedPath = JSON.stringify(path);
  await evaluateInWebView(`(() => {
    history.pushState({}, '', ${escapedPath});
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    return { pathname: location.pathname };
  })()`);
}

async function waitForDomText(requiredText, { timeoutMs = 20_000 } = {}) {
  const started = Date.now();
  let lastDom = null;
  while (Date.now() - started < timeoutMs) {
    const page = await firstWebViewPage();
    const dom = await inspectWebViewPage(page);
    lastDom = dom;
    const bodyText = dom.bodyText || '';
    if (
      dom.readyState === 'complete' &&
      dom.rootExists &&
      dom.rootChildren >= 1 &&
      requiredText.every((text) => bodyText.includes(text))
    ) {
      return dom;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for WebView text: ${requiredText.join(', ')}. Last text: ${(lastDom?.bodyText || '').slice(0, 500)}`);
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

test('connected Android device is available', (t) => {
  if (!hasDevice) t.skip('No adb device connected');
  assert.ok(deviceId, 'adb should report one connected device');
});

test('UIAutomator sees Road Sage focused with a WebView shell', async (t) => {
  if (!hasDevice) t.skip('No adb device connected');

  await ensureAppLaunched();

  const focus = await currentFocus();
  assert.match(focus, new RegExp(`${APP_PACKAGE}/\\.${'MainActivity'}`), 'Road Sage MainActivity should be focused');

  const hierarchy = await dumpUiHierarchy();
  assert.ok(hierarchy.length > 500, 'UIAutomator hierarchy should not be empty');
  assert.match(hierarchy, new RegExp(`package="${APP_PACKAGE}"`), 'hierarchy should belong to Road Sage');
  assert.match(hierarchy, /class="android\.webkit\.WebView"/, 'Capacitor WebView should be present');
});

test('WebView text proves the React app is mounted on the dashboard', async (t) => {
  if (!hasDevice) t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();
  const { target, dom } = await inspectWebViewDom();

  assert.ok(target.url === 'https://localhost/' || dom.url === 'https://localhost/', 'WebView should be on the bundled app URL');
  assert.equal(dom.title, 'Road Sage');
  assert.match(dom.readyState, /^(interactive|complete)$/);
  assert.equal(dom.rootExists, true, '#root should exist');
  assert.ok(dom.rootChildren >= 1, '#root should have rendered children');
  assert.ok(dom.bodyText.length > 250, 'body text should contain rendered app content');
  for (const text of REQUIRED_DASHBOARD_TEXT) {
    assert.match(dom.bodyText, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing dashboard text: ${text}`);
  }
  assert.equal(dom.hasBluetoothPermissionBridge, true, 'native Bluetooth permission bridge should be registered');
});

test('core app routes render real functional screens inside the phone WebView', async (t) => {
  if (!hasDevice) t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();

  for (const route of CORE_ROUTES) {
    await navigateToRoute(route.path);
    const dom = await waitForDomText(route.requiredText);
    assert.equal(dom.title, 'Road Sage', `${route.label} should keep the app title`);
    assert.ok(dom.bodyText.length > 100, `${route.label} should render meaningful app content`);
  }
});

test('navigation links, native bridges, and settings storage are available in-app', async (t) => {
  if (!hasDevice) t.skip('No adb device connected');

  await attachWebViewDebugger();
  await normalizeMainAppState();

  const contract = await evaluateInWebView(`(() => {
    const navLabels = [...document.querySelectorAll('a')]
      .map((link) => link.innerText.trim())
      .filter(Boolean);
    const buttonLabels = [...document.querySelectorAll('button')]
      .map((button) => button.innerText.trim() || button.getAttribute('aria-label') || '')
      .filter(Boolean);
    const settings = JSON.parse(localStorage.getItem('road_sage_settings') || '{}');
    const plugins = globalThis.Capacitor?.Plugins || {};
    return {
      navLabels,
      buttonLabels,
      pathname: location.pathname,
      onboardingCompleted: settings.onboarding_completed === true,
      hasActivityPlugin: Boolean(plugins.DriveSenseActivityRecognition),
      hasSettingsBridge: Boolean(plugins.DriveSenseActivityRecognition?.saveSettings),
      hasLocalNotifications: Boolean(plugins.LocalNotifications),
      hasGeolocation: Boolean(plugins.Geolocation),
    };
  })()`);

  for (const route of CORE_ROUTES) {
    assert.ok(contract.navLabels.includes(route.label), `missing nav link: ${route.label}`);
  }
  assert.equal(contract.onboardingCompleted, true, 'test settings should keep onboarding complete');
  assert.equal(contract.hasActivityPlugin, true, 'DriveSenseActivityRecognition bridge should be registered');
  assert.equal(contract.hasSettingsBridge, true, 'native settings bridge should be registered');
  assert.equal(contract.hasLocalNotifications, true, 'LocalNotifications bridge should be registered');
  assert.equal(contract.hasGeolocation, true, 'Geolocation bridge should be registered');
  assert.ok(contract.buttonLabels.some((label) => /Start Trip|Refresh|Map View|Settings/i.test(label)), 'expected app action buttons should be present');
});

test('launch log has no app crash or JavaScript exception', async (t) => {
  if (!hasDevice) t.skip('No adb device connected');

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

  assert.doesNotMatch(log, /FATAL EXCEPTION|AndroidRuntime.*Exception/i);
  assert.doesNotMatch(log, /Uncaught \(in promise\)|ReferenceError|TypeError|SyntaxError/i);
});
