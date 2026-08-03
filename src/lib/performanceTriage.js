const TRIAGE_PREFIX = '[perf-triage]';
const MAX_TRIAGE_ENTRIES = 250;
const MAX_PERSISTED_TRIAGE_ENTRIES = 2500;
const TRIAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const TRIAGE_STORAGE_KEY = 'roadsage_performance_history_v1';
const TRIAGE_CONTEXT_KEY = 'roadsage_performance_context_v1';
export const PERFORMANCE_CHECKPOINT_EVENT = 'roadsage:performance-checkpoint';
let measureSequence = 0;
let performanceContext = {};
const sessionId = `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

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

const canUseStorage = () => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
};

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const safePathname = (value) => {
  const pathname = String(value || '').split(/[?#]/)[0];
  if (!pathname.startsWith('/')) return '';
  const segments = pathname.split('/');
  return segments.map((segment, index) => (
    index > 0 && segments[index - 1] === 'trips' ? ':id' : segment
  )).join('/').slice(0, 160);
};

const emitPerformanceCheckpoint = (operation, phase, pathname = '') => {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(PERFORMANCE_CHECKPOINT_EVENT, {
      detail: {
        operation: String(operation || 'unknown').replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 140),
        phase: ['start', 'success', 'error', 'painted', 'cancelled'].includes(phase) ? phase : 'unknown',
        pathname: safePathname(pathname || window.location?.pathname),
      },
    }));
  } catch {
    // Native watchdog checkpoints are best-effort.
  }
};

const safeContext = (value = {}) => ({
  trip_count: Math.max(0, Math.floor(finite(value.trip_count) ?? finite(value.tripCount) ?? 0)),
  completed_trip_count: Math.max(0, Math.floor(finite(value.completed_trip_count) ?? finite(value.completedTripCount) ?? 0)),
  total_distance_km: Math.max(0, Math.round((finite(value.total_distance_km) ?? finite(value.totalDistanceKm) ?? 0) * 10) / 10),
  route_point_count: Math.max(0, Math.floor(finite(value.route_point_count) ?? finite(value.routePointCount) ?? 0)),
  data_size_bytes: Math.max(0, Math.floor(finite(value.data_size_bytes) ?? finite(value.dataSizeBytes) ?? 0)),
  experience_mode: ['coaching', 'tracking'].includes(value.experience_mode) ? value.experience_mode : undefined,
  tracking_mode: ['manual', 'auto_detect', 'background_auto', 'paused'].includes(value.tracking_mode) ? value.tracking_mode : undefined,
});

const sanitizeEntry = (entry = {}) => ({
  id: String(entry.id || `${sessionId}_${++measureSequence}`).slice(0, 100),
  sessionId: String(entry.sessionId || sessionId).slice(0, 100),
  name: String(entry.name || 'unknown').replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 140),
  durationMs: Math.max(0, Math.round((finite(entry.durationMs) || 0) * 10) / 10),
  at: Number.isFinite(new Date(entry.at).getTime()) ? new Date(entry.at).toISOString() : new Date().toISOString(),
  pathname: safePathname(entry.pathname),
  outcome: ['success', 'error', 'painted', 'cancelled'].includes(entry.outcome) ? entry.outcome : 'unknown',
  context: safeContext(entry.context || entry),
});

const readPersistedEntries = () => {
  if (!canUseStorage()) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(TRIAGE_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - TRIAGE_RETENTION_MS;
    return parsed
      .map(sanitizeEntry)
      .filter((entry) => new Date(entry.at).getTime() >= cutoff)
      .slice(-MAX_PERSISTED_TRIAGE_ENTRIES);
  } catch {
    return [];
  }
};

const persistEntry = (entry) => {
  if (!canUseStorage()) return;
  try {
    const next = [...readPersistedEntries(), sanitizeEntry(entry)].slice(-MAX_PERSISTED_TRIAGE_ENTRIES);
    localStorage.setItem(TRIAGE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Performance history is best-effort and must never disturb measured work.
  }
};

if (canUseStorage()) {
  try {
    performanceContext = safeContext(JSON.parse(localStorage.getItem(TRIAGE_CONTEXT_KEY) || '{}'));
  } catch {
    performanceContext = {};
  }
}

export function setPerformanceTriageContext(context = {}) {
  performanceContext = safeContext({ ...performanceContext, ...context });
  if (canUseStorage()) {
    try {
      localStorage.setItem(TRIAGE_CONTEXT_KEY, JSON.stringify(performanceContext));
    } catch {}
  }
  return { ...performanceContext };
}

export const TRIAGE_DISABLE_MAPS = import.meta.env.VITE_TRIAGE_DISABLE_MAPS === 'true';
export const TRIAGE_DASHBOARD_LIMITED_SUMMARIES = import.meta.env.VITE_TRIAGE_DASHBOARD_LIMITED_SUMMARIES === 'true';
export const TRIAGE_LOGS_ENABLED = import.meta.env.DEV || import.meta.env.VITE_PERF_TRIAGE_LOGS === 'true';

export function beginMeasure(name, detail = {}) {
  const id = `${name}:${++measureSequence}`;
  const startedAt = clock();
  emitPerformanceCheckpoint(name, 'start', detail.pathname);
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
      id: `${sessionId}_${++measureSequence}`,
      sessionId,
      name,
      durationMs,
      at: new Date().toISOString(),
      ...detail,
      ...endDetail,
      context: safeContext({ ...performanceContext, ...detail.context, ...endDetail.context }),
    };
    const sanitizedEntry = sanitizeEntry(entry);
    emitPerformanceCheckpoint(name, sanitizedEntry.outcome, sanitizedEntry.pathname || detail.pathname);
    if (typeof window !== 'undefined') {
      window.__PERF_TRIAGE__ = window.__PERF_TRIAGE__ || [];
      window.__PERF_TRIAGE__.push(sanitizedEntry);
      if (window.__PERF_TRIAGE__.length > MAX_TRIAGE_ENTRIES) {
        window.__PERF_TRIAGE__.splice(0, window.__PERF_TRIAGE__.length - MAX_TRIAGE_ENTRIES);
      }
    }
    persistEntry(sanitizedEntry);
    if (TRIAGE_LOGS_ENABLED) {
      console.info(TRIAGE_PREFIX, JSON.stringify(sanitizedEntry));
    }
    return sanitizedEntry;
  };
}

export function getPerformanceTriageEntries({ includeHistory = true } = {}) {
  const sessionEntries = typeof window === 'undefined' || !Array.isArray(window.__PERF_TRIAGE__)
    ? []
    : window.__PERF_TRIAGE__.filter((entry) => (
    entry && typeof entry.name === 'string' && Number.isFinite(Number(entry.durationMs))
    )).map(sanitizeEntry);
  if (!includeHistory) return sessionEntries;
  const byId = new Map();
  [...readPersistedEntries(), ...sessionEntries].forEach((entry) => byId.set(entry.id, entry));
  return [...byId.values()].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

export function clearPerformanceTriageHistory() {
  if (typeof window !== 'undefined') window.__PERF_TRIAGE__ = [];
  if (canUseStorage()) localStorage.removeItem(TRIAGE_STORAGE_KEY);
}

const percentile = (values, ratio) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
};

const thresholdsForName = (name = '') => {
  if (/maintenance|migration|retention|rescor/i.test(name)) return { watch: 3000, slow: 10000 };
  if (/firstPaint|render|draw|build/i.test(name)) return { watch: 500, slow: 1200 };
  return { watch: 600, slow: 1500 };
};

export function summarizePerformanceTriage(entries = getPerformanceTriageEntries(), { limit = 12 } = {}) {
  const groups = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const pathname = String(entry.pathname || '');
    const key = pathname ? `${entry.name}:${pathname}` : entry.name;
    const current = groups.get(key) || {
      key,
      name: entry.name,
      pathname: pathname || null,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      latestMs: 0,
      latestAt: null,
      durations: [],
      entries: [],
    };
    const durationMs = Math.max(0, Number(entry.durationMs) || 0);
    current.count += 1;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    current.latestMs = durationMs;
    current.latestAt = entry.at || null;
    current.durations.push(durationMs);
    current.entries.push(entry);
    groups.set(key, current);
  });
  return [...groups.values()]
    .map((item) => {
      const p50Ms = Math.round(percentile(item.durations, 0.5) * 10) / 10;
      const p95Ms = Math.round(percentile(item.durations, 0.95) * 10) / 10;
      const recent = item.entries.slice(-Math.max(1, Math.ceil(item.entries.length / 3)));
      const earlier = item.entries.slice(0, Math.max(0, item.entries.length - recent.length));
      const recentAverageMs = recent.reduce((sum, entry) => sum + Number(entry.durationMs || 0), 0) / recent.length;
      const earlierAverageMs = earlier.length
        ? earlier.reduce((sum, entry) => sum + Number(entry.durationMs || 0), 0) / earlier.length
        : 0;
      const trendPercent = earlierAverageMs > 0
        ? Math.round(((recentAverageMs - earlierAverageMs) / earlierAverageMs) * 100)
        : 0;
      const thresholds = thresholdsForName(item.name);
      const representativeMs = item.count < 4 ? item.maxMs : p95Ms;
      const latestContext = item.entries[item.entries.length - 1]?.context || {};
      const { durations, entries, ...publicItem } = item;
      return {
        ...publicItem,
        averageMs: Math.round((item.totalMs / Math.max(1, item.count)) * 10) / 10,
        maxMs: Math.round(item.maxMs * 10) / 10,
        latestMs: Math.round(item.latestMs * 10) / 10,
        p50Ms,
        p95Ms,
        trendPercent,
        latestContext,
        status: representativeMs > thresholds.slow ? 'slow' : representativeMs > thresholds.watch ? 'watch' : 'good',
      };
    })
    .sort((a, b) => {
      const rank = { slow: 3, watch: 2, good: 1 };
      return rank[b.status] - rank[a.status] || b.p95Ms - a.p95Ms || b.latestMs - a.latestMs;
    })
    .slice(0, Math.max(1, Number(limit) || 12));
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
