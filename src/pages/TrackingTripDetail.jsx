import { lazy, Suspense, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowLeft, Clock, Database, Gauge, Map, Route, ShieldCheck } from 'lucide-react';
import { tripDetailQueryOptions, tripSummaryQueryOptions } from '@/api/trips';
import PageLoadingSkeleton from '@/components/PageLoadingSkeleton';
import TrackingTelemetryCharts from '@/components/TrackingTelemetryCharts';
import useLocalSettings from '@/hooks/useLocalSettings';
import { formatDistance, formatDuration, formatSpeed } from '@/lib/tripEngine';
import { buildSourceEvidenceRows } from '@/lib/trackingEvidence';
import { formatTrackingEventTime, normalizeTrackingEventRows } from '@/lib/trackingEvents';
import { buildTripTelemetrySeries, nearestTelemetrySample } from '@/lib/trackingTelemetryAnalytics';
import {
  trackingTripDisplayName, trackingTripEvidenceStatus, trackingTripNumericValue,
  trackingTripObservationLabel, trackingTripRoutePointCount, trackingTripRouteStatus,
} from '@/lib/trackingTripPresentation';

const TripMap = lazy(() => import('@/components/TripMap'));
const dateTime = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date)
    : 'source unavailable';
};
const measurement = (trip, key, formatter) => {
  const value = trackingTripNumericValue(trip, key);
  return value == null ? 'Unavailable' : formatter(value);
};
const statusClass = (key) => key === 'recorded' || key === 'retained'
  ? 'border-emerald-800/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  : ['limited', 'privacy', 'expired'].includes(key)
    ? 'border-amber-800/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    : 'border-border bg-secondary text-muted-foreground';

export default function TrackingTripDetail() {
  const { id } = useParams();
  const [comparisonId, setComparisonId] = useState('');
  const [selectedTimestamp, setSelectedTimestamp] = useState(null);
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const query = useQuery(tripDetailQueryOptions(id));
  const summariesQuery = useQuery(tripSummaryQueryOptions());
  const comparisonQuery = useQuery(tripDetailQueryOptions(comparisonId));
  const trip = query.data;
  const events = useMemo(() => trip ? normalizeTrackingEventRows(trip, { settings }) : [], [settings, trip]);
  const sources = useMemo(() => trip ? buildSourceEvidenceRows(trip, settings) : [], [settings, trip]);
  const telemetry = useMemo(() => trip ? buildTripTelemetrySeries(trip) : [], [trip]);
  const selectedSample = useMemo(
    () => nearestTelemetrySample(telemetry, selectedTimestamp),
    [selectedTimestamp, telemetry]
  );
  if (query.isLoading) return <PageLoadingSkeleton title="Loading trip telemetry" />;
  if (!trip) return <EmptyTrip />;

  const route = trackingTripRouteStatus(trip);
  const evidence = trackingTripEvidenceStatus(trip);
  const points = trackingTripRoutePointCount(trip);
  const hasRoute = Array.isArray(trip.route_points) && trip.route_points.filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng))).length > 1;
  const mapRoutes = hasRoute ? [{ id: trip.id, label: trackingTripDisplayName(trip), selected: true, color: '#2563eb', route_points: trip.route_points, rawPointCount: trip.route_points_raw_count }] : [];
  const mapEvents = events.filter((row) => !row.diagnostic && row.privacyStatus !== 'privacy masked').map((row) => row.rawEvent);
  const availableSources = sources.filter((row) => row.confidence !== 'unavailable' && row.value !== 'unavailable').length;
  const comparisonOptions = (summariesQuery.data || []).filter((row) => String(row.id) !== String(trip.id));
  const selectEvent = (event) => {
    const value = event?.timestamp ?? event?.time ?? event?.start_time ?? event?.startTime;
    const timestamp = new Date(value || 0).getTime();
    if (Number.isFinite(timestamp)) setSelectedTimestamp(timestamp);
  };

  return <div className="min-w-0">
    <header className="border-b border-border pb-3">
      <Link to="/trips" className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />My tracked trips</Link>
      <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0"><div className="text-[11px] font-bold text-muted-foreground">Advanced drive details</div><h1 className="truncate font-grotesk text-2xl font-bold">{trackingTripDisplayName(trip)}</h1>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>Started {dateTime(trip.start_time)}</span><span>Ended {dateTime(trip.end_time)}</span><span className="font-mono">ID {trip.id}</span></div>
        </div>
        <div className="flex flex-wrap gap-2"><Badge item={route} /><Badge item={evidence} /></div>
      </div>
      <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-secondary/30 p-2 sm:flex-row sm:items-center sm:justify-between">
        <div><div className="text-xs font-semibold">Compare speed profile</div><div className="text-[11px] text-muted-foreground">Alignment uses normalized trip progress.</div></div>
        <select value={comparisonId} onChange={(event) => setComparisonId(event.target.value)} className="h-9 min-w-56 rounded-md border border-border bg-card px-3 text-xs">
          <option value="">No comparison trip</option>
          {comparisonOptions.map((row) => <option key={row.id} value={row.id}>{trackingTripDisplayName(row)} · {dateTime(row.start_time)}</option>)}
        </select>
      </div>
    </header>

    <section aria-label="Trip measurements" className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      <Metric icon={Route} label="Distance" value={measurement(trip, 'distance_km', (value) => formatDistance(value, units))} />
      <Metric icon={Clock} label="Duration" value={measurement(trip, 'duration_seconds', formatDuration)} />
      <Metric icon={Gauge} label="Average speed" value={measurement(trip, 'avg_speed_kmh', (value) => formatSpeed(value, units))} />
      <Metric icon={Gauge} label="Maximum speed" value={measurement(trip, 'max_speed_kmh', (value) => formatSpeed(value, units))} />
      <Metric icon={Activity} label="Observations" value={String(events.length)} />
      <Metric icon={Database} label="Route samples" value={points == null ? 'Unavailable' : String(points)} />
    </section>

    <div className="mt-3">
      <TrackingTelemetryCharts
        trip={trip}
        comparisonTrip={comparisonQuery.data || null}
        units={units}
        selectedTimestamp={selectedTimestamp}
        onSelectTimestamp={setSelectedTimestamp}
      />
    </div>

    <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(19rem,0.7fr)]">
      <section className="overflow-hidden rounded-lg border border-border bg-card/60">
        <Pane icon={Map} title="Route and event positions" detail="Privacy masking is applied before coordinates are displayed." />
        {hasRoute ? <Suspense fallback={<MapLoading />}><TripMap routes={mapRoutes} events={mapEvents} focusPoint={selectedSample} onEventSelect={selectEvent} height="26rem" className="h-[26rem]" /></Suspense>
          : <div className="flex h-[26rem] flex-col items-center justify-center px-6 text-center"><Map className="h-8 w-8 text-muted-foreground" /><div className="mt-3 font-semibold">{route.label}</div><p className="mt-1 max-w-md text-sm text-muted-foreground">{route.detail}</p></div>}
      </section>
      <section className="overflow-hidden rounded-lg border border-border bg-card/60">
        <Pane icon={ShieldCheck} title="Acquisition quality" detail={`${availableSources} of ${sources.length} sources report retained status.`} />
        <div className="max-h-[26rem] divide-y divide-border/70 overflow-auto">{sources.map((row) => <div key={row.id} className="px-3 py-3 text-xs">
          <div className="flex items-start justify-between gap-3"><b className="text-foreground">{row.label}</b><span className="text-right font-mono text-foreground">{row.value}</span></div>
          <div className="mt-1 text-muted-foreground">{row.dataSourceLabel} · {row.confidence} · samples {row.sampleCount}</div><p className="mt-1 text-muted-foreground">{row.detail}</p>
        </div>)}</div>
      </section>
    </div>

    <section className="mt-3 overflow-hidden rounded-lg border border-border bg-card/60">
      <Pane icon={Activity} title="Observation timeline" detail={`${trackingTripObservationLabel(trip)}. Diagnostic records are identified and are not presented as driver grades.`} />
      <div className="overflow-x-auto"><table className="w-full min-w-[64rem] border-collapse text-left text-xs">
        <thead className="bg-secondary/50 text-[11px] uppercase text-muted-foreground"><tr><Th>Time</Th><Th>Observation</Th><Th>Measured value</Th><Th>Speed / limit</Th><Th>Source</Th><Th>Confidence</Th><Th>Privacy</Th></tr></thead>
        <tbody>{events.map((row) => {
          const rowTimestamp = new Date(row.timestamp || 0).getTime();
          const selected = selectedTimestamp != null && Number.isFinite(rowTimestamp) && Math.abs(rowTimestamp - selectedTimestamp) < 1000;
          return <tr key={row.id} onClick={() => selectEvent(row)} className={`cursor-pointer border-t border-border/70 align-top hover:bg-secondary/40 ${selected ? 'bg-blue-500/10' : ''}`}>
          <Td>{formatTrackingEventTime(row.timestamp)}</Td><Td><b className="text-foreground">{row.label}</b><div className="mt-1">{row.thresholdNote}</div>{row.diagnostic && <span className="mt-1 inline-flex rounded-sm bg-blue-500/10 px-1.5 py-0.5 font-semibold text-blue-700 dark:text-blue-300">Diagnostic only</span>}</Td>
          <Td>{row.valueLabel}</Td><Td>{row.speedLabel}<div className="mt-1">Limit: {row.limitLabel}</div></Td><Td>{row.sourceLabel}</Td><Td>{row.confidence}</Td><Td>{row.privacyStatus}</Td>
        </tr>})}{!events.length && <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">No threshold or diagnostic observations were retained for this trip.</td></tr>}</tbody>
      </table></div>
    </section>

    <div className="mt-3 flex flex-wrap gap-2">
      <ToolLink to={`/tracking/map?trip=${encodeURIComponent(trip.id)}`}>Open map workspace</ToolLink><ToolLink to={`/tracking/events?trip=${encodeURIComponent(trip.id)}`}>Inspect all events</ToolLink><ToolLink to={`/tracking/evidence?trip=${encodeURIComponent(trip.id)}`}>Inspect metric evidence</ToolLink>
      {trip.route_replay_available && <ToolLink to={`/trips/${trip.id}/3d`}>Open 3D replay</ToolLink>}
    </div>
  </div>;
}

function EmptyTrip() { return <div className="rounded-lg border border-border bg-card p-10 text-center"><h1 className="text-xl font-bold">Trip telemetry unavailable</h1><p className="mt-2 text-sm text-muted-foreground">The requested local trip record could not be found.</p><Link to="/trips" className="mt-4 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Return to trip telemetry</Link></div>; }
function MapLoading() { return <div className="flex h-[26rem] items-center justify-center text-sm text-muted-foreground">Loading local route map</div>; }
function Metric({ icon: Icon, label, value }) { return <div className="rounded-md border border-border bg-card px-3 py-3"><div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground"><Icon className="h-3.5 w-3.5" />{label}</div><div className="mt-1 font-grotesk text-lg font-bold">{value}</div></div>; }
function Badge({ item }) { return <span title={item.detail} className={`rounded-sm border px-2.5 py-1.5 text-xs font-semibold ${statusClass(item.key)}`}>{item.label}</span>; }
function Pane({ icon: Icon, title, detail }) { return <div className="flex items-start gap-2 border-b border-border bg-secondary/30 px-3 py-2"><Icon className="mt-0.5 h-4 w-4 text-muted-foreground" /><div><h2 className="text-sm font-semibold">{title}</h2><p className="text-xs text-muted-foreground">{detail}</p></div></div>; }
function ToolLink({ to, children }) { return <Link to={to} className="rounded-md border border-border bg-card px-3 py-2 text-sm font-semibold hover:bg-secondary">{children}</Link>; }
function Th({ children }) { return <th className="px-3 py-2 font-semibold">{children}</th>; }
function Td({ children }) { return <td className="px-3 py-3 text-muted-foreground">{children}</td>; }
