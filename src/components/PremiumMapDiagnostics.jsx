// @ts-check
import {
  Activity,
  Clock3,
  Radio,
  Route,
  Satellite,
  ShieldCheck,
} from 'lucide-react';
import premiumMapRouteIntelligence from '@/assets/premium-map-route-intelligence.webp';
import { formatDistance, formatDuration, formatSpeed, getTripComponentScore } from '@/lib/tripEngine';
import { formatScoreWithProvenance } from '@/lib/scoreDisplay';
import { buildMapDiagnosticsAggregate } from '@/lib/mapDiagnostics';

const RoadMetricIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3.75 21 9.1 3" />
    <path d="M20.25 21 14.9 3" />
    <path d="M12 20v-3.1M12 13.2v-3M12 6.5V3.8" />
  </svg>
);

const SpeedMetricIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4.9 18a8.5 8.5 0 1 1 14.2 0" />
    <path d="M6.1 15.7h-1M7.7 10.9l-.8-.7M12 8.8v-1M16.3 10.9l.8-.7M18.9 15.7h1" />
    <path d="m12 15.7 3.7-3.8" />
    <circle cx="12" cy="15.7" r="1.2" />
  </svg>
);

const EventMetricIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M10.15 4.25 2.9 17.1A2 2 0 0 0 4.65 20h14.7a2 2 0 0 0 1.75-2.9L13.85 4.25a2.12 2.12 0 0 0-3.7 0Z" />
    <path d="M12 8.6v5.1" />
    <circle cx="12" cy="17" r=".7" fill="currentColor" stroke="none" />
  </svg>
);

const StopMetricIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="m8.2 2.8 7.6 0 5.4 5.4 0 7.6-5.4 5.4H8.2l-5.4-5.4V8.2z" />
    <path d="M16.1 9.2a5 5 0 1 0 .15 5.35" />
    <path d="M15.7 9.2h-3.1" />
  </svg>
);

const numericCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
};

const satelliteCountForTrip = (trip) => {
  const tripCount = numericCount(
    trip?.satellites_used
      ?? trip?.satellite_count
      ?? trip?.gps_satellite_count
      ?? trip?.gnss_satellite_count
      ?? trip?.satellites,
  );
  if (tripCount != null) return tripCount;

  const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    const pointCount = numericCount(
      point?.satellites_used
        ?? point?.satellite_count
        ?? point?.gps_satellite_count
        ?? point?.gnss_satellite_count
        ?? point?.satellites,
    );
    if (pointCount != null) return pointCount;
  }
  return null;
};

export function buildPremiumMapDiagnosticsModel(trip, units = 'metric') {
  const routePointCount = Array.isArray(trip?.route_points) ? trip.route_points.length : null;
  const gpsPoints = numericCount(trip?.route_points_raw_count)
    ?? numericCount(trip?.route_points_map_count)
    ?? routePointCount
    ?? 0;
  const eventCount = Array.isArray(trip?.driving_events)
    ? trip.driving_events.length
    : numericCount(trip?.driving_events_count) ?? 0;
  const stops = numericCount(trip?.traffic_stop_count) ?? numericCount(trip?.stop_count) ?? 0;
  const satelliteCount = satelliteCountForTrip(trip);
  const overall = getTripComponentScore(trip, 'overall');

  return {
    distance: formatDistance(Number(trip?.distance_km) || 0, units),
    maximumSpeed: formatSpeed(Number(trip?.max_speed_kmh) || 0, units),
    averageSpeed: formatSpeed(Number(trip?.avg_speed_kmh ?? trip?.avg_running_speed_kmh) || 0, units),
    duration: formatDuration(Number(trip?.duration_seconds) || 0),
    gpsPoints: gpsPoints.toLocaleString(),
    satellites: satelliteCount == null ? '\u2014' : satelliteCount.toLocaleString(),
    satellitesAvailable: satelliteCount != null,
    eventCount: eventCount.toLocaleString(),
    stops: stops.toLocaleString(),
    score: formatScoreWithProvenance(overall.value, trip?.score_provenance),
    evidence: overall.evidence || 'learning',
  };
}

export const buildPremiumMapDiagnosticsAggregate = buildMapDiagnosticsAggregate;
export const shouldShowStandardMapRouteSummary = (premiumVisuals) => !premiumVisuals;

export default function PremiumMapDiagnostics({
  trip,
  trips = undefined,
  units = 'metric',
  loading = false,
  onShowAll = undefined,
  onDismiss = undefined,
  overlay = false,
  premium = true,
}) {
  const overviewTrips = Array.isArray(trips) ? trips.filter(Boolean) : null;
  const model = buildPremiumMapDiagnosticsModel(
    overviewTrips ? buildPremiumMapDiagnosticsAggregate(overviewTrips) : trip,
    units,
  );
  const statusLabel = loading
    ? 'Loading'
    : overviewTrips
      ? `${overviewTrips.length} route${overviewTrips.length === 1 ? '' : 's'}`
      : 'Standard';
  const statusDetail = overviewTrips ? 'on map' : model.evidence;
  const metrics = [
    { label: 'Distance', value: model.distance, icon: RoadMetricIcon, tone: 'emerald' },
    { label: 'Maximum speed', value: model.maximumSpeed, icon: SpeedMetricIcon, tone: 'blue' },
    { label: 'Events', value: model.eventCount, icon: EventMetricIcon, tone: 'violet' },
    { label: 'Stops', value: model.stops, icon: StopMetricIcon, tone: 'amber' },
  ];

  return (
    <section
      className={`premium-map-diagnostics${overlay ? ' premium-map-diagnostics--overlay' : ''}${typeof onDismiss === 'function' ? ' premium-map-diagnostics--dismissible' : ''}${premium ? '' : ' premium-map-diagnostics--standard'}`}
      aria-labelledby="premium-map-diagnostics-title"
      data-visual-experience={premium ? 'premium' : 'standard'}
    >
      {typeof onDismiss === 'function' && (
        <button
          type="button"
          className="premium-map-diagnostics-dismiss"
          onClick={onDismiss}
          aria-label="Hide route diagnostics"
          title="Hide route diagnostics"
        />
      )}
      {premium && <img className="premium-map-diagnostics-art" src={premiumMapRouteIntelligence} alt="" aria-hidden="true" />}
      <div className="premium-map-diagnostics-head">
        <div className="premium-map-diagnostics-title">
          <span className="premium-map-radar" aria-hidden="true"><Activity /></span>
          <div>
            <span className="premium-map-kicker">Route intelligence</span>
            <h2 id="premium-map-diagnostics-title">Route diagnostics</h2>
          </div>
        </div>
        <div className="premium-map-score" title={overviewTrips
          ? `Premium diagnostics for ${overviewTrips.length} filtered route${overviewTrips.length === 1 ? '' : 's'} shown on the map`
          : `Standard route diagnostics; ${model.evidence} scoring evidence`}>
          <ShieldCheck aria-hidden="true" />
          <span>{statusLabel}</span>
          <small>{statusDetail}</small>
        </div>
      </div>

      <div className="premium-map-diagnostic-grid">
        {metrics.map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="premium-map-diagnostic-metric" data-tone={tone}>
            <span className="premium-map-diagnostic-icon" aria-hidden="true"><Icon /></span>
            <strong>{loading ? '—' : value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>

      <div className="premium-map-diagnostic-strip">
        <div className="premium-map-diagnostic-stack">
          <div><Clock3 aria-hidden="true" /><span><strong>{model.duration}</strong><small>Recorded time</small></span></div>
          <div><Radio aria-hidden="true" /><span><strong>{model.gpsPoints} GPS</strong><small>Raw readings</small></span></div>
        </div>
        <div><Activity aria-hidden="true" /><span><strong>{model.averageSpeed}</strong><small>{overlay ? 'average including stops' : 'Average including stops'}</small></span></div>
        <div title={model.satellitesAvailable ? 'Satellites used for the recorded GPS fix' : 'Satellite count was not recorded for this trip'}>
          <Satellite aria-hidden="true" /><span><strong>{model.satellites}</strong><small>Satellites</small></span>
        </div>
      </div>

      {typeof onShowAll === 'function' && (
        <button type="button" className="premium-map-show-all" onClick={onShowAll}>
          <Route aria-hidden="true" /> <span>Show all routes</span>
        </button>
      )}
    </section>
  );
}
