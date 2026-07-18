// @ts-check
import {
  Activity,
  Clock3,
  Gauge,
  MapPinned,
  Octagon,
  Radio,
  Route,
  Satellite,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import premiumMapRouteIntelligence from '@/assets/premium-map-route-intelligence.png';
import { formatDistance, formatDuration, formatSpeed, getTripComponentScore } from '@/lib/tripEngine';
import { formatScoreWithProvenance } from '@/lib/scoreDisplay';

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

export default function PremiumMapDiagnostics({ trip, units = 'metric', loading = false, onShowAll, overlay = false }) {
  const model = buildPremiumMapDiagnosticsModel(trip, units);
  const metrics = [
    { label: 'Distance', value: model.distance, icon: Route, tone: 'emerald' },
    { label: 'Maximum speed', value: model.maximumSpeed, icon: Gauge, tone: 'blue' },
    { label: 'Events', value: model.eventCount, icon: TriangleAlert, tone: 'violet' },
    { label: 'Traffic stops', value: model.stops, icon: Octagon, tone: 'amber' },
  ];

  return (
    <section className={`premium-map-diagnostics${overlay ? ' premium-map-diagnostics--overlay' : ''}`} aria-labelledby="premium-map-diagnostics-title">
      <img className="premium-map-diagnostics-art" src={premiumMapRouteIntelligence} alt="" aria-hidden="true" />
      <div className="premium-map-diagnostics-head">
        <div className="premium-map-diagnostics-title">
          <span className="premium-map-radar" aria-hidden="true"><Activity /></span>
          <div>
            <span className="premium-map-kicker">Route intelligence</span>
            <h2 id="premium-map-diagnostics-title">Route diagnostics</h2>
          </div>
        </div>
        <div className="premium-map-score" title={`Standard route diagnostics; ${model.evidence} scoring evidence`}>
          <ShieldCheck aria-hidden="true" />
          <span>{loading ? 'Loading' : 'Standard'}</span>
          <small>{model.evidence}</small>
        </div>
      </div>

      <div className="premium-map-diagnostic-grid">
        {metrics.map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="premium-map-diagnostic-metric" data-tone={tone}>
            <Icon aria-hidden="true" />
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
        <div><MapPinned aria-hidden="true" /><span><strong>{model.averageSpeed}</strong><small>Average including stops</small></span></div>
        <div title={model.satellitesAvailable ? 'Satellites used for the recorded GPS fix' : 'Satellite count was not recorded for this trip'}>
          <Satellite aria-hidden="true" /><span><strong>{model.satellites}</strong><small>Satellites</small></span>
        </div>
      </div>

      <button type="button" className="premium-map-show-all" onClick={onShowAll}>
        <Route aria-hidden="true" /> <span>Show all routes</span>
      </button>
    </section>
  );
}
