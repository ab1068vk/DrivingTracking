import { registerPlugin } from '@capacitor/core';
import { isAndroid } from '@/lib/nativePlatform';

const RoadDataQueue = registerPlugin('RoadDataQueue');
const POLL_INTERVAL_MS = 1000;

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
  const requestId = request.requestId || stableRequestId(tag, request);
  await RoadDataQueue.enqueue({
    requestId,
    url: request.url,
    method: request.method || 'GET',
    headers: request.headers || {},
    body: request.body ?? null,
    delayMs,
  });

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
    await sleep(POLL_INTERVAL_MS);
  }
}
