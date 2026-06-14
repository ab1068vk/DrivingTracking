import { runNativeRoadDataRequest } from '@/lib/nativeRoadDataQueue';
import { pinnedFetch } from '@/lib/pinnedFetch';
import { localSettings } from '@/lib/trackingStore';

const BATCH_MIN_MS = 3 * 60 * 1000;
const BATCH_MAX_MS = 9 * 60 * 1000;
const INTER_REQUEST_MIN_MS = 800;
const INTER_REQUEST_MAX_MS = 3500;
const DECOY_MIN_COUNT = 1;
const DECOY_MAX_COUNT = 3;

let queue = [];
let timer = null;
let lastBatchAt = null;
let lastBatchSize = 0;
let initialized = false;

function randomUnit() {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return values[0] / 0x100000000;
  }
  return Math.random();
}

function randomInt(min, max) {
  return Math.floor(randomUnit() * (max - min + 1)) + min;
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fireFirstPartyDecoy() {
  try {
    await pinnedFetch('https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current_weather=true');
  } catch {
    // Decoys are best-effort and must not affect real request outcomes.
  }
}

function scheduleBatch() {
  const delay = randomInt(BATCH_MIN_MS, BATCH_MAX_MS);
  timer = setTimeout(flushBatch, delay);
}

async function flushBatch() {
  timer = null;
  const batch = queue;
  queue = [];
  if (!batch.length) return;

  const decoyMode = localSettings.get()?.decoy_traffic_mode || 'off';
  const decoys = decoyMode === 'first_party'
    ? Array.from(
      { length: randomInt(DECOY_MIN_COUNT, DECOY_MAX_COUNT) },
      () => ({ tag: 'decoy', fn: fireFirstPartyDecoy, resolve: null, reject: null })
    )
    : [];
  const items = shuffle([...batch, ...decoys]);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    try {
      const result = await item.fn();
      item.resolve?.(result);
    } catch (error) {
      item.reject?.(error);
    }
    if (index < items.length - 1) {
      await sleep(randomInt(INTER_REQUEST_MIN_MS, INTER_REQUEST_MAX_MS));
    }
  }
  lastBatchAt = Date.now();
  lastBatchSize = items.length;
  initialized = true;
}

export function enqueueLocationRequest(tag, fn, nativeRequest = null) {
  if (typeof fn !== 'function') {
    return Promise.reject(new TypeError('Location request must be a function.'));
  }
  if (localSettings.get()?.request_obfuscation_enabled === false) return fn();

  if (nativeRequest?.url) {
    const delay = randomInt(BATCH_MIN_MS, BATCH_MAX_MS);
    return runNativeRoadDataRequest(tag, nativeRequest, delay)
      .then((result) => result ?? enqueueLocationRequest(tag, fn))
      .catch(() => fn());
  }

  const result = new Promise((resolve, reject) => {
    queue.push({
      tag: String(tag || 'location'),
      fn,
      enqueuedAt: Date.now(),
      resolve,
      reject,
    });
  });
  if (!timer) scheduleBatch();
  return result;
}

export function resetRequestObfuscatorForTests() {
  if (timer) clearTimeout(timer);
  timer = null;
  queue = [];
  lastBatchAt = null;
  lastBatchSize = 0;
  initialized = false;
}

export function getObfuscatorQueueStatus() {
  const settings = localSettings.get();
  return {
    enabled: settings?.request_obfuscation_enabled !== false,
    decoyMode: settings?.decoy_traffic_mode || 'off',
    initialized,
    lastBatchAt,
    lastBatchSize,
  };
}

export const REQUEST_OBFUSCATION_TIMING = Object.freeze({
  batchMinMs: BATCH_MIN_MS,
  batchMaxMs: BATCH_MAX_MS,
  interRequestMinMs: INTER_REQUEST_MIN_MS,
  interRequestMaxMs: INTER_REQUEST_MAX_MS,
  decoyMinCount: DECOY_MIN_COUNT,
  decoyMaxCount: DECOY_MAX_COUNT,
});
