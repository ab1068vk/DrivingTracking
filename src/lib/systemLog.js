import { recordHistoricalAppExperienceEvent } from '@/lib/appExperienceDiagnostics';
import { createDiagnosticsHistoryStore } from '@/lib/diagnosticsHistoryStore';
import { suppressDiagnosticsPersistence } from '@/lib/p0ProbeArms';

const SYSTEM_LOG_KEY = 'drivesense_system_logs_v1';
const SETTINGS_KEY = 'drivesense_settings';
export const SYSTEM_LOG_EVENT = 'drivesense:system-log-updated';
export const SYSTEM_LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const PRIVACY_LOG_DEFAULT_RETENTION_HOURS = 24;
export const PRIVACY_LOG_RETENTION_SETTING_KEY = 'privacy_log_retention_hours';
const MAX_STORED_LOGS = 2500;
export const SYSTEM_LOG_PRIVACY_RULES_VERSION = 1;

let systemHistoryStore = null;
let privacyReconciliationPromise = null;
let privacyReconciliationRequested = false;
let initialized = false;
let fetchWrapped = false;
let lastLongTaskLogAt = 0;

export const resetSystemLogStorageForTests = () => {
  systemHistoryStore = null;
  privacyReconciliationPromise = null;
  privacyReconciliationRequested = false;
};

const safeNow = () => new Date().toISOString();
const SENSITIVE_DETAIL_KEY = /(^|[_-])(token|password|secret|auth|email|phone|address|lat|lng|longitude|latitude|coordinate|coordinates|route_points|driving_events|search|query|returnTo)($|[_-])|phone_number|phoneNumber|contact_phone|mobile_number/i;
const SENSITIVE_QUERY_KEY = /(^|[_-])(token|password|secret|auth|code|email|phone|address|lat|lng|longitude|latitude|coordinate|coordinates|returnTo)($|[_-])|phone_number|phoneNumber|contact_phone|mobile_number/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g;
const TOKEN_PAIR_PATTERN = /\b(access_token|refresh_token|id_token|token|password|secret|code)=([^&\s]+)/gi;
const PRIVACY_LOG_METADATA_KEY = /^(label|zone_id|zone_label|privacy_zone_id|privacy_zone_label|radius_m|source_radius_m|zone_radius_m|privacy_radius_m|privacy_zone_radius_m)$/i;
const PRIVACY_LOG_COLLECTION_KEY = /^(privacy_zone|privacy_zones)$/i;
const PRIVACY_OPERATION_PATTERN = /(^|_)privacy(_|$)|privacy_zone|privacy_zones|osrm_consent_invalidated/i;

const safeDecode = (value) => {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return value || '';
  }
};

const redactUrlSearchValues = (input) => input.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, prefix, key, value) => (
  SENSITIVE_QUERY_KEY.test(safeDecode(key))
    ? `${prefix}${key}=[redacted]`
    : `${prefix}${key}=${value ? '[value]' : ''}`
));

const redactSensitiveString = (value) => {
  const text = String(value || '');
  return redactUrlSearchValues(text)
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(PHONE_PATTERN, '[redacted-phone]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(TOKEN_PAIR_PATTERN, '$1=[redacted]')
    .slice(0, 500);
};

const canUseStorage = () => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
};

const eventTimestamp = (event) => {
  const ms = new Date(event?.timestamp || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

export function getPrivacyLogRetentionMs() {
  if (!canUseStorage()) return PRIVACY_LOG_DEFAULT_RETENTION_HOURS * 60 * 60 * 1000;
  try {
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const hours = Number(settings?.[PRIVACY_LOG_RETENTION_SETTING_KEY]);
    if (Number.isFinite(hours) && hours >= 0) return hours * 60 * 60 * 1000;
  } catch {}
  return PRIVACY_LOG_DEFAULT_RETENTION_HOURS * 60 * 60 * 1000;
}

const retentionMsForEvent = (event) => (
  isPrivacySensitiveLog(event)
    ? getPrivacyLogRetentionMs()
    : SYSTEM_LOG_RETENTION_MS
);

export function pruneExpiredSystemLogs(logs = [], nowMs = Date.now()) {
  return logs
    .filter((event) => !isSuppressedSystemLog(event))
    .filter((event) => {
      const retentionMs = retentionMsForEvent(event);
      if (retentionMs <= 0) return false;
      return eventTimestamp(event) >= nowMs - retentionMs;
    })
    .sort((a, b) => eventTimestamp(b) - eventTimestamp(a))
    .slice(0, MAX_STORED_LOGS);
}

const summarizeTarget = (target) => {
  if (!target || typeof target !== 'object') return {};
  const element = target.closest?.('button, a, input, select, textarea, [role="button"], [role="switch"], [role="checkbox"], [data-log-label]') || target;
  const tag = String(element.tagName || target.tagName || 'element').toLowerCase();
  const type = element.getAttribute?.('type') || element.type || '';
  const role = element.getAttribute?.('role') || '';
  const canUseVisibleLabel = ['button', 'a'].includes(tag) || Boolean(role) || Boolean(element.getAttribute?.('data-log-label'));
  const label = element.getAttribute?.('aria-label') ||
    element.getAttribute?.('data-log-label') ||
    element.title ||
    element.name ||
    element.id ||
    (canUseVisibleLabel ? String(element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) : '');
  const href = tag === 'a' ? element.getAttribute?.('href') : '';
  const valueLength = ['input', 'textarea', 'select'].includes(tag)
    ? String(element.value || '').length
    : undefined;

  return {
    tag,
    ...(type ? { type } : {}),
    ...(role ? { role } : {}),
    ...(label ? { label: redactSensitiveString(label).slice(0, 100) } : {}),
    ...(href ? { href: redactSensitiveString(href).slice(0, 160) } : {}),
    ...(element.checked != null ? { checked: Boolean(element.checked) } : {}),
    ...(valueLength != null ? { value_length: valueLength } : {}),
  };
};

const summarizeResourceTarget = (target) => {
  if (!target || typeof target !== 'object') return {};
  const tag = String(target.tagName || 'resource').toLowerCase();
  const source = target.currentSrc ||
    target.src ||
    target.href ||
    target.getAttribute?.('src') ||
    target.getAttribute?.('href') ||
    '';
  let origin = '';
  let pathname = '';
  try {
    const url = new URL(source, window.location.origin);
    origin = url.origin;
    pathname = url.pathname.slice(0, 240);
  } catch {}

  return {
    tag,
    ...(target.rel ? { rel: String(target.rel).slice(0, 80) } : {}),
    ...(target.as ? { as: String(target.as).slice(0, 80) } : {}),
    ...(target.type ? { type: String(target.type).slice(0, 80) } : {}),
    ...(origin ? { origin } : {}),
    ...(pathname ? { path: pathname } : {}),
  };
};

const sanitizePrimitive = (value) => {
  if (value == null) return value;
  if (typeof value === 'string') return redactSensitiveString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  return String(value).slice(0, 500);
};

export function sanitizeLogDetail(value, depth = 0) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return sanitizePrimitive(value);
  }
  if (depth >= 3) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeLogDetail(item, depth + 1));
  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      message: String(value.message || 'Unknown error').slice(0, 500),
      stack_preview: typeof value.stack === 'string'
        ? value.stack
          .split('\n')
          .slice(0, 3)
          .map((line) => line.replace(/https?:\/\/[^)\s]+/g, '[url]').replace(/[A-Z]:\\[^)\s]+/gi, '[path]'))
          .join('\n')
          .slice(0, 700)
        : '',
    };
  }
  if (typeof Event !== 'undefined' && value instanceof Event) {
    return {
      event_type: value.type,
      target: summarizeTarget(value.target),
    };
  }

  return Object.entries(value)
    .slice(0, 40)
    .reduce((acc, [key, item]) => {
      if (SENSITIVE_DETAIL_KEY.test(key)) {
        acc[key] = '[redacted]';
        return acc;
      }
      acc[key] = sanitizeLogDetail(item, depth + 1);
      return acc;
    }, {});
}

const stripPrivacyLogMetadata = (value) => {
  if (Array.isArray(value)) return value.map(stripPrivacyLogMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).reduce((acc, [key, item]) => {
    if (PRIVACY_LOG_METADATA_KEY.test(key) || PRIVACY_LOG_COLLECTION_KEY.test(key)) return acc;
    acc[key] = stripPrivacyLogMetadata(item);
    return acc;
  }, {});
};

const containsPrivacyLogMetadata = (value) => {
  if (Array.isArray(value)) return value.some(containsPrivacyLogMetadata);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (
    PRIVACY_LOG_METADATA_KEY.test(key) ||
    PRIVACY_LOG_COLLECTION_KEY.test(key) ||
    containsPrivacyLogMetadata(item)
  ));
};

const isPrivacySensitiveLog = (event = {}) => (
  event?.category === 'privacy' ||
  PRIVACY_OPERATION_PATTERN.test(String(event?.operation || event?.type || '')) ||
  containsPrivacyLogMetadata(event?.details)
);

const isSuppressedSystemLog = (event = {}) => {
  const operation = String(event.operation || event.type || '').toLowerCase();
  const eventType = String(event.details?.event_type || '').toLowerCase();
  return operation === 'user_scroll' || eventType === 'scroll';
};

const systemRecordOptions = (event) => {
  const payloadTimestampMs = eventTimestamp(event);
  const sensitive = isPrivacySensitiveLog(event);
  return {
    payloadTimestampMs,
    privacyClass: sensitive ? 'sensitive' : 'standard',
    privacyRulesVersion: SYSTEM_LOG_PRIVACY_RULES_VERSION,
    ...(!sensitive ? { expiresAtMs: payloadTimestampMs + SYSTEM_LOG_RETENTION_MS } : {}),
  };
};

const getSystemHistoryStore = () => {
  if (systemHistoryStore) return systemHistoryStore;
  systemHistoryStore = createDiagnosticsHistoryStore({
    kind: 'system_log',
    legacyKey: SYSTEM_LOG_KEY,
    capacity: MAX_STORED_LOGS,
    pendingCap: 500,
    flushDelayMs: 750,
    jobName: 'system_log_flush',
    orderIndex: 'by_kind_payload_time',
    orderWidth: 3,
    direction: 'prev',
    mapLegacy: (logs, nowMs) => pruneExpiredSystemLogs(logs, nowMs)
      .map((event) => ({ payload: event, options: systemRecordOptions(event) }))
      .reverse(),
    afterFlush: ({ batch }) => {
      if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
      // Consumers use this event as a refresh signal. Keep its bounded numeric
      // detail without counting the retained index on every ordinary flush.
      window.dispatchEvent?.(new CustomEvent(SYSTEM_LOG_EVENT, { detail: { count: batch.length } }));
    },
    finalizeRead: (records, nowMs) => {
      const privacyRetentionMs = getPrivacyLogRetentionMs();
      return records
        .filter((record) => !isSuppressedSystemLog(record.payload))
        .filter((record) => {
          const retentionMs = isPrivacySensitiveLog(record.payload)
            ? privacyRetentionMs
            : SYSTEM_LOG_RETENTION_MS;
          return retentionMs > 0 && record.payloadTimestampMs >= nowMs - retentionMs;
        })
        .sort((left, right) => right.payloadTimestampMs - left.payloadTimestampMs || right.ingestSeq - left.ingestSeq);
    },
  });
  return systemHistoryStore;
};

export const reconcileSystemLogPrivacyRetention = async () => {
  if (suppressDiagnosticsPersistence()) return;
  const repository = getSystemHistoryStore();
  const storage = repository.storage;
  const cursorKey = 'system_log_privacy_reclass_cursor';
  const rulesKey = 'system_log_privacy_rules_version';
  const storedVersion = Number(await storage.getMeta(rulesKey) ?? 0);
  let repeat = false;
  if (storedVersion !== SYSTEM_LOG_PRIVACY_RULES_VERSION) {
    const afterSeq = Number(await storage.getMeta(cursorKey) ?? 0);
    const records = await storage.readEventsByIndex('by_kind_ingest_seq', {
      range: {
        lower: ['system_log', Math.max(0, afterSeq + 1)],
        upper: ['system_log', Number.MAX_SAFE_INTEGER],
      },
      limit: 128,
    });
    if (records.length) {
      const updated = records.map((record) => {
        const sensitive = isPrivacySensitiveLog(record.payload);
        const next = {
          ...record,
          privacyClass: sensitive ? 'sensitive' : 'standard',
          privacyRulesVersion: SYSTEM_LOG_PRIVACY_RULES_VERSION,
        };
        if (sensitive) delete next.expiresAtMs;
        else next.expiresAtMs = record.payloadTimestampMs + SYSTEM_LOG_RETENTION_MS;
        return next;
      });
      await storage.putStoredEvents(updated);
      await storage.setMeta(cursorKey, records.at(-1).ingestSeq);
      // A subsequent bounded pass either continues or commits the version.
      repeat = true;
    } else {
      await storage.setMeta(rulesKey, SYSTEM_LOG_PRIVACY_RULES_VERSION);
      await storage.deleteMeta(cursorKey);
    }
  }

  const retentionMs = getPrivacyLogRetentionMs();
  const cutoff = retentionMs <= 0 ? Number.MAX_SAFE_INTEGER : Date.now() - retentionMs;
  const keys = await storage.readEventKeysByIndex('by_kind_privacy_time', {
    range: {
      lower: ['system_log', 'sensitive', Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
      upper: ['system_log', 'sensitive', cutoff, Number.MIN_SAFE_INTEGER],
      upperOpen: retentionMs > 0,
    },
    limit: 128,
  });
  if (keys.length) await storage.deleteEventUids(keys);
  if (keys.length === 128) repeat = true;
  return repeat;
};

const schedulePrivacyReconciliation = () => {
  if (suppressDiagnosticsPersistence()) return;
  if (privacyReconciliationPromise) {
    privacyReconciliationRequested = true;
    return;
  }
  privacyReconciliationPromise = reconcileSystemLogPrivacyRetention()
    .then((repeat) => { privacyReconciliationRequested ||= Boolean(repeat); })
    .catch(() => {})
    .finally(() => {
      privacyReconciliationPromise = null;
      if (privacyReconciliationRequested) {
        privacyReconciliationRequested = false;
        setTimeout(schedulePrivacyReconciliation, 0);
      }
    });
};

export function recordSystemLog(event = {}) {
  if (isSuppressedSystemLog(event)) return null;

  const category = event.category || 'app';
  const privacySensitive = isPrivacySensitiveLog({ ...event, category });
  if (privacySensitive && getPrivacyLogRetentionMs() <= 0) {
    schedulePrivacyReconciliation();
    return null;
  }

  const sanitizedDetails = sanitizeLogDetail(event.details || {});
  const next = {
    id: event.id || `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: event.timestamp || safeNow(),
    severity: event.severity || 'info',
    category,
    source: event.source || 'web',
    operation: event.operation || event.type || 'app_event',
    title: event.title || event.operation || 'App event',
    message: event.message || event.detail || '',
    page: event.page || (typeof window !== 'undefined' ? window.location?.pathname : ''),
    details: privacySensitive
      ? stripPrivacyLogMetadata(sanitizedDetails)
      : sanitizedDetails,
  };

  recordHistoricalAppExperienceEvent({
    ...next,
    ...(event.attributionState === 'observed' ? {
      attributionState: 'observed',
      sessionId: event.sessionId,
      buildScopeId: event.buildScopeId,
    } : {}),
  });

  try {
    getSystemHistoryStore().enqueue(next, {
      eventUid: `system_log:${next.id}`,
      ...systemRecordOptions(next),
    });
  } catch {}
  return next;
}

export function recordSystemEvent(operation, details = {}, options = {}) {
  return recordSystemLog({
    operation,
    title: options.title || operation.replace(/_/g, ' '),
    message: options.message || '',
    severity: options.severity || 'info',
    category: options.category || 'app',
    source: options.source || 'web',
    details,
  });
}

export function logSystemFailure(operation, error, details = {}) {
  const sanitizedError = sanitizeLogDetail(error);
  const message = sanitizedError?.message || String(error?.message || error || 'Unknown failure').slice(0, 500);
  return recordSystemLog({
    operation,
    title: `Operation failed: ${operation}`,
    message,
    severity: 'error',
    category: 'failure',
    details: {
      ...details,
      error: sanitizedError,
      reason: message,
    },
  });
}

export async function getSystemLogs() {
  try {
    const records = await getSystemHistoryStore().read();
    schedulePrivacyReconciliation();
    return records.map((record) => record.payload).slice(0, MAX_STORED_LOGS);
  } catch {
    return [];
  }
}

export function clearSystemLogs({ previousLogCount } = {}) {
  let cleared = false;
  try {
    cleared = getSystemHistoryStore().clear();
  } catch {}
  if (!cleared) return false;
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent?.(new CustomEvent(SYSTEM_LOG_EVENT, { detail: { count: 0 } }));
  }
  recordSystemEvent('system_logs_cleared', {
    ...(Number.isFinite(previousLogCount)
      ? { previous_log_count: Math.max(0, Math.floor(previousLogCount)) }
      : {}),
  }, {
    category: 'storage',
    severity: 'warn',
    title: 'System logs cleared',
  });
  return true;
}

export async function exportSystemLogsJson(logs) {
  const resolvedLogs = Array.isArray(logs) ? logs : await getSystemLogs();
  return JSON.stringify({
    exported_at: safeNow(),
    retention_days: 3,
    privacy_retention_hours: Math.round(getPrivacyLogRetentionMs() / (60 * 60 * 1000)),
    count: resolvedLogs.length,
    logs: resolvedLogs,
  }, null, 2);
}

export async function exportSystemLogsCsv(logs) {
  const resolvedLogs = Array.isArray(logs) ? logs : await getSystemLogs();
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ['timestamp', 'severity', 'category', 'source', 'operation', 'title', 'message', 'page', 'details'].map(escape).join(','),
    ...resolvedLogs.map((event) => [
      event.timestamp,
      event.severity,
      event.category,
      event.source,
      event.operation,
      event.title,
      event.message,
      event.page,
      JSON.stringify(event.details || {}),
    ].map(escape).join(',')),
  ];
  return rows.join('\n');
}

function logDomEvent(event) {
  const target = summarizeTarget(event.target);
  recordSystemLog({
    operation: `user_${event.type}`,
    title: `User ${event.type}`,
    category: 'user_action',
    severity: 'info',
    message: target.label || target.tag || event.type,
    details: {
      event_type: event.type,
      target,
      key: event.type === 'keydown' ? event.key : undefined,
      input_type: event.inputType,
    },
  });
}

function logControlEvent(event) {
  const target = summarizeTarget(event.target);
  if (!target.tag && !target.role && !target.label) return;
  recordSystemLog({
    operation: `user_${event.type}`,
    title: `User ${event.type}`,
    category: 'user_action',
    severity: 'info',
    message: target.label || target.tag || event.type,
    details: {
      event_type: event.type,
      target,
    },
  });
}

function logClipboardEvent(event) {
  const target = summarizeTarget(event.target);
  recordSystemLog({
    operation: `user_${event.type}`,
    title: `User ${event.type}`,
    category: 'user_action',
    severity: 'info',
    message: target.label || target.tag || event.type,
    details: {
      event_type: event.type,
      target,
      data_types: Array.from(event.clipboardData?.types || []),
    },
  });
}

function initializePerformanceFailureLogging() {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver((list) => {
      const now = Date.now();
      if (now - lastLongTaskLogAt < 5000) return;
      const longest = list.getEntries().reduce((best, entry) => (
        !best || entry.duration > best.duration ? entry : best
      ), null);
      if (!longest || longest.duration < 80) return;
      lastLongTaskLogAt = now;
      recordSystemLog({
        operation: 'browser_long_task',
        title: 'Long browser task detected',
        category: 'performance',
        severity: 'warn',
        message: `${Math.round(longest.duration)} ms main-thread task`,
        details: {
          duration_ms: Math.round(longest.duration),
          start_time_ms: Math.round(longest.startTime),
        },
      });
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {}
}

function initializeFetchFailureLogging() {
  if (fetchWrapped || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  fetchWrapped = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const startedAt = Date.now();
    const requestInfo = args[0];
    const requestInit = args[1];
    const requestMethod = requestInit?.method ||
      (requestInfo instanceof Request ? requestInfo.method : 'GET');
    try {
      const response = await originalFetch(...args);
      if (!response.ok) {
        let url = '';
        try {
          url = requestInfo instanceof Request
            ? requestInfo.url
            : requestInfo instanceof URL
              ? requestInfo.href
              : String(requestInfo || '');
          url = url ? new URL(url, window.location.origin).origin : '';
        } catch {}
        recordSystemLog({
          operation: 'fetch_non_ok',
          title: 'Operation failed: fetch',
          category: 'failure',
          severity: 'error',
          message: `HTTP ${response.status}`,
          details: {
            status: response.status,
            statusText: response.statusText,
            method: requestMethod,
            origin: url,
            duration_ms: Date.now() - startedAt,
          },
        });
      }
      return response;
    } catch (error) {
      logSystemFailure('fetch', error, {
        method: requestMethod,
        duration_ms: Date.now() - startedAt,
      });
      throw error;
    }
  };
}

function logResourceLoadFailure(event) {
  if (!event?.target || event.target === window) return;
  const resource = summarizeResourceTarget(event.target);
  if (!resource.tag || resource.tag === 'window') return;
  recordSystemLog({
    operation: 'resource_load_failed',
    title: 'Operation failed: resource_load',
    category: 'load',
    severity: 'error',
    message: `${resource.tag} failed to load`,
    details: {
      resource,
      reason: `${resource.tag} load event failed`,
    },
  });
}

export function initializeSystemLogging() {
  if (typeof window === 'undefined' || initialized) return;
  initialized = true;
  getSystemHistoryStore().startBackgroundMigration();
  schedulePrivacyReconciliation();
  initializeFetchFailureLogging();
  initializePerformanceFailureLogging();

  window.addEventListener('error', logResourceLoadFailure, true);
  document.addEventListener('securitypolicyviolation', (event) => recordSystemLog({
    operation: 'content_security_policy_violation',
    title: 'Operation failed: content_security_policy',
    category: 'load',
    severity: 'error',
    message: event.violatedDirective || 'Content security policy blocked a resource.',
    details: {
      violatedDirective: event.violatedDirective,
      effectiveDirective: event.effectiveDirective,
      blockedURI: summarizeResourceTarget({ src: event.blockedURI, tagName: 'blocked-resource' }),
      disposition: event.disposition,
      statusCode: event.statusCode,
    },
  }));
  document.addEventListener('click', logDomEvent, true);
  document.addEventListener('contextmenu', logDomEvent, true);
  document.addEventListener('change', logDomEvent, true);
  document.addEventListener('input', logDomEvent, true);
  document.addEventListener('submit', logDomEvent, true);
  document.addEventListener('invalid', logControlEvent, true);
  document.addEventListener('focusin', logControlEvent, true);
  document.addEventListener('focusout', logControlEvent, true);
  document.addEventListener('copy', logClipboardEvent, true);
  document.addEventListener('cut', logClipboardEvent, true);
  document.addEventListener('paste', logClipboardEvent, true);
  window.addEventListener('pagehide', () => recordSystemEvent('page_hidden', {}, { category: 'background' }));
  window.addEventListener('beforeunload', () => recordSystemEvent('page_unloading', {}, { category: 'background' }));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === 'Escape' || event.key === ' ') logDomEvent(event);
  }, true);
  window.addEventListener('online', () => recordSystemEvent('network_online', {}, { category: 'background' }));
  window.addEventListener('offline', () => recordSystemEvent('network_offline', {}, { category: 'background', severity: 'warn' }));
  window.addEventListener('roadsage-settings-changed', schedulePrivacyReconciliation);
  window.addEventListener('storage', (event) => {
    if (event.key === SETTINGS_KEY) schedulePrivacyReconciliation();
  });
  document.addEventListener('visibilitychange', () => recordSystemEvent('document_visibility', {
    visibilityState: document.visibilityState,
  }, { category: 'background' }));
}
