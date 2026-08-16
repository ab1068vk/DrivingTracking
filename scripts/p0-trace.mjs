#!/usr/bin/env node
/**
 * P0 independent Long Task capture over CDP.
 *
 * Mandatory for **arm D**, where the in-app probe is off and therefore has no
 * internal Long Task data at all: the matched A/D pair is the only way to
 * measure the probe's own downstream allocation/GC cost. Also used as the
 * independent cross-check for the other arms, since Road Sage's own observer in
 * `systemLog.js` is throttled to one entry per five seconds and keeps only the
 * batch maximum.
 *
 * Sibling to `scripts/android-perf-cdp.mjs`, which stays as-is and is used to
 * pull the probe's raw export out of the WebView.
 *
 * Usage:
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   node scripts/p0-trace.mjs --seconds 300 --out arm-d-trace.json
 */

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const port = Number(process.env.CDP_PORT || argValue('--port', 9222));
const seconds = Number(argValue('--seconds', 300));
const outFile = argValue('--out', 'p0-trace.json');
const label = argValue('--label', '');

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === 'page');
if (!target) throw new Error(`No WebView page target found on port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const traceEvents = [];
let tracingComplete = null;

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Tracing.dataCollected') {
    traceEvents.push(...(message.params?.value || []));
  }
  if (message.method === 'Tracing.tracingComplete') {
    tracingComplete?.();
  }
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId;
  nextId += 1;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

console.error(`Tracing for ${seconds}s on port ${port}…`);
await send('Tracing.start', {
  transferMode: 'ReportEvents',
  traceConfig: {
    recordMode: 'recordContinuously',
    includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'],
  },
});

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const completed = new Promise((resolve) => { tracingComplete = resolve; });
await send('Tracing.end');
await completed;
socket.close();

/**
 * Identify the renderer main thread before counting anything.
 *
 * `RunTask` is emitted on several threads in a Chrome trace — the browser
 * process, the GPU process, compositor and worker threads all produce them.
 * Accepting every `RunTask` mixes threads that never blocked this page's main
 * thread into the TBT figure, which is the number the A/B gate turns on.
 *
 * The main thread is the one Chrome names `CrRendererMain` via
 * `thread_name` metadata. When several renderers are in the trace (an iframe in
 * its own process, say), the target is the one whose process also emits the
 * page's navigation/frame events; failing that, the busiest, which is the one
 * that actually ran this page.
 */
const threadNames = new Map();
const rendererProcesses = new Set();
for (const event of traceEvents) {
  if (event.name === 'thread_name' && event.ph === 'M') {
    threadNames.set(`${event.pid}:${event.tid}`, event.args?.name);
    if (event.args?.name === 'CrRendererMain') rendererProcesses.add(event.pid);
  }
}

const rendererMainKeys = [...threadNames.entries()]
  .filter(([, name]) => name === 'CrRendererMain')
  .map(([key]) => key);

if (!rendererMainKeys.length) {
  console.error(
    'No CrRendererMain thread found in the trace. Refusing to count every RunTask across all threads: '
    + 'that would mix browser/GPU/compositor work into the blocking metric. '
    + 'Re-capture with the devtools.timeline category enabled against the WebView page target.'
  );
  process.exit(2);
}

const allRunTasks = traceEvents.filter((event) => event.name === 'RunTask' && event.ph === 'X');

// Pick the busiest renderer main thread when the trace has more than one.
let targetKey = rendererMainKeys[0];
if (rendererMainKeys.length > 1) {
  const busiest = new Map();
  for (const event of allRunTasks) {
    const key = `${event.pid}:${event.tid}`;
    if (!rendererMainKeys.includes(key)) continue;
    busiest.set(key, (busiest.get(key) || 0) + (event.dur || 0));
  }
  targetKey = [...busiest.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? targetKey;
}
const [targetPid, targetTid] = targetKey.split(':').map(Number);

const runTasks = allRunTasks
  .filter((event) => event.pid === targetPid && event.tid === targetTid)
  .map((event) => ({
    start_time_ms: event.ts / 1000,
    duration_ms: (event.dur || 0) / 1000,
    thread_id: event.tid,
  }))
  .sort((a, b) => a.start_time_ms - b.start_time_ms);

console.error(
  `Renderer main thread pid=${targetPid} tid=${targetTid}: `
  + `${runTasks.length} of ${allRunTasks.length} RunTask events retained.`
);

const longTasks = runTasks.filter((task) => task.duration_ms >= 50);
const totalBlocking = longTasks.reduce((sum, task) => sum + Math.max(0, task.duration_ms - 50), 0);
const wallMs = runTasks.length
  ? (runTasks.at(-1).start_time_ms + runTasks.at(-1).duration_ms) - runTasks[0].start_time_ms
  : 0;

const output = {
  capture_kind: 'p0_cdp_trace',
  label,
  captured_at: new Date().toISOString(),
  seconds,
  renderer_pid: targetPid,
  renderer_tid: targetTid,
  renderer_main_thread_count: rendererMainKeys.length,
  run_task_total_all_threads: allRunTasks.length,
  run_task_count: runTasks.length,
  long_task_count: longTasks.length,
  long_task_total_ms: longTasks.reduce((sum, task) => sum + task.duration_ms, 0),
  total_blocking_time_ms: totalBlocking,
  wall_ms: wallMs,
  blocked_fraction: wallMs > 0 ? totalBlocking / wallMs : 0,
  max_task_ms: longTasks.reduce((max, task) => Math.max(max, task.duration_ms), 0),
  long_tasks: longTasks,
};

writeFileSync(outFile, JSON.stringify(output, null, 2));
console.error(`Wrote ${outFile}: ${longTasks.length} long tasks, ${totalBlocking.toFixed(1)} ms TBT`);
