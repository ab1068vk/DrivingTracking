import { useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Database,
  Download,
  FileWarning,
  Gauge,
  History,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  buildAppExperienceReport,
  clearImportedAppExperienceReports,
  getHistoricalAppExperienceEvents,
  getImportedAppExperienceReports,
  parseAppExperienceReport,
  saveImportedAppExperienceReport,
} from '@/lib/appExperienceDiagnostics';
import { isNativePlatform } from '@/lib/nativePlatform';
import { isP0DebugBuild, resolveP0Arm } from '@/lib/p0ProbeArms';

// Resolved once at module scope: the arm is frozen for the process, and the raw
// export control must not exist at all in a release build.
const P0_DEBUG_BUILD = isP0DebugBuild();
const p0Arm = resolveP0Arm();
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { formatDistance } from '@/lib/tripEngine';

const toneStyle = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200',
  watch: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200',
  slow: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200',
};

const formatDuration = (value) => {
  const ms = Math.max(0, Number(value) || 0);
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)} s`;
  return `${Math.round(ms)} ms`;
};

const formatBytes = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
};

const downloadText = (filename, text) => {
  const blob = new Blob([text], { type: 'application/json' });
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
};

function MetricCard({ icon: Icon, label, value, detail, tone = 'neutral' }) {
  return (
    <div className={`rounded-xl border p-3 ${tone === 'neutral' ? 'border-border bg-secondary/30' : toneStyle[tone]}`}>
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-2 font-grotesk text-xl font-bold">{value}</div>
      <div className="mt-1 text-xs opacity-80">{detail}</div>
    </div>
  );
}

function DailyPerformanceBars({ series = [] }) {
  const visible = series.slice(-14);
  const max = Math.max(1, ...visible.map((item) => Number(item.p95_ms) || 0));
  if (!visible.length) {
    return <div className="rounded-xl bg-secondary/30 p-3 text-xs text-muted-foreground">Historical bars appear after measurements are retained across app use.</div>;
  }
  return (
    <div className="rounded-xl border border-border bg-secondary/20 p-3">
      <div className="flex h-28 items-end gap-1.5" aria-label="Daily performance p95 chart">
        {visible.map((item) => {
          const height = Math.max(6, Math.round(((Number(item.p95_ms) || 0) / max) * 100));
          const tone = item.p95_ms > 1500 ? 'bg-red-500' : item.p95_ms > 600 ? 'bg-amber-500' : 'bg-emerald-500';
          return (
            <div key={item.day} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${item.day}: ${formatDuration(item.p95_ms)} p95, ${item.samples} samples`}>
              <div className={`w-full min-w-[6px] rounded-t ${tone}`} style={{ height: `${height}%` }} />
              <span className="hidden text-[9px] text-muted-foreground sm:block">{item.day.slice(5)}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] font-semibold text-muted-foreground">
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />fast</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />watch</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-red-500" />slow</span>
        <span className="ml-auto">Daily p95, not an average</span>
      </div>
    </div>
  );
}

export default function AppExperienceDiagnosticsPanel({
  trips = [],
  performanceEntries = [],
  trackingEvents = [],
  settings = {},
  buildInfo = {},
  nativeWatchdog = null,
  tripDataReady = true,
} = {}) {
  const inputRef = useRef(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [importedReports, setImportedReports] = useState(() => getImportedAppExperienceReports());
  // Reads a module-level store that takes no arguments. The counts are the
  // intentional staleness signal for re-reading it, not unused inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const historicalEvents = useMemo(() => getHistoricalAppExperienceEvents(), [performanceEntries.length, trackingEvents.length]);
  const report = useMemo(() => buildAppExperienceReport({
    trips,
    performanceEntries,
    systemEvents: [...historicalEvents, ...trackingEvents],
    settings,
    buildInfo,
    nativeWatchdog,
  }), [trips, performanceEntries, historicalEvents, trackingEvents, settings, buildInfo, nativeWatchdog]);
  const topOperations = report.performance.operations.slice(0, 10);
  const worstP95 = Math.max(0, ...report.performance.operations.map((item) => Number(item.p95Ms) || 0));
  const activity = report.activity.counts;
  const units = settings.units || 'metric';

  /**
   * I-2: refuse to build an export while the trip-profile query is still
   * pending. The baseline evidence file was exactly this artifact — it reported
   * `trip_count: 0` on a 128-trip device because the report was assembled 35 ms
   * after its own `listAllSummaries` started.
   *
   * @param {{ includeP0Raw?: boolean }} [options]
   */
  const exportReport = async ({ includeP0Raw = false } = {}) => {
    if (!tripDataReady) {
      setNotice('Trip history is still loading. Wait for it to finish so the report is not exported with an empty dataset.');
      return;
    }
    setBusy(true);
    setNotice('');
    const suffix = includeP0Raw ? '-p0-raw' : '';
    const filename = `road-sage-app-experience-${new Date().toISOString().slice(0, 10)}${suffix}.json`;
    // The default export is byte-identical to the pre-P0 report; the raw P0
    // section is only built when explicitly requested.
    const exported = includeP0Raw
      ? buildAppExperienceReport({
        trips,
        performanceEntries,
        systemEvents: [...historicalEvents, ...trackingEvents],
        settings,
        buildInfo,
        nativeWatchdog,
        includeP0Raw: true,
      })
      : report;
    const text = JSON.stringify(exported, null, 2);
    try {
      if (isNativePlatform()) {
        const result = await saveExportToDownloads({ filename, data: text, mimeType: 'application/json' });
        setNotice(`${filename} saved to Downloads.`);
        recordSystemEvent('app_experience_diagnostics_exported', {
          byte_count: text.length,
          trip_count: report.data.trip_count,
          sample_count: report.performance.sample_count,
          native: true,
          uri_present: Boolean(result?.uri),
        }, { category: 'diagnostics', title: 'App experience diagnostics exported' });
      } else {
        downloadText(filename, text);
        setNotice(`${filename} is downloading.`);
        recordSystemEvent('app_experience_diagnostics_exported', {
          byte_count: text.length,
          trip_count: report.data.trip_count,
          sample_count: report.performance.sample_count,
          native: false,
        }, { category: 'diagnostics', title: 'App experience diagnostics exported' });
      }
    } catch (error) {
      logSystemFailure('app_experience_diagnostics_export', error, { byte_count: text.length });
      setNotice(error?.message || 'The diagnostics report could not be exported.');
    } finally {
      setBusy(false);
    }
  };

  const importReport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setNotice('');
    try {
      const parsed = parseAppExperienceReport(await file.text());
      const next = saveImportedAppExperienceReport(parsed);
      setImportedReports(next);
      setNotice('Comparison imported. It did not change trips, settings, or tracking.');
      recordSystemEvent('app_experience_diagnostics_imported', {
        byte_count: file.size,
        report_trip_count: parsed.data.trip_count,
        report_sample_count: parsed.performance.sample_count,
      }, { category: 'diagnostics', title: 'App experience diagnostics imported' });
    } catch (error) {
      logSystemFailure('app_experience_diagnostics_import', error, { byte_count: file.size });
      setNotice(error?.message || 'The diagnostics report could not be imported.');
    } finally {
      setBusy(false);
    }
  };

  const clearComparisons = () => {
    clearImportedAppExperienceReports();
    setImportedReports([]);
    setNotice('Imported comparisons cleared.');
  };

  return (
    <section aria-label="App experience intelligence" className="rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">App Experience Intelligence</h2>
            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase ${toneStyle[report.health.status]}`}>
              {report.health.score}/100 · {report.health.status}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            Historical loading, app failures, setting changes, trip deletion, imports/exports, network responses, coaching, and advanced tracking—correlated with anonymous trip-data size.
          </p>
          <p className="mt-2 text-sm font-semibold">{report.health.headline}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => exportReport()} disabled={busy || !tripDataReady} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">
            <Download className="h-4 w-4" /> {tripDataReady ? 'Export safe report' : 'Loading trip history…'}
          </button>
          {P0_DEBUG_BUILD && (
            <button
              type="button"
              onClick={() => exportReport({ includeP0Raw: true })}
              disabled={busy || !tripDataReady}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold disabled:opacity-50"
              title={`P0 arm ${p0Arm} — raw measurement rows, debug builds only`}
            >
              <Download className="h-4 w-4" /> Export P0 raw ({p0Arm})
            </button>
          )}
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold disabled:opacity-50">
            <Upload className="h-4 w-4" /> Import comparison
          </button>
          <input ref={inputRef} className="hidden" type="file" accept=".json,application/json" onChange={importReport} />
        </div>
      </div>

      {notice && <div role="status" className="mt-3 rounded-lg bg-secondary/50 px-3 py-2 text-xs font-medium">{notice}</div>}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard icon={Gauge} label="Worst retained p95" value={formatDuration(worstP95)} detail={`${report.performance.sample_count} timing samples over up to 90 days`} tone={report.health.status} />
        <MetricCard icon={Database} label="Trip data context" value={`${report.data.completed_trip_count} trips`} detail={`${formatDistance(report.data.total_distance_km, units)} · ${formatBytes(report.data.approximate_summary_bytes)} summaries`} />
        <MetricCard
          icon={FileWarning}
          label="Freezes / failures"
          value={(activity.freezes_and_anrs || 0) + activity.crashes_and_failures}
          detail={`${activity.freezes_and_anrs || 0} freeze/ANR · ${activity.resource_pressure || 0} resource-pressure signals`}
          tone={activity.freezes_and_anrs || activity.crashes_and_failures ? 'watch' : 'good'}
        />
        <MetricCard icon={History} label="Experience activity" value={report.activity.event_count} detail={`${activity.settings_changes} settings · ${activity.trip_deletions} deletions · ${activity.imports_and_exports} transfers`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Historical speed at a glance</h3>
              <p className="text-[11px] text-muted-foreground">Green is fast, amber needs watching, and red is a sustained or severe slowdown.</p>
            </div>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </div>
          <DailyPerformanceBars series={report.performance.daily_series} />
          <div className="mt-3 space-y-2">
            {topOperations.length ? topOperations.map((item) => (
              <div key={item.key || `${item.name}:${item.pathname || ''}`} className="grid gap-2 rounded-xl border border-border bg-secondary/20 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{item.pathname ? `${item.pathname} · ${item.name}` : item.name}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {item.count} samples · median {formatDuration(item.p50Ms)} · p95 {formatDuration(item.p95Ms)} · max {formatDuration(item.maxMs)}
                  </div>
                  {(item.latestContext?.trip_count > 0 || item.latestContext?.route_point_count > 0) && (
                    <div className="mt-1 text-[10px] font-medium text-muted-foreground">
                      Latest context: {item.latestContext.trip_count} trips · {item.latestContext.route_point_count.toLocaleString()} retained route points
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {item.count >= 4 && item.trendPercent !== 0 && (
                    <span className={`text-[11px] font-bold ${item.trendPercent > 20 ? 'text-red-600' : item.trendPercent < -20 ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                      {item.trendPercent > 0 ? '+' : ''}{item.trendPercent}%
                    </span>
                  )}
                  <span className={`rounded-full border px-2 py-1 text-[10px] font-bold uppercase ${toneStyle[item.status]}`}>{item.status}</span>
                </div>
              </div>
            )) : (
              <div className="rounded-xl bg-secondary/30 p-3 text-xs text-muted-foreground">Open pages and use the app normally; measurements will persist here across restarts.</div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">What was happening</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Counts help explain whether slowdown followed growth, failures, changes, or feature activity.</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {[
                [AlertTriangle, 'Crashes / failures', activity.crashes_and_failures],
                [FileWarning, 'Freezes / ANRs', activity.freezes_and_anrs || 0],
                [Gauge, 'Resource pressure', activity.resource_pressure || 0],
                [Trash2, 'Trip deletions', activity.trip_deletions],
                [Settings2, 'Settings changes', activity.settings_changes],
                [Download, 'Imports / exports', activity.imports_and_exports],
                [Activity, 'Network responses', activity.network_responses],
                [Gauge, 'Coaching activity', activity.coaching_experience],
                [BarChart3, 'Advanced tracking', activity.advanced_tracking],
                [Database, 'Route points', report.data.total_route_point_count.toLocaleString()],
              ].map(([Icon, label, value]) => (
                <div key={label} className="rounded-xl border border-border bg-secondary/20 p-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-muted-foreground"><Icon className="h-3.5 w-3.5" />{label}</div>
                  <div className="mt-1 text-lg font-bold">{value}</div>
                </div>
              ))}
            </div>
          </div>

          {report.runtime.available && (
            <div className="rounded-xl border border-border bg-secondary/20 p-3">
              <h3 className="text-sm font-semibold">Current Android resources</h3>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <span className="text-muted-foreground">Available memory</span><strong className="text-right">{formatBytes(report.runtime.memory_available_bytes)}</strong>
                <span className="text-muted-foreground">Road Sage heap</span><strong className="text-right">{formatBytes(report.runtime.heap_used_bytes)} / {formatBytes(report.runtime.heap_max_bytes)}</strong>
                <span className="text-muted-foreground">App storage free</span><strong className="text-right">{formatBytes(report.runtime.storage_usable_bytes)}</strong>
                <span className="text-muted-foreground">Thermal status</span><strong className="text-right capitalize">{report.runtime.thermal_label || 'unknown'}</strong>
                <span className="text-muted-foreground">Battery temperature</span><strong className="text-right">{report.runtime.battery_temperature_c != null ? `${report.runtime.battery_temperature_c.toFixed(1)} °C` : 'unavailable'}</strong>
                <span className="text-muted-foreground">UI heartbeat</span><strong className="text-right">{report.runtime.ui_stall_active ? 'stalled' : `${Math.round((report.runtime.last_main_heartbeat_age_ms || 0) / 1000)}s ago`}</strong>
              </div>
              {report.runtime.last_operation && (
                <div className="mt-3 rounded-lg bg-background/60 px-2.5 py-2 text-[11px]">
                  <span className="font-bold">Last checkpoint:</span> {report.runtime.last_operation.operation} · {report.runtime.last_operation.phase}
                  {report.runtime.last_operation.pathname ? ` · ${report.runtime.last_operation.pathname}` : ''}
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl border border-border bg-secondary/20 p-3">
            <h3 className="text-sm font-semibold">Anonymous trip-data shape</h3>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <span className="text-muted-foreground">Median trip</span><strong className="text-right">{formatDistance(report.data.median_distance_km, units)}</strong>
              <span className="text-muted-foreground">95th percentile trip</span><strong className="text-right">{formatDistance(report.data.p95_distance_km, units)}</strong>
              <span className="text-muted-foreground">95th percentile points</span><strong className="text-right">{report.data.p95_route_point_count.toLocaleString()}</strong>
              <span className="text-muted-foreground">Advanced evidence</span><strong className="text-right">{report.data.advanced_evidence_trip_count} trips</strong>
              <span className="text-muted-foreground">Automatic / manual</span><strong className="text-right">{report.data.automatic_trip_count} / {report.data.manual_trip_count}</strong>
              <span className="text-muted-foreground">Summary-only</span><strong className="text-right">{report.data.summary_only_trip_count} trips</strong>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
        <div className="flex gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div><strong>Privacy-safe by design.</strong> Exports contain no coordinates, routes, trip IDs or dates, names, notes, endpoint URLs, setting values, crash messages, or stack traces. Individual trip characteristics are rounded, anonymous, and sorted without chronology.</div>
        </div>
      </div>

      {importedReports.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Imported comparisons</h3>
              <p className="text-[11px] text-muted-foreground">Read-only baselines; they never merge into operational app data.</p>
            </div>
            <button type="button" onClick={clearComparisons} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold"><Trash2 className="h-3.5 w-3.5" /> Clear</button>
          </div>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {importedReports.map((item) => {
              const p95 = Math.max(0, ...item.performance.operations.map((operation) => Number(operation.p95Ms) || 0));
              return (
                <div key={item.generated_at} className="rounded-xl border border-border bg-secondary/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-sm">{new Date(item.generated_at).toLocaleString()}</strong>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${toneStyle[item.health.status]}`}>{item.health.score}/100</span>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                    <div><strong className="block text-base">{item.data.trip_count}</strong><span className="text-muted-foreground">trips</span></div>
                    <div><strong className="block text-base">{formatDuration(p95)}</strong><span className="text-muted-foreground">worst p95</span></div>
                    <div><strong className="block text-base">{item.activity.error_count}</strong><span className="text-muted-foreground">errors</span></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
