const SYSTEM_LOG_KEY = 'drivesense_system_logs_v1';
const SETTINGS_KEY = 'drivesense_settings';
export const SYSTEM_LOG_EVENT = 'drivesense:system-log-updated';
export const SYSTEM_LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const PRIVACY_LOG_DEFAULT_RETENTION_HOURS = 24;
export const PRIVACY_LOG_RETENTION_SETTING_KEY = 'privacy_log_retention_hours';
const MAX_STORED_LOGS = 2500;
const MAX_PENDING_LOGS = 500;
const FLUSH_DELAY_MS = 750;

let pendingLogs = [];
let flushTimer = null;
let initialized = false;
let fetchWrapped = false;
let lastScrollLogAt = 0;
let lastLongTaskLogAt = 0;

const safeNow = () => new Date().toISOString();
const SENSITIVE_DETAIL_KEY = /(^|[_-])(token|password|secret|auth|email|phone|address|lat|lng|longitude|latitude|coordinate|coordinates|route_points|driving_events|search|query|returnTo)($|[_-])|phone_number|phoneNumber|contact_phone|mobile_number/i;
const SENSITIVE_QUERY_KEY = /(^|[_-])(token|password|secret|auth|code|email|phone|address|lat|lng|longitude|latitude|coordinate|coordinates|returnTo)($|[_-])|phone_number|phoneNumber|contact_phone|mobile_number/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g;
const TOKEN_PAIR_PATTERN = /\b(access_token|refresh_token|id_token|token|password|secret|code)=([^&\s]+)/gi;
const PRIVACY_LOG_METADATA_KEY = /^(label|zone_id|zone_label|privacy_zone_id|privacy_zone_label|radius_m|source_radius_m|zone_radius_m|privacy_radius_m|privacy_zone_radius_m)$/i;

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

const parseLogs = (raw) => {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const readStoredLogs = () => {
  if (!canUseStorage()) return [];
  return parseLogs(localStorage.getItem(SYSTEM_LOG_KEY));
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
  event?.category === 'privacy'
    ? getPrivacyLogRetentionMs()
    : SYSTEM_LOG_RETENTION_MS
);

export function pruneExpiredSystemLogs(logs = readStoredLogs(), nowMs = Date.now()) {
  return logs
    .filter((event) => {
      const retentionMs = retentionMsForEvent(event);
      if (retentionMs <= 0) return false;
      return eventTimestamp(event) >= nowMs - retentionMs;
    })
    .sort((a, b) => eventTimestamp(b) - eventTimestamp(a))
    .slice(0, MAX_STORED_LOGS);
}

const writeStoredLogs = (logs, { notify = true } = {}) => {
  if (!canUseStorage()) return;
  try {
    const pruned = pruneExpiredSystemLogs(logs);
    localStorage.setItem(SYSTEM_LOG_KEY, JSON.stringify(pruned));
    if (notify && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent?.(new CustomEvent(SYSTEM_LOG_EVENT, { detail: { count: pruned.length } }));
    }
  } catch {
    try {
      localStorage.setItem(SYSTEM_LOG_KEY, JSON.stringify(pruneExpiredSystemLogs(logs).slice(0, Math.floor(MAX_STORED_LOGS / 2))));
    } catch {}
  }
};

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
    if (PRIVACY_LOG_METADATA_KEY.test(key)) return acc;
    acc[key] = stripPrivacyLogMetadata(item);
    return acc;
  }, {});
};

const flushPendingLogs = () => {
  flushTimer = null;
  if (!pendingLogs.length) return;
  const batch = pendingLogs;
  pendingLogs = [];
  const next = pruneExpiredSystemLogs([...batch, ...readStoredLogs()]);
  writeStoredLogs(next);
};

const scheduleFlush = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(flushPendingLogs, FLUSH_DELAY_MS);
};

export function recordSystemLog(event = {}) {
  const category = event.category || 'app';
  if (category === 'privacy' && getPrivacyLogRetentionMs() <= 0) {
    writeStoredLogs(readStoredLogs());
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
    details: category === 'privacy'
      ? stripPrivacyLogMetadata(sanitizedDetails)
      : sanitizedDetails,
  };

  pendingLogs.unshift(next);
  if (pendingLogs.length > MAX_PENDING_LOGS) pendingLogs = pendingLogs.slice(0, MAX_PENDING_LOGS);
  scheduleFlush();
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

export function getSystemLogs() {
  const logs = pruneExpiredSystemLogs(readStoredLogs());
  writeStoredLogs(logs, { notify: false });
  return logs;
}

export function clearSystemLogs() {
  pendingLogs = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  writeStoredLogs([]);
}

export function exportSystemLogsJson(logs = getSystemLogs()) {
  return JSON.stringify({
    exported_at: safeNow(),
    retention_days: 3,
    privacy_retention_hours: Math.round(getPrivacyLogRetentionMs() / (60 * 60 * 1000)),
    count: logs.length,
    logs,
  }, null, 2);
}

export function exportSystemLogsCsv(logs = getSystemLogs()) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ['timestamp', 'severity', 'category', 'source', 'operation', 'title', 'message', 'page', 'details'].map(escape).join(','),
    ...logs.map((event) => [
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

function logScrollEvent() {
  const now = Date.now();
  if (now - lastScrollLogAt < 2000) return;
  lastScrollLogAt = now;
  recordSystemLog({
    operation: 'user_scroll',
    title: 'User scroll',
    category: 'user_action',
    severity: 'info',
    message: 'Page scrolled',
    details: {
      scroll_x: Math.round(window.scrollX || 0),
      scroll_y: Math.round(window.scrollY || 0),
      viewport_height: window.innerHeight,
      document_height: document.documentElement?.scrollHeight,
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
  getSystemLogs();
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
  window.addEventListener('scroll', logScrollEvent, { passive: true });
  window.addEventListener('pagehide', () => recordSystemEvent('page_hidden', {}, { category: 'background' }));
  window.addEventListener('beforeunload', () => recordSystemEvent('page_unloading', {}, { category: 'background' }));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === 'Escape' || event.key === ' ') logDomEvent(event);
  }, true);
  window.addEventListener('online', () => recordSystemEvent('network_online', {}, { category: 'background' }));
  window.addEventListener('offline', () => recordSystemEvent('network_offline', {}, { category: 'background', severity: 'warn' }));
  document.addEventListener('visibilitychange', () => recordSystemEvent('document_visibility', {
    visibilityState: document.visibilityState,
  }, { category: 'background' }));
}
