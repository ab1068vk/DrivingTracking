import { registerPlugin } from '@capacitor/core';
import { isAndroid } from '@/lib/nativePlatform';
import { privacyGatedFetch } from '@/lib/privacyGatedFetch';

const RoadDataQueue = registerPlugin('RoadDataQueue');
const POLL_INTERVAL_MS = 1000;
// The Android job runs after a randomized batching delay, so the poll has to
// outlast it. Without a ceiling a job that never reports back would spin here
// for the life of the app.
const RESULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

// The privacy gateway names services, the obfuscator queue names request tags.
const SERVICE_BY_TAG = Object.freeze({
  weather: 'open-meteo',
  overpass: 'overpass',
});

const DISCLOSURE_BY_SERVICE = Object.freeze({
  'open-meteo': 'rounded',
  overpass: 'bounding_box',
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stableRequestId(tag, request = {}) {
  const input = `${tag}|${request.method || 'GET'}|${request.url || ''}|${request.body || ''}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `road_${String(tag || 'location')}_${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}

export async function runNativeRoadDataRequest(tag, request, delayMs) {
  if (!isAndroid() || !request?.url) return null;

  // Android sends this over its own pinned HTTPS client, so the JS gateway never
  // sees the socket. Run the same coordinate inspection and transmission-log
  // write here, before handing the payload to the job queue.
  const service = SERVICE_BY_TAG[String(tag || '')] || String(tag || 'location');
  const gateResult = await privacyGatedFetch(service, {
    url: request.url,
    method: request.method || 'GET',
    headers: request.headers || {},
    body: request.body ?? null,
  }, {
    logOnly: true,
    type: 'Background road-data request',
    coordinateDisclosure: DISCLOSURE_BY_SERVICE[service] || 'raw',
    privacyVerificationEvidence: [
      'payload inspected by the privacy gateway before the Android job queue',
      'sent by the Android background job over pinned HTTPS',
    ],
    protections: ['timing obfuscation batch', 'Android certificate pinning'],
    status: 'safe',
  });
  // A blocked result means the gateway refused the payload; fall back to the
  // in-app queue, which applies the same checks before it would send anything.
  if (gateResult?.blocked) return null;

  const requestId = request.requestId || stableRequestId(tag, request);
  await RoadDataQueue.enqueue({
    requestId,
    url: request.url,
    method: request.method || 'GET',
    headers: request.headers || {},
    body: request.body ?? null,
    delayMs,
  });

  const deadline = Date.now() + Math.max(0, Number(delayMs) || 0) + RESULT_WAIT_TIMEOUT_MS;
  while (true) {
    const result = await RoadDataQueue.getResult({ requestId });
    if (result?.status === 'success') {
      await RoadDataQueue.remove({ requestId }).catch(() => {});
      try {
        return JSON.parse(result.body || 'null');
      } catch {
        throw new Error('Background road-data provider returned invalid JSON.');
      }
    }
    if (result?.status === 'error') {
      await RoadDataQueue.remove({ requestId }).catch(() => {});
      throw new Error(result.error || 'Background road-data request failed.');
    }
    if (Date.now() >= deadline) {
      await RoadDataQueue.remove({ requestId }).catch(() => {});
      throw new Error('Background road-data request did not report a result in time.');
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
