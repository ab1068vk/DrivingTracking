import { buildSpeedMapSections } from '@/lib/speedLimitMapSections';

self.addEventListener('message', (event) => {
  const {
    requestId,
    trips = [],
    corrections = [],
    roadMemoryCandidates = [],
  } = event.data || {};
  const startedAt = performance.now();
  try {
    const sections = buildSpeedMapSections(trips, corrections, roadMemoryCandidates);
    self.postMessage({
      requestId,
      sections,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error?.message || 'Road-speed map construction failed.',
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
  }
});
