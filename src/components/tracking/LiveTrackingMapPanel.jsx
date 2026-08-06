import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Layers, MapPin, ShieldAlert, Gauge } from 'lucide-react';
import { tripDetailQueryOptions } from '@/api/trips';
import { buildRiskHotspots } from '@/lib/mediumInsights';
import { buildRouteRiskIndex, getSegmentsForTrip } from '@/lib/routeRiskIndex';
import { getPrivacyZones } from '@/lib/privacyZones';
import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { prefetchLocalKnowledge } from '@/lib/tripEngine';
import { liveRouteBucketKey } from '@/lib/liveTrackingTelemetry';
import { logError } from '@/lib/errorReporting';
import { LiveRoutePlot } from '@/components/tracking/LiveTelemetryViews';

const TripMap = lazy(() => import('@/components/TripMap'));

// Route-risk overlays need full trip records (route_points is a detail-only
// field), so each one is a separate IndexedDB read. Keep the live bound small.
const RISK_HISTORY_TRIP_LIMIT = 4;
const EMPTY_LIST = [];

// Number(null) and Number('') are both 0, so a bare Number.isFinite check would
// turn a missing coordinate into Null Island and drop the marker in the ocean.
const coordinate = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const validCoordinate = (point) => coordinate(point?.lat) != null
  && coordinate(point?.lng) != null
  && point?.masked_for_privacy !== true
  && point?.tracking_gap !== true
  && point?.route_gap !== true;

export function liveCurrentLocation(points = []) {
  const list = Array.isArray(points) ? points : EMPTY_LIST;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const point = list[index];
    if (validCoordinate(point)) {
      return {
        lat: coordinate(point.lat),
        lng: coordinate(point.lng),
        accuracy: coordinate(point.accuracy),
      };
    }
  }
  return null;
}

function LayerToggle({ active, onClick, icon: Icon, label, hint }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={hint}
      className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 text-xs font-semibold transition-colors ${
        active
          ? 'border-cyan-300/40 bg-cyan-300/15 text-cyan-100'
          : 'border-white/10 bg-white/5 text-slate-300 hover:text-white'
      }`}
    >
      <Icon className="h-4 w-4" />{label}
    </button>
  );
}

export default function LiveTrackingMapPanel({ snapshot, recentTrips = EMPTY_LIST, settings = {} }) {
  const [showRisk, setShowRisk] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  const [useTiles, setUseTiles] = useState(true);
  const [knowledgeResults, setKnowledgeResults] = useState(EMPTY_LIST);

  const points = snapshot?.routePreview || EMPTY_LIST;
  const bucketKey = liveRouteBucketKey(points);

  // Bucketed identity: TripMap refits its bounds when the route array identity
  // changes, and this panel re-renders once a second. Without this the map
  // would refit every tick.
  const routeRef = useRef(EMPTY_LIST);
  const bucketRef = useRef('');
  if (bucketRef.current !== bucketKey) {
    bucketRef.current = bucketKey;
    routeRef.current = points;
  }
  const stableRoute = routeRef.current;

  // The marker updates every tick from the raw points, so smooth motion is
  // preserved even though the route line only redraws per bucket.
  const currentLocation = useMemo(() => liveCurrentLocation(points), [points]);

  const dangerZones = useMemo(() => buildRiskHotspots(recentTrips), [recentTrips]);
  const privacyZones = useMemo(() => getPrivacyZones(settings), [settings]);

  const riskTripSummaries = useMemo(
    () => (showRisk ? recentTrips.slice(0, RISK_HISTORY_TRIP_LIMIT) : EMPTY_LIST),
    [recentTrips, showRisk]
  );
  const riskTripQueries = useQueries({
    queries: riskTripSummaries.map((trip) => tripDetailQueryOptions(trip.id)),
  });
  const riskTrips = riskTripQueries
    .map((query) => query.data)
    .filter((trip) => Array.isArray(trip?.route_points) && trip.route_points.length > 1);

  const routeRiskSegments = useMemo(() => {
    if (!showRisk || !riskTrips.length || stableRoute.length < 2) return EMPTY_LIST;
    const index = buildRouteRiskIndex(riskTrips, privacyZones);
    return getSegmentsForTrip({ route_points: stableRoute }, index);
    // riskTrips is rebuilt each render from the query results; the bucket key and
    // the resolved trip ids are what actually change the output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRisk, bucketKey, privacyZones, riskTrips.map((trip) => trip.id).join('|'), stableRoute.length]);

  useEffect(() => {
    if (!showLimits || stableRoute.length < 2) {
      setKnowledgeResults(EMPTY_LIST);
      return undefined;
    }
    let cancelled = false;
    const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
    prefetchLocalKnowledge(stableRoute, knowledge)
      .then((results) => {
        if (!cancelled) setKnowledgeResults(results || EMPTY_LIST);
      })
      .catch((error) => {
        logError('live_map_speed_knowledge_failed', error);
        if (!cancelled) setKnowledgeResults(EMPTY_LIST);
      });
    return () => {
      cancelled = true;
    };
  }, [showLimits, stableRoute]);

  const plottable = stableRoute.filter(validCoordinate).length;

  return (
    <div className="min-w-0 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Live route</div>
          <h2 className="mt-1 text-xl font-bold">{useTiles ? 'Mapped route' : 'Offline route trace'}</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <LayerToggle
            active={useTiles}
            onClick={() => setUseTiles((value) => !value)}
            icon={MapPin}
            label={useTiles ? 'Map tiles on' : 'Map tiles off'}
            hint="Turn tiles off for a fully offline, API-free route trace."
          />
          <LayerToggle
            active={showRisk}
            onClick={() => setShowRisk((value) => !value)}
            icon={ShieldAlert}
            label="Repeat risk"
            hint="Highlights road segments where your own past drives recorded repeated events. Reads recent trip history."
          />
          <LayerToggle
            active={showLimits}
            onClick={() => setShowLimits((value) => !value)}
            icon={Gauge}
            label="Speed limits"
            hint="Overlays saved local speed knowledge along the recorded route."
          />
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-white/10">
        {useTiles && plottable >= 2 ? (
          <Suspense fallback={<div className="h-[26rem] animate-pulse bg-slate-900/70" />}>
            <TripMap
              routePoints={stableRoute}
              currentLocation={currentLocation}
              showCurrentLocation
              smoothRoute={false}
              showIncompleteRouteWarning={false}
              showRouteSummary={false}
              showDangerZones={dangerZones.length > 0}
              dangerZones={dangerZones}
              showRouteRisk={showRisk}
              routeRiskSegments={routeRiskSegments}
              showSpeedLimits={showLimits}
              speedLimitKnowledgeResults={knowledgeResults}
              height="26rem"
            />
          </Suspense>
        ) : (
          <div className="p-3">
            <LiveRoutePlot points={stableRoute} maskedCount={snapshot?.routeMaskedCount || 0} />
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5"><Layers className="h-3.5 w-3.5" />{plottable} plottable of {stableRoute.length} preview samples</span>
        {snapshot?.routeMaskedCount > 0 && <span>{snapshot.routeMaskedCount} privacy-masked</span>}
        {dangerZones.length > 0 && <span>{dangerZones.length} repeat-event area{dangerZones.length === 1 ? '' : 's'} from your history</span>}
        {showRisk && !riskTrips.length && <span>Loading route history for the risk overlay…</span>}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        The route line redraws in batches to keep the map cheap during a drive; the position marker tracks every fix.
        Turn map tiles off for a fully offline view. Keep attention on the road — review detail when parked.
      </p>
    </div>
  );
}
