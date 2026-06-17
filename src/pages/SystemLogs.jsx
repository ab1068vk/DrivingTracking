import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Download,
  Filter,
  FileJson,
  RefreshCw,
  Search,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import {
  clearSystemLogs,
  exportSystemLogsCsv,
  exportSystemLogsJson,
  getSystemLogs,
  getPrivacyLogRetentionMs,
  logSystemFailure,
  recordSystemEvent,
  SYSTEM_LOG_EVENT,
  SYSTEM_LOG_RETENTION_MS,
} from '@/lib/systemLog';
import { getNativeDiagnostics } from '@/lib/activityRecognition';
import { isAndroid, isNativePlatform } from '@/lib/nativePlatform';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import {
  getTrackingDiagnostics,
  normalizeNativeDiagnosticEvents,
} from '@/lib/trackingDiagnostics';
import useLocalSettings from '@/hooks/useLocalSettings';

const severityStyle = {
  error: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300',
  warn: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-900/60 dark:bg-yellow-950/30 dark:text-yellow-300',
  info: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300',
};

const categoryLabels = {
  all: 'All',
  failure: 'Failures',
  user_action: 'User actions',
  navigation: 'Navigation',
  diagnostics: 'Diagnostics',
  load: 'Load failures',
  performance: 'Performance',
  permission: 'Permissions',
  background: 'Background',
  settings: 'Settings',
  privacy: 'Privacy',
  weather: 'Weather',
  osrm: 'OSRM',
  storage: 'Storage',
  notification: 'Notifications',
  calibration: 'Calibration',
  app: 'App',
};

const categoryOptions = Object.keys(categoryLabels);
const LOG_PAGE_SIZE = 50;
const DIAGNOSTIC_DECISION_LIMIT = 120;
const timeRangeOptions = [
  { id: 'all', label: 'Any time', ms: Infinity },
  { id: '15m', label: 'Last 15 min', ms: 15 * 60 * 1000 },
  { id: '1h', label: 'Last hour', ms: 60 * 60 * 1000 },
  { id: '6h', label: 'Last 6 hours', ms: 6 * 60 * 60 * 1000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
];

const quickFilterOptions = [
  { id: 'all', label: 'Everything' },
  { id: 'problems', label: 'Problems' },
  { id: 'backups', label: 'Backups' },
  { id: 'exports', label: 'Imports/exports' },
  { id: 'native', label: 'Android/native' },
  { id: 'background', label: 'Background' },
];

function diagnosticEventToLog(event = {}, sourcePrefix = 'diagnostic') {
  return {
    id: `${sourcePrefix}_${event.id || event.timestamp || Math.random().toString(36).slice(2)}`,
    timestamp: event.timestamp || new Date().toISOString(),
    severity: event.type === 'operation_error' ? 'error' : event.status === 'bad' ? 'warn' : 'info',
    category: 'diagnostics',
    source: event.source || (sourcePrefix === 'native' ? 'android' : 'web'),
    operation: event.context || event.type || 'tracking_diagnostic',
    title: event.title || event.type || 'Tracking diagnostic',
    message: event.detail || event.reason || '',
    page: '/diagnostics',
    details: {
      type: event.type,
      reason: event.reason,
      speed_kmh: event.speed_kmh,
      stopped_seconds: event.stopped_seconds,
      drift_m: event.drift_m,
      context: event.context,
    },
  };
}

function mergeLogs(...groups) {
  const byId = new Map();
  groups.flat().forEach((event) => {
    if (!event?.id) return;
    if (!byId.has(event.id)) byId.set(event.id, event);
  });
  return [...byId.values()]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function getWebDiagnosticLogs() {
  try {
    return (getTrackingDiagnostics().events || []).map((event) => diagnosticEventToLog(event, 'web_diagnostic'));
  } catch (error) {
    logSystemFailure('system_logs_web_diagnostics_load', error);
    return [];
  }
}

function getLocalLogSnapshot() {
  let systemLogs = [];
  try {
    systemLogs = getSystemLogs();
  } catch (error) {
    logSystemFailure('system_logs_local_load', error);
  }
  return mergeLogs(systemLogs, getWebDiagnosticLogs());
}

async function getFullLogSnapshot() {
  const baseLogs = getLocalLogSnapshot();
  if (!isAndroid()) return baseLogs;
  try {
    const nativeDiagnostics = await getNativeDiagnostics();
    const nativeLogs = normalizeNativeDiagnosticEvents(nativeDiagnostics)
      .map((event) => diagnosticEventToLog(event, 'native_diagnostic'));
    return mergeLogs(baseLogs, nativeLogs);
  } catch (error) {
    logSystemFailure('system_logs_native_diagnostics_load', error);
    return baseLogs;
  }
}

function formatLogTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'time unknown';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

async function exportLogText({ filename, text, mimeType, format, logCount }) {
  let nativeFallbackError = null;
  if (isNativePlatform()) {
    try {
      const result = await saveExportToDownloads({ filename, data: text, mimeType });
      recordSystemEvent('system_logs_exported', {
        format,
        native: true,
        log_count: logCount,
        byte_count: text.length,
      }, { category: 'storage', title: 'System logs exported' });
      return { native: true, filename, uri: result.uri };
    } catch (error) {
      nativeFallbackError = error?.message || 'Native log export failed.';
      logSystemFailure('system_logs_native_export', error, {
        format,
        mime_type: mimeType,
        byte_count: text.length,
      });
    }
  }

  try {
    downloadText(filename, text, mimeType);
    recordSystemEvent('system_logs_exported', {
      format,
      native: false,
      native_fallback: Boolean(nativeFallbackError),
      log_count: logCount,
      byte_count: text.length,
    }, { category: 'storage', title: 'System logs exported' });
    return { native: false, filename, nativeFallback: Boolean(nativeFallbackError), nativeFallbackError };
  } catch (error) {
    logSystemFailure('system_logs_browser_export', error, {
      format,
      mime_type: mimeType,
      native_fallback: Boolean(nativeFallbackError),
      byte_count: text.length,
    });
    throw error;
  }
}

function detailSummary(details = {}) {
  if (!details || typeof details !== 'object') return '';
  const detailRecord = /** @type {Record<string, any>} */ (details);
  const reason = detailRecord.reason || detailRecord.error?.message || detailRecord.statusText || detailRecord.target?.label;
  if (reason) return String(reason);
  const keys = Object.keys(details).slice(0, 4);
  return keys.map((key) => `${key}: ${JSON.stringify(details[key])}`).join(' | ');
}

function searchableDetailText(details = {}) {
  try {
    return JSON.stringify(details || {}).slice(0, 2000);
  } catch {
    return detailSummary(details);
  }
}

function safeEventTime(event) {
  const ms = new Date(event?.timestamp || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isDiagnosticSnapshotLog(event = {}) {
  const id = String(event.id || '');
  return id.startsWith('web_diagnostic_') || id.startsWith('native_diagnostic_');
}

function formatRelativeDuration(ms) {
  if (!Number.isFinite(ms)) return 'soon';
  if (ms <= 0) return 'now';
  const minutes = Math.ceil(ms / (60 * 1000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  return `${Math.ceil(hours / 24)} days`;
}

function formatDeletionTime(timestamp) {
  const logTime = safeEventTime({ timestamp });
  if (!logTime) return null;
  const deleteAt = logTime + SYSTEM_LOG_RETENTION_MS;
  const date = new Date(deleteAt);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    relative: formatRelativeDuration(deleteAt - Date.now()),
    absolute: date.toLocaleString(),
  };
}

function normalizeOptionValue(value) {
  return String(value || '').trim() || 'unknown';
}

function sortOptionValues(values = []) {
  return [...new Set(values.map(normalizeOptionValue))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function matchesQuickFilter(event = {}, quickFilter = 'all') {
  const operation = String(event.operation || '').toLowerCase();
  const source = String(event.source || '').toLowerCase();
  if (quickFilter === 'problems') {
    return event.severity === 'error' || event.severity === 'warn' || ['failure', 'load', 'performance'].includes(event.category);
  }
  if (quickFilter === 'exports') {
    return /(export|import|backup|csv|pdf|download)/i.test(operation);
  }
  if (quickFilter === 'backups') {
    return operation.includes('backup');
  }
  if (quickFilter === 'native') {
    return source === 'android' || source === 'native' || operation.includes('native') || operation.includes('android');
  }
  if (quickFilter === 'background') {
    return ['background', 'storage', 'notification'].includes(event.category);
  }
  return true;
}

function LogRow({ event, index }) {
  const Icon = event.severity === 'error' ? XCircle : event.severity === 'warn' ? AlertTriangle : CheckCircle2;
  const summary = detailSummary(event.details);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.015, 0.2) }}
      className="rounded-xl border border-border bg-card p-3"
    >
      <div className="flex gap-3">
        <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg bg-secondary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{event.title || event.operation}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{formatLogTime(event.timestamp)}</div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase ${severityStyle[event.severity] || severityStyle.info}`}>
                {event.severity || 'info'}
              </span>
              <span className="rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-[11px] font-bold uppercase text-muted-foreground">
                {categoryLabels[event.category] || event.category || 'app'}
              </span>
              <span className="rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-[11px] font-bold uppercase text-muted-foreground">
                {event.source || 'web'}
              </span>
            </div>
          </div>
          {event.message && <div className="mt-2 text-sm text-foreground">{event.message}</div>}
          {summary && <div className="mt-1 break-words text-xs text-muted-foreground">{summary}</div>}
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span>Operation: {event.operation}</span>
            {event.page && <span>Page: {event.page}</span>}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export default function SystemLogs() {
  const settings = useLocalSettings();
  const [logs, setLogs] = useState(() => getLocalLogSnapshot());
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [quickFilter, setQuickFilter] = useState('all');
  const [timeRange, setTimeRange] = useState('all');
  const [source, setSource] = useState('all');
  const [operation, setOperation] = useState('all');
  const [pageFilter, setPageFilter] = useState('all');
  const [sortOrder, setSortOrder] = useState('newest');
  const [visibleCount, setVisibleCount] = useState(LOG_PAGE_SIZE);
  const [exportStatus, setExportStatus] = useState('');

  const refresh = () => {
    try {
      setLogs(getLocalLogSnapshot());
    } catch (error) {
      logSystemFailure('system_logs_refresh_local', error);
    }
    getFullLogSnapshot()
      .then(setLogs)
      .catch((error) => {
        logSystemFailure('system_logs_refresh', error);
      });
  };

  useEffect(() => {
    refresh();
    const onLogUpdate = () => refresh();
    window.addEventListener(SYSTEM_LOG_EVENT, onLogUpdate);
    const interval = setInterval(refresh, 5000);
    return () => {
      window.removeEventListener(SYSTEM_LOG_EVENT, onLogUpdate);
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    setVisibleCount(LOG_PAGE_SIZE);
  }, [query, category, severity, quickFilter, timeRange, source, operation, pageFilter, sortOrder]);

  const filterOptions = useMemo(() => ({
    sources: sortOptionValues(logs.map((event) => event.source)),
    operations: sortOptionValues(logs.map((event) => event.operation)),
    pages: sortOptionValues(logs.map((event) => event.page).filter(Boolean)),
  }), [logs]);

  const searchableLogs = useMemo(() => logs.map((event) => ({
    event,
    searchText: [
      event.title,
      event.message,
      event.operation,
      event.category,
      event.source,
      event.page,
      detailSummary(event.details),
      searchableDetailText(event.details),
    ].map((value) => String(value || '').toLowerCase()).join('\n'),
  })), [logs]);

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase();
    const range = timeRangeOptions.find((option) => option.id === timeRange) || timeRangeOptions[0];
    const cutoff = range.ms === Infinity ? 0 : Date.now() - range.ms;
    const filtered = searchableLogs.filter(({ event, searchText }) => {
      if (category !== 'all' && event.category !== category) return false;
      if (severity !== 'all' && event.severity !== severity) return false;
      if (source !== 'all' && normalizeOptionValue(event.source) !== source) return false;
      if (operation !== 'all' && normalizeOptionValue(event.operation) !== operation) return false;
      if (pageFilter !== 'all' && normalizeOptionValue(event.page) !== pageFilter) return false;
      if (cutoff && safeEventTime(event) < cutoff) return false;
      if (!matchesQuickFilter(event, quickFilter)) return false;
      if (!q) return true;
      return searchText.includes(q);
    }).map(({ event }) => event);
    return filtered.sort((a, b) => {
      const diff = safeEventTime(b) - safeEventTime(a);
      return sortOrder === 'oldest' ? -diff : diff;
    });
  }, [searchableLogs, query, category, severity, source, operation, pageFilter, timeRange, quickFilter, sortOrder]);

  const visibleLogs = useMemo(
    () => filteredLogs.slice(0, visibleCount),
    [filteredLogs, visibleCount]
  );

  const counts = useMemo(() => ({
    total: logs.length,
    errors: logs.filter((event) => event.severity === 'error').length,
    warnings: logs.filter((event) => event.severity === 'warn').length,
    backups: logs.filter((event) => String(event.operation || '').toLowerCase().includes('backup')).length,
    actions: logs.filter((event) => event.category === 'user_action').length,
  }), [logs]);

  const retentionSummary = useMemo(() => {
    const systemStoredLogs = logs.filter((event) => !isDiagnosticSnapshotLog(event));
    const diagnosticsLogs = logs.filter((event) => event.category === 'diagnostics' || isDiagnosticSnapshotLog(event));
    const oldestSystemLog = systemStoredLogs
      .filter((event) => safeEventTime(event))
      .sort((a, b) => safeEventTime(a) - safeEventTime(b))[0];
    return {
      systemCount: systemStoredLogs.length,
      diagnosticsCount: diagnosticsLogs.length,
      nextDeletion: oldestSystemLog ? formatDeletionTime(oldestSystemLog.timestamp) : null,
    };
  }, [logs]);
  const privacyRetentionHours = useMemo(
    () => Math.round(getPrivacyLogRetentionMs() / (60 * 60 * 1000)),
    [settings.privacy_log_retention_hours]
  );

  const activeFilterCount = [
    query.trim(),
    category !== 'all',
    severity !== 'all',
    quickFilter !== 'all',
    timeRange !== 'all',
    source !== 'all',
    operation !== 'all',
    pageFilter !== 'all',
    sortOrder !== 'newest',
  ].filter(Boolean).length;

  const resetFilters = () => {
    setQuery('');
    setCategory('all');
    setSeverity('all');
    setQuickFilter('all');
    setTimeRange('all');
    setSource('all');
    setOperation('all');
    setPageFilter('all');
    setSortOrder('newest');
  };

  const exportJson = async () => {
    try {
      setExportStatus('Saving JSON export...');
      const result = await exportLogText({
        filename: `road-sage-system-logs-${new Date().toISOString().slice(0, 10)}.json`,
        text: exportSystemLogsJson(filteredLogs),
        mimeType: 'application/json',
        format: 'json',
        logCount: filteredLogs.length,
      });
      setExportStatus(result.native
        ? `${result.filename} saved to Downloads.`
        : `${result.filename} is downloading.`);
    } catch (error) {
      logSystemFailure('system_logs_json_export', error, { log_count: filteredLogs.length });
      setExportStatus('JSON export failed. Check the latest failure log for details.');
    }
  };

  const exportCsv = async () => {
    try {
      setExportStatus('Saving CSV export...');
      const result = await exportLogText({
        filename: `road-sage-system-logs-${new Date().toISOString().slice(0, 10)}.csv`,
        text: exportSystemLogsCsv(filteredLogs),
        mimeType: 'text/csv',
        format: 'csv',
        logCount: filteredLogs.length,
      });
      setExportStatus(result.native
        ? `${result.filename} saved to Downloads.`
        : `${result.filename} is downloading.`);
    } catch (error) {
      logSystemFailure('system_logs_csv_export', error, { log_count: filteredLogs.length });
      setExportStatus('CSV export failed. Check the latest failure log for details.');
    }
  };

  const clearLogs = () => {
    clearSystemLogs();
    recordSystemEvent('system_logs_cleared', {
      previous_log_count: logs.length,
    }, { category: 'storage', severity: 'warn', title: 'System logs cleared' });
    setLogs(getWebDiagnosticLogs());
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-grotesk text-2xl font-bold">System Logs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            App failures, load failures, user actions, permissions, diagnostics, backup import/export, OSRM, weather, privacy, and background events. Privacy logging is {privacyRetentionHours === 0 ? 'disabled' : `kept for ${privacyRetentionHours} hour${privacyRetentionHours === 1 ? '' : 's'}`}; other system entries expire after 3 days.
          </p>
        </div>
        <div>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              onClick={refresh}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-semibold hover:bg-secondary"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
            <button
              onClick={exportJson}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
            >
              <FileJson className="h-4 w-4" />
              Export JSON
            </button>
            <button
              onClick={exportCsv}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-semibold hover:bg-secondary"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </button>
          </div>
          {exportStatus && (
            <div className="mt-2 text-right text-xs font-medium text-muted-foreground">
              {exportStatus}
            </div>
          )}
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: 'Total logs', value: counts.total, tone: 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300' },
          { label: 'Failures', value: counts.errors, tone: 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300' },
          { label: 'Warnings', value: counts.warnings, tone: 'bg-yellow-50 text-yellow-700 dark:bg-yellow-950/30 dark:text-yellow-300' },
          { label: 'Backup events', value: counts.backups, tone: 'bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300' },
          { label: 'User actions', value: counts.actions, tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-bold uppercase text-muted-foreground">{item.label}</div>
              <div className={`grid h-8 min-w-8 place-items-center rounded-lg px-2 text-sm font-bold ${item.tone}`}>{item.value}</div>
            </div>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <div className="text-xs font-bold uppercase text-muted-foreground">Auto delete</div>
            <div className="mt-1 text-sm font-semibold">
              Privacy logs: {privacyRetentionHours === 0 ? 'off' : `${privacyRetentionHours} hour${privacyRetentionHours === 1 ? '' : 's'}`}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Other system logs expire after {Math.round(SYSTEM_LOG_RETENTION_MS / (24 * 60 * 60 * 1000))} days. Expired entries are removed when logs load, refresh, export, or a log is written.
            </div>
          </div>
          <div>
            <div className="text-xs font-bold uppercase text-muted-foreground">Next deletion</div>
            <div className="mt-1 text-sm font-semibold">
              {retentionSummary.nextDeletion
                ? `${retentionSummary.nextDeletion.relative} (${retentionSummary.nextDeletion.absolute})`
                : 'No stored system logs yet'}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {retentionSummary.systemCount} stored system entries are currently inside the retention window.
            </div>
          </div>
          <div>
            <div className="text-xs font-bold uppercase text-muted-foreground">Diagnostics included</div>
            <div className="mt-1 text-sm font-semibold">
              Decision logs appear here and in exports
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {retentionSummary.diagnosticsCount} diagnostic entries are shown. The Diagnostics page keeps the latest {DIAGNOSTIC_DECISION_LIMIT} web decisions; Android diagnostics are loaded when available.
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center gap-2 text-sm font-semibold">
            <Filter className="h-4 w-4 text-muted-foreground" />
            Filters
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                {activeFilterCount} active
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={resetFilters}
            disabled={activeFilterCount === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-semibold text-muted-foreground hover:bg-secondary disabled:opacity-40"
          >
            <X className="h-3.5 w-3.5" />
            Reset
          </button>
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          {quickFilterOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setQuickFilter(option.id)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                quickFilter === option.id
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:bg-secondary'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.4fr)_repeat(7,minmax(120px,1fr))_auto]">
          <label className="relative block md:col-span-2 xl:col-span-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, operation, reason, page, source, details..."
              className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm"
            />
          </label>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label="Log category"
            className="h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm"
          >
            {categoryOptions.map((option) => <option key={option} value={option}>{categoryLabels[option]}</option>)}
          </select>
          <select
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
            aria-label="Log severity"
            className="h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="all">All severity</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
          </select>
          <select
            value={timeRange}
            onChange={(event) => setTimeRange(event.target.value)}
            aria-label="Log time range"
            className="h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm"
          >
            {timeRangeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value)}
            aria-label="Log source"
            className="h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="all">All sources</option>
            {filterOptions.sources.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <select
            value={operation}
            onChange={(event) => setOperation(event.target.value)}
            aria-label="Log operation"
            className="h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="all">All operations</option>
            {filterOptions.operations.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <select
            value={pageFilter}
            onChange={(event) => setPageFilter(event.target.value)}
            aria-label="Log page"
            className="h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="all">All pages</option>
            {filterOptions.pages.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <select
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
            aria-label="Log sort order"
            className="h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
          <button
            onClick={clearLogs}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
          >
            <Trash2 className="h-4 w-4" />
            Clear
          </button>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="font-semibold">{sortOrder === 'oldest' ? 'Oldest First' : 'Newest First'}</h2>
            <div className="text-xs text-muted-foreground">
              Exports use the current filtered results.
            </div>
          </div>
          <span className="text-xs text-muted-foreground">
            {filteredLogs.length
              ? `${visibleLogs.length} of ${filteredLogs.length} shown`
              : '0 shown'}
          </span>
        </div>
        <div className="space-y-2">
          {filteredLogs.length > 0 ? (
            <>
              {visibleLogs.map((event, index) => <LogRow key={event.id} event={event} index={index} />)}
              {visibleLogs.length < filteredLogs.length && (
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + LOG_PAGE_SIZE)}
                  className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-lg border border-border bg-card px-3 text-sm font-semibold hover:bg-secondary"
                >
                  Show more logs
                </button>
              )}
            </>
          ) : (
            <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
              <ClipboardList className="mx-auto mb-2 h-6 w-6" />
              No matching logs.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
