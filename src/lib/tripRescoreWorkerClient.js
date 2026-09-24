/**
 * Runs `computeTripRescore` in a Web Worker so a rescore turn cannot freeze the UI.
 *
 * DPD-031. The worker is created lazily and reused. If Web Workers are unavailable
 * or the worker cannot load, the same pure function runs on the main thread: the
 * rescore still converges (it is never silently deferred), and the fallback is
 * logged once so a device report shows which path actually ran. A worker that does
 * not answer is terminated and the request fails, which the rescoring queue's
 * per-trip attempt ceiling already handles - a hung compute never becomes a hung
 * queue.
 */
import { computeTripRescore } from '@/lib/tripRescoreCompute';
import { measureAsync } from '@/lib/performanceTriage';
import { logSystemFailure } from '@/lib/systemLog';

// A *hung* worker, not a slow one: event detection is still superlinear in route
// points inside the worker, and a legitimate 20k-50k-point route must not be killed
// and charged an attempt. Ten minutes bounds a wedged worker without doing that.
export const TRIP_RESCORE_WORKER_TIMEOUT_MS = 600_000;

let worker = null;
let workerUnavailable = false;
let fallbackLogged = false;
let nextRequestId = 0;
const pending = new Map();

const rejectAll = (error) => {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
};

const discardWorker = () => {
  try { worker?.terminate(); } catch { /* already gone */ }
  worker = null;
};

const ensureWorker = () => {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/tripRescore.worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event) => {
    const { requestId, result, error } = event.data || {};
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (error) entry.reject(new Error(error));
    else entry.resolve(result);
  });
  worker.addEventListener('error', (event) => {
    // A module that fails to load reports here, with every request unanswered.
    workerUnavailable = true;
    discardWorker();
    rejectAll(new Error(event?.message || 'Trip rescore worker failed to load.'));
  });
  return worker;
};

const computeInWorker = (input) => new Promise((resolve, reject) => {
  const requestId = ++nextRequestId;
  const timer = setTimeout(() => {
    if (!pending.delete(requestId)) return;
    discardWorker();
    rejectAll(new Error('Trip rescore worker timed out.'));
    reject(new Error('Trip rescore worker timed out.'));
  }, TRIP_RESCORE_WORKER_TIMEOUT_MS);
  pending.set(requestId, { resolve, reject, timer });
  ensureWorker().postMessage({ requestId, input });
});

const computeOnMainThread = (input, reason) => {
  if (!fallbackLogged) {
    fallbackLogged = true;
    logSystemFailure('trip_rescore_worker_fallback', new Error(reason));
  }
  return measureAsync('rescore.computeMainThread', async () => computeTripRescore(input));
};

/**
 * @param {Parameters<typeof computeTripRescore>[0]} input
 * @returns {Promise<ReturnType<typeof computeTripRescore>>}
 */
export async function computeTripRescoreOffMainThread(input) {
  if (workerUnavailable || typeof Worker === 'undefined') {
    return computeOnMainThread(input, 'Web Worker unavailable');
  }
  try {
    return await measureAsync('rescore.computeWorker', () => computeInWorker(input));
  } catch (error) {
    if (!workerUnavailable) throw error;
    return computeOnMainThread(input, error?.message || 'Trip rescore worker unavailable');
  }
}

/** Test seam: forget the worker and the fallback state. */
export const __resetTripRescoreWorkerForTests = () => {
  discardWorker();
  rejectAll(new Error('reset'));
  workerUnavailable = false;
  fallbackLogged = false;
};
