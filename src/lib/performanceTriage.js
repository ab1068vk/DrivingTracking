const TRIAGE_PREFIX = '[perf-triage]';
let measureSequence = 0;

const clock = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const safeMark = (name) => {
  try {
    performance?.mark?.(name);
  } catch {
    // Timing must never disturb the path being measured.
  }
};

export const TRIAGE_DISABLE_MAPS = import.meta.env.VITE_TRIAGE_DISABLE_MAPS === 'true';
export const TRIAGE_DASHBOARD_LIMITED_SUMMARIES = import.meta.env.VITE_TRIAGE_DASHBOARD_LIMITED_SUMMARIES === 'true';

export function beginMeasure(name, detail = {}) {
  const id = `${name}:${++measureSequence}`;
  const startedAt = clock();
  safeMark(`${id}:start`);
  let ended = false;

  return (endDetail = {}) => {
    if (ended) return null;
    ended = true;
    const durationMs = Math.round((clock() - startedAt) * 10) / 10;
    safeMark(`${id}:end`);
    try {
      performance?.measure?.(name, `${id}:start`, `${id}:end`);
    } catch {
      // Some older WebViews expose only part of the User Timing API.
    }
    const entry = {
      name,
      durationMs,
      at: new Date().toISOString(),
      ...detail,
      ...endDetail,
    };
    if (typeof window !== 'undefined') {
      window.__PERF_TRIAGE__ = window.__PERF_TRIAGE__ || [];
      window.__PERF_TRIAGE__.push(entry);
    }
    console.info(TRIAGE_PREFIX, JSON.stringify(entry));
    return entry;
  };
}

export async function measureAsync(name, task, detail = {}) {
  const end = beginMeasure(name, detail);
  try {
    const result = await task();
    end({ outcome: 'success' });
    return result;
  } catch (error) {
    end({ outcome: 'error', error: error?.message || String(error) });
    throw error;
  }
}

export function measureSync(name, task, detail = {}) {
  const end = beginMeasure(name, detail);
  try {
    const result = task();
    end({ outcome: 'success' });
    return result;
  } catch (error) {
    end({ outcome: 'error', error: error?.message || String(error) });
    throw error;
  }
}
