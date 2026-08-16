import {
  bufferSuppressedDiagnostics,
  closeP0Span,
  markP0SpanFailure,
  openP0Span,
  recordP0Phase,
  tagP0DiagnosticsJob,
} from '@/lib/p0Probe';
import { suppressDiagnosticsPersistence } from '@/lib/p0ProbeArms';

const TRIAGE_PREFIX = '[perf-triage]';

const p0Now = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);
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

const readPersistedEntries = (p0Span = null) => {
  if (!canUseStorage()) return [];
  const mark = () => (p0Span ? p0Now() : 0);
  try {
    const getStart = mark();
    const raw = localStorage.getItem(TRIAGE_STORAGE_KEY) || '[]';
    const getEnd = mark();
    // Committed before the parse: a parse that throws on a large corrupt store
    // still consumed the read time, and losing the row would make the failure
    // look free.
    if (p0Span) recordP0Phase(p0Span, 'diag_get', getStart, getEnd);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (p0Span) recordP0Phase(p0Span, 'diag_parse', getEnd, p0Now());
      throw error;
    }
    const parseEnd = mark();
    if (p0Span) recordP0Phase(p0Span, 'diag_parse', getEnd, parseEnd);
    if (!Array.isArray(parsed)) return [];
    if (p0Span) p0Span.entry_count_before = parsed.length;
    const cutoff = Date.now() - TRIAGE_RETENTION_MS;
    const transformed = parsed
      .map(sanitizeEntry)
      .filter((entry) => new Date(entry.at).getTime() >= cutoff)
      .slice(-MAX_PERSISTED_TRIAGE_ENTRIES);
    if (p0Span) recordP0Phase(p0Span, 'diag_transform', parseEnd, p0Now());
    return transformed;
  } catch {
    // Application behaviour is unchanged — a corrupt store still degrades to an
    // empty list. But the measurement must not call that a success.
    markP0SpanFailure(p0Span);
    return [];
  }
};

const persistEntry = (entry) => {
  if (!canUseStorage()) return;
  // P0 arms B/C short-circuit at job entry, before the first storage read and
  // before any full-history transform. Suppressing only the write would leave
  // the expensive parse/sanitize/filter/stringify in place and could produce a
  // false negative for the diagnostics hypothesis.
  if (suppressDiagnosticsPersistence()) {
    // The already-collected entry moves into the bounded volatile buffer rather
    // than being parsed, pruned, stringified and written.
    bufferSuppressedDiagnostics('performance_triage_persist', [entry]);
    return;
  }
  const p0Span = openP0Span('diagnostics_job');
  if (p0Span) tagP0DiagnosticsJob(p0Span, 'performance_triage_persist');
  let p0Outcome = 'error';
  try {
    const next = [...readPersistedEntries(p0Span), sanitizeEntry(entry)].slice(-MAX_PERSISTED_TRIAGE_ENTRIES);
    const stringifyStart = p0Span ? p0Now() : 0;
    const serialized = JSON.stringify(next);
    const stringifyEnd = p0Span ? p0Now() : 0;
    if (p0Span) {
      recordP0Phase(p0Span, 'diag_stringify', stringifyStart, stringifyEnd);
      // The string already exists; no encoder or second traversal is added.
      p0Span.serialized_code_units = serialized.length;
    }
    // A quota-exceeded write is a real and expensive failure mode for a store
    // this size. Its interval is recorded on both paths.
    try {
      localStorage.setItem(TRIAGE_STORAGE_KEY, serialized);
    } catch (error) {
      if (p0Span) recordP0Phase(p0Span, 'diag_set', stringifyEnd, p0Now());
      throw error;
    }
    if (p0Span) recordP0Phase(p0Span, 'diag_set', stringifyEnd, p0Now());
    p0Outcome = 'success';
  } catch {
    // Performance history is best-effort and must never disturb measured work.
    markP0SpanFailure(p0Span);
  } finally {
    // A read, parse, stringify or write failure closes the span as `error`.
    // Closing everything as `success` would have hidden failed persistence
    // behind a clean-looking measurement.
    if (p0Span) closeP0Span(p0Span, p0Outcome);
  }
};

if (canUseStorage()) {
  try {
    performanceContext = safeContext(JSON.parse(localStorage.getItem(TRIAGE_CONTEXT_KEY) || '{}'));
  } catch {
    performanceContext = {};
  }
}

/**
 * Context fields describing the on-device dataset. A caller may only supply
 * these once its trip query has resolved — see `setPerformanceTriageContext`.
 */
export const DATASET_CONTEXT_FIELDS = Object.freeze([
  'trip_count',
  'completed_trip_count',
  'total_distance_km',
  'route_point_count',
  'data_size_bytes',
]);

/**
 * I-1: dataset context is written only from a resolved trip query.
 *
 * This setter previously ran on the Diagnostics page's first render, while the
 * trip-profile query was still loading, and persisted `{trip_count: 0, ...}`.
 * That zeroed context was then stamped onto every measurement app-wide, which is
 * why no retained sample carried a usable dataset size.
 *
 * The gate is structural rather than heuristic: only keys the caller actually
 * supplies are applied, and the caller supplies dataset keys only once its query
 * has resolved. Inferring intent from the *values* — treating an all-zero
 * dataset as "still loading" — would keep stale counts forever on a device whose
 * trips were genuinely all deleted. A resolved zero is a real measurement and
 * must be recorded as one.
 *
 * The return shape is unchanged from before instrumentation.
 */
export function setPerformanceTriageContext(context = {}) {
  const merged = { ...performanceContext };
  Object.keys(context).forEach((key) => {
    if (context[key] !== undefined) merged[key] = context[key];
  });

  performanceContext = safeContext(merged);
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
