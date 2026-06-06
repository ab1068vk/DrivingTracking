import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Download,
  FileJson,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  clearSystemLogs,
  exportSystemLogsCsv,
  exportSystemLogsJson,
  getSystemLogs,
  logSystemFailure,
  recordSystemEvent,
  SYSTEM_LOG_EVENT,
} from '@/lib/systemLog';
import { getNativeDiagnostics } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import {
  getTrackingDiagnostics,
  normalizeNativeDiagnosticEvents,
} from '@/lib/trackingDiagnostics';

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
  app: 'App',
};

const categoryOptions = Object.keys(categoryLabels);
const LOG_PAGE_SIZE = 50;

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
  return (getTrackingDiagnostics().events || []).map((event) => diagnosticEventToLog(event, 'web_diagnostic'));
}

function getLocalLogSnapshot() {
  return mergeLogs(getSystemLogs(), getWebDiagnosticLogs());
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
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function detailSummary(details = {}) {
  if (!details || typeof details !== 'object') return '';
  const reason = details.reason || details.error?.message || details.statusText || details.target?.label;
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
  const [logs, setLogs] = useState(() => getLocalLogSnapshot());
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [visibleCount, setVisibleCount] = useState(LOG_PAGE_SIZE);

  const refresh = () => {
    setLogs(getLocalLogSnapshot());
    getFullLogSnapshot().then(setLogs);
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
  }, [query, category, severity]);

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
    return searchableLogs.filter(({ event, searchText }) => {
      if (category !== 'all' && event.category !== category) return false;
      if (severity !== 'all' && event.severity !== severity) return false;
      if (!q) return true;
      return searchText.includes(q);
    }).map(({ event }) => event);
  }, [searchableLogs, query, category, severity]);

  const visibleLogs = useMemo(
    () => filteredLogs.slice(0, visibleCount),
    [filteredLogs, visibleCount]
  );

  const counts = useMemo(() => ({
    total: logs.length,
    errors: logs.filter((event) => event.severity === 'error').length,
    warnings: logs.filter((event) => event.severity === 'warn').length,
    actions: logs.filter((event) => event.category === 'user_action').length,
  }), [logs]);

  const exportJson = () => {
    downloadText(
      `road-sage-system-logs-${new Date().toISOString().slice(0, 10)}.json`,
      exportSystemLogsJson(logs),
      'application/json'
    );
    recordSystemEvent('system_logs_exported', {
      format: 'json',
      log_count: logs.length,
    }, { category: 'storage', title: 'System logs exported' });
  };

  const exportCsv = () => {
    downloadText(
      `road-sage-system-logs-${new Date().toISOString().slice(0, 10)}.csv`,
      exportSystemLogsCsv(logs),
      'text/csv'
    );
    recordSystemEvent('system_logs_exported', {
      format: 'csv',
      log_count: logs.length,
    }, { category: 'storage', title: 'System logs exported' });
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
            App failures, load failures, user actions, permissions, diagnostics, OSRM, weather, privacy, and background events. System entries expire after 3 days.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Total logs', value: counts.total, tone: 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300' },
          { label: 'Failures', value: counts.errors, tone: 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300' },
          { label: 'Warnings', value: counts.warnings, tone: 'bg-yellow-50 text-yellow-700 dark:bg-yellow-950/30 dark:text-yellow-300' },
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
        <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto_auto]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search operation, reason, page, source..."
              className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm"
            />
          </label>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
          >
            {categoryOptions.map((option) => <option key={option} value={option}>{categoryLabels[option]}</option>)}
          </select>
          <select
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="all">All severity</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
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
          <h2 className="font-semibold">Newest First</h2>
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
