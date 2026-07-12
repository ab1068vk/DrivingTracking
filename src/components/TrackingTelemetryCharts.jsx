import { useMemo, useState } from 'react';
import { Activity, Gauge, GitCompareArrows, Satellite } from 'lucide-react';
import DeferredRecharts from '@/components/DeferredRecharts';
import {
  buildNormalizedComparison,
  buildTripTelemetrySeries,
  nearestTelemetrySample,
  summarizeTripTelemetry,
} from '@/lib/trackingTelemetryAnalytics';

const timeLabel = (seconds) => {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
const valueLabel = (value, suffix, digits = 1) => Number.isFinite(Number(value))
  ? `${Number(value).toFixed(digits)} ${suffix}` : 'Unavailable';

export default function TrackingTelemetryCharts({ trip, comparisonTrip = null, selectedTimestamp = null, onSelectTimestamp }) {
  const [showLimit, setShowLimit] = useState(true);
  const [showJerk, setShowJerk] = useState(true);
  const [showIntervals, setShowIntervals] = useState(true);
  const series = useMemo(() => buildTripTelemetrySeries(trip), [trip]);
  const summary = useMemo(() => summarizeTripTelemetry(trip, series), [series, trip]);
  const comparison = useMemo(
    () => comparisonTrip ? buildNormalizedComparison(trip, comparisonTrip) : [],
    [comparisonTrip, trip]
  );
  const selected = useMemo(
    () => nearestTelemetrySample(series, selectedTimestamp),
    [selectedTimestamp, series]
  );
  const selectChartPoint = (state) => {
    const row = state?.activePayload?.[0]?.payload;
    if (row?.timestamp != null) onSelectTimestamp?.(row.timestamp);
  };

  if (!series.length) return (
    <section className="rounded-lg border border-border bg-card/60 p-8 text-center">
      <Activity className="mx-auto h-8 w-8 text-muted-foreground" />
      <h2 className="mt-3 font-semibold">Telemetry charts unavailable</h2>
      <p className="mt-1 text-sm text-muted-foreground">This trip has no retained timestamped route samples.</p>
    </section>
  );

  return <section aria-label="Trip telemetry charts" className="overflow-hidden rounded-lg border border-border bg-card/60">
    <div className="flex flex-col gap-3 border-b border-border bg-secondary/30 px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <h2 className="text-sm font-semibold">Linked telemetry analysis</h2>
        <p className="text-xs text-muted-foreground">Select any chart to synchronize the map and observation cursor.</p>
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs">
        <Toggle active={showLimit} onClick={() => setShowLimit((value) => !value)}>Speed limit</Toggle>
        <Toggle active={showJerk} onClick={() => setShowJerk((value) => !value)}>Jerk</Toggle>
        <Toggle active={showIntervals} onClick={() => setShowIntervals((value) => !value)}>Sample interval</Toggle>
      </div>
    </div>

    <div className="grid gap-2 border-b border-border p-3 sm:grid-cols-2 xl:grid-cols-6">
      <Evidence label="Samples" value={String(summary.sampleCount)} />
      <Evidence label="Limit coverage" value={`${summary.speedLimitCoveragePct}%`} />
      <Evidence label="Threshold time" value={summary.thresholdExceededPct == null ? 'Unavailable' : `${summary.thresholdExceededPct}%`} />
      <Evidence label="Mean GPS accuracy" value={valueLabel(summary.averageAccuracyM, 'm', 0)} />
      <Evidence label="Mean interval" value={valueLabel(summary.averageIntervalSeconds, 's')} />
      <Evidence label="Motion evidence" value={summary.accelerationEvidence} />
    </div>

    {selected && <div className="grid gap-2 border-b border-border bg-blue-500/5 px-3 py-2 text-xs sm:grid-cols-2 lg:grid-cols-5">
      <Cursor label="Cursor" value={timeLabel(selected.elapsedSeconds)} />
      <Cursor label="Speed" value={valueLabel(selected.speedKmh, 'km/h', 0)} />
      <Cursor label="Limit" value={valueLabel(selected.speedLimitKmh, 'km/h', 0)} />
      <Cursor label="Acceleration" value={valueLabel(selected.accelerationMs2, 'm/s²')} />
      <Cursor label="Evidence" value={selected.observationLabel || selected.accelerationSource || 'route sample'} />
    </div>}

    <div className="grid gap-3 p-3 xl:grid-cols-2">
      <ChartPanel icon={Gauge} title="Speed and recorded limit" detail="Vehicle speed and the limit attached to each retained route sample.">
        <DeferredRecharts height={250}>{({ ResponsiveContainer, ComposedChart, Line, Area, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine }) => <ResponsiveContainer width="100%" height={250}>
          <ComposedChart data={series} onClick={selectChartPoint} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="elapsedSeconds" tickFormatter={timeLabel} minTickGap={28} />
            <YAxis unit=" km/h" width={62} />
            <Tooltip labelFormatter={timeLabel} formatter={(value, name) => [valueLabel(value, 'km/h', 0), name]} />
            <Area type="monotone" dataKey="speedKmh" name="Vehicle speed" stroke="#2563eb" fill="#2563eb" fillOpacity={0.12} connectNulls={false} />
            {showLimit && <Line type="stepAfter" dataKey="speedLimitKmh" name="Recorded limit" stroke="#f97316" strokeWidth={2} dot={false} connectNulls={false} />}
            {selected && <ReferenceLine x={selected.elapsedSeconds} stroke="#0f172a" strokeDasharray="4 3" />}
          </ComposedChart>
        </ResponsiveContainer>}</DeferredRecharts>
      </ChartPanel>

      <ChartPanel icon={Activity} title="Longitudinal motion" detail={`Acceleration: ${summary.accelerationEvidence}; jerk: ${summary.jerkEvidence}.`}>
        <DeferredRecharts height={250}>{({ ResponsiveContainer, ComposedChart, Line, Area, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine }) => <ResponsiveContainer width="100%" height={250}>
          <ComposedChart data={series} onClick={selectChartPoint} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="elapsedSeconds" tickFormatter={timeLabel} minTickGap={28} />
            <YAxis unit=" m/s²" width={58} />
            <Tooltip labelFormatter={timeLabel} formatter={(value, name) => [valueLabel(value, name === 'Jerk' ? 'm/s³' : 'm/s²'), name]} />
            <ReferenceLine y={0} stroke="#64748b" />
            <Area type="monotone" dataKey="accelerationMs2" name="Acceleration" stroke="#10b981" fill="#10b981" fillOpacity={0.1} connectNulls={false} />
            {showJerk && <Line type="monotone" dataKey="jerkMs3" name="Jerk" stroke="#a855f7" dot={false} connectNulls={false} />}
            {selected && <ReferenceLine x={selected.elapsedSeconds} stroke="#0f172a" strokeDasharray="4 3" />}
          </ComposedChart>
        </ResponsiveContainer>}</DeferredRecharts>
      </ChartPanel>

      <ChartPanel icon={Satellite} title="Acquisition quality" detail={`${summary.routeGapCount} route gaps and ${summary.privacyGapCount} privacy placeholders in the plotted series.`}>
        <DeferredRecharts height={230}>{({ ResponsiveContainer, ComposedChart, Line, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine }) => <ResponsiveContainer width="100%" height={230}>
          <ComposedChart data={series} onClick={selectChartPoint} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="elapsedSeconds" tickFormatter={timeLabel} minTickGap={28} />
            <YAxis width={52} />
            <Tooltip labelFormatter={timeLabel} />
            <Line type="monotone" dataKey="accuracyM" name="GPS accuracy (m)" stroke="#ef4444" strokeWidth={2} dot={false} connectNulls={false} />
            {showIntervals && <Bar dataKey="sampleIntervalSeconds" name="Sample interval (s)" fill="#64748b" opacity={0.25} />}
            {selected && <ReferenceLine x={selected.elapsedSeconds} stroke="#0f172a" strokeDasharray="4 3" />}
          </ComposedChart>
        </ResponsiveContainer>}</DeferredRecharts>
      </ChartPanel>

      <ChartPanel icon={comparisonTrip ? GitCompareArrows : Activity} title={comparisonTrip ? 'Normalized trip comparison' : 'Altitude and retained lateral motion'} detail={comparisonTrip ? 'Speed profiles aligned by trip progress; distance and duration may differ.' : 'Series appear only when the corresponding evidence was retained.'}>
        <DeferredRecharts height={230}>{({ ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip }) => <ResponsiveContainer width="100%" height={230}>
          <LineChart data={comparisonTrip ? comparison : series} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey={comparisonTrip ? 'progress' : 'elapsedSeconds'} tickFormatter={comparisonTrip ? (value) => `${Math.round(value)}%` : timeLabel} minTickGap={28} />
            <YAxis width={58} /><Tooltip />
            {comparisonTrip ? <>
              <Line type="monotone" dataKey="primarySpeedKmh" name="Current trip" stroke="#2563eb" strokeWidth={2} dot={false} connectNulls />
              <Line type="monotone" dataKey="comparisonSpeedKmh" name="Comparison" stroke="#f97316" strokeWidth={2} dot={false} connectNulls />
            </> : <>
              <Line type="monotone" dataKey="altitudeM" name="Altitude (m)" stroke="#0ea5e9" dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="lateralG" name="Lateral g" stroke="#f97316" dot={false} connectNulls={false} />
            </>}
          </LineChart>
        </ResponsiveContainer>}</DeferredRecharts>
      </ChartPanel>
    </div>
  </section>;
}

function Toggle({ active, onClick, children }) { return <button type="button" aria-pressed={active} onClick={onClick} className={`rounded-md border px-2.5 py-1.5 font-semibold ${active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground'}`}>{children}</button>; }
function Evidence({ label, value }) { return <div className="rounded-md border border-border bg-card px-2.5 py-2"><div className="text-[10px] uppercase text-muted-foreground">{label}</div><div className="mt-1 truncate text-xs font-semibold" title={value}>{value}</div></div>; }
function Cursor({ label, value }) { return <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">{label}</span><b>{value}</b></div>; }
function ChartPanel({ icon: Icon, title, detail, children }) { return <div className="min-w-0 rounded-md border border-border bg-background p-3"><div className="mb-2 flex items-start gap-2"><Icon className="mt-0.5 h-4 w-4 text-muted-foreground" /><div><h3 className="text-sm font-semibold">{title}</h3><p className="text-xs text-muted-foreground">{detail}</p></div></div>{children}</div>; }
