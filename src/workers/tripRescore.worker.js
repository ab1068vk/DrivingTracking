import { computeTripRescore } from '@/lib/tripRescoreCompute';

// DPD-031: the rescore's scoring runs here, off the renderer's main thread.
// Pure compute only - see src/lib/tripRescoreCompute.js.
self.addEventListener('message', (event) => {
  const { requestId, input } = event.data || {};
  const startedAt = performance.now();
  try {
    const result = computeTripRescore(input);
    self.postMessage({
      requestId,
      result,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error?.message || 'Trip rescore computation failed.',
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
  }
});
