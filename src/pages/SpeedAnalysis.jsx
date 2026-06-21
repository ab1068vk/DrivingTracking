import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  Gauge,
  MapPin,
  ShieldCheck,
  TrendingDown,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { tripQueryKeys, tripService } from '@/api/trips';
import {
  calculateSegmentMetrics,
  formatDateTime,
  formatDistance,
  formatDuration,
  formatSpeed,
  getTripComponentScore,
  prefetchLocalKnowledge,
} from '@/lib/tripEngine';
import { buildPlaybackTimeline, prepareMapRoutePoints, SPEED_BANDS } from '@/lib/mapPlaybackInsights';
import { LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { getTripDisplayName } from '@/lib/tripMetadata';
import useLocalSettings from '@/hooks/useLocalSettings';
import { speedLimitSourceLabel } from '@/lib/speedLimitDisplay';
import { summarizeTripSpeedLimitIntelligence } from '@/lib/speedLimitIntelligence';

const TripPlayback = lazy(() => import('@/components/TripPlayback'));

const EVENT_LABELS = {
  speeding: 'Speeding',
  rapid_acceleration: 'Rapid acceleration',
  harsh_brake: 'Hard braking',
  erratic_speed: 'Erratic speed',
  idle: 'Long idle',
};

const eventTone = {
  speeding: 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
  rapid_acceleration: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-300',
  harsh_brake: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  erratic_speed: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300',
  idle: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
};

const cleanPoints = (points = []) => (
  (Array.isArray(points) ? points : [])
    .filter((point) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng)))
);

const pointTimestamp = (point) => {
  const time = new Date(point?.timestamp || point?.time || 0).getTime();
  return Number.isFinite(time) ? time : null;
};

const pointSpeed = (point) => {
  const speed = Number(point?.speed_kmh);
  return Number.isFinite(speed) && speed >= 0 ? speed : null;
};

const localLimitSourceLabel = (source) => {
  if (source === 'user_confirmed_posted_sign') return 'User-confirmed posted sign';
  if (source === 'user_entered_estimate') return 'Saved user estimate';
  if (source === 'learned_local' || source === 'trip_consensus' || source === 'time_of_day_bucket') return 'Learned local road speed';
  return source ? String(source).replace(/_/g, ' ') : 'Saved road speed';
};

function applyLocalSpeedKnowledgeToTrip(trip = {}, localKnowledgeResults = []) {
  const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
  if (!points.length || !localKnowledgeResults.some((item) => Number(item?.limitKmh) > 0)) {
    return { trip, savedLimitCount: 0, confirmedCount: 0, estimateCount: 0, learnedCount: 0, sources: [] };
  }

  const sourceCounts = new Map();
  let savedLimitCount = 0;
  let confirmedCount = 0;
  let estimateCount = 0;
  let learnedCount = 0;
  const route_points = points.map((point, index) => {
    const knowledge = localKnowledgeResults[index];
    const limitKmh = Number(knowledge?.limitKmh);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0) return point;
    const source = knowledge.source === 'user_confirmed_posted_sign'
      ? 'user_confirmed_posted_sign'
      : knowledge.source === 'user_entered_estimate' || knowledge.source === 'user_correction'
        ? 'user_entered_estimate'
        : knowledge.source || 'learned_local';
    savedLimitCount++;
    if (source === 'user_confirmed_posted_sign') confirmedCount++;
    else if (source === 'user_entered_estimate') estimateCount++;
    else learnedCount++;
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    return {
      ...point,
      speed_limit_kmh: limitKmh,
      speed_limit_source: source,
      speed_limit_confidence: knowledge.confidence ?? point.speed_limit_confidence,
      speed_limit_confidence_level: knowledge.confidenceLevel ?? point.speed_limit_confidence_level,
      speed_limit_verification_status: knowledge.verificationStatus ?? point.speed_limit_verification_status,
      speed_limit_verified_at: knowledge.verifiedAt ?? point.speed_limit_verified_at,
      speed_limit_needs_review: knowledge.needsReview ?? point.speed_limit_needs_review,
      speed_limit_road_name: knowledge.roadName || point.speed_limit_road_name,
      speed_limit_from_local_knowledge: true,
    };
  });

  return {
    trip: { ...trip, route_points },
    savedLimitCount,
    confirmedCount,
    estimateCount,
    learnedCount,
    sources: [...sourceCounts.entries()].map(([source, count]) => ({ source, count, label: localLimitSourceLabel(source) })),
  };
}

const percentile = (values, pct) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (pct / 100) * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
};

function buildSpeedAnalytics(trip = {}) {
  const points = prepareMapRoutePoints(cleanPoints(trip.route_points), { maxPoints: 1200 });
  const events = Array.isArray(trip.driving_events) ? trip.driving_events : [];
  const timeline = buildPlaybackTimeline(points, events);
  const speeds = points.map(pointSpeed).filter((speed) => speed != null);
  const movingSpeeds = speeds.filter((speed) => speed > 5);
  const averageMovingSpeed = Number(trip.avg_running_speed_kmh ?? trip.avg_speed_kmh);
  const maxSpeed = Number(trip.max_speed_kmh);
  const mean = movingSpeeds.length
    ? movingSpeeds.reduce((sum, speed) => sum + speed, 0) / movingSpeeds.length
    : 0;
  const deviation = movingSpeeds.length
    ? Math.sqrt(movingSpeeds.reduce((sum, speed) => sum + (speed - mean) ** 2, 0) / movingSpeeds.length)
    : 0;
  const variabilityPct = mean > 0 ? Math.round((deviation / mean) * 100) : 0;
  const smoothnessScore = getTripComponentScore(trip, 'speed_variability').value ?? trip.svi_score ?? null;
  const violations = timeline.violations || [];
  const timeOverSeconds = violations.reduce((sum, segment) => sum + (Number(segment.durationSeconds) || 0), 0);
  const maxOverLimit = violations.reduce((max, segment) => Math.max(max, Number(segment.overLimitKmh) || 0), 0);
  const fastestPoint = points.reduce((best, point) => {
    const speed = pointSpeed(point);
    if (speed == null) return best;
    return speed > (best?.speed_kmh || 0) ? { ...point, speed_kmh: speed } : best;
  }, null);
  const strongestAcceleration = points.reduce((best, point, index) => {
    if (index === 0) return best;
    const segment = calculateSegmentMetrics(points[index - 1], point);
    const prevSpeed = pointSpeed(points[index - 1]);
    const currSpeed = pointSpeed(point);
    if (!Number.isFinite(segment.dt) || segment.dt <= 0 || segment.dt > 20 || prevSpeed == null || currSpeed == null) return best;
    const accelMs2 = ((currSpeed - prevSpeed) / 3.6) / segment.dt;
    if (Math.abs(accelMs2) <= Math.abs(best?.accelMs2 || 0)) return best;
    return { point, accelMs2, speedDeltaKmh: currSpeed - prevSpeed };
  }, null);
  const eventCounts = events.reduce((counts, event) => {
    if (!EVENT_LABELS[event?.type]) return counts;
    counts[event.type] = (counts[event.type] || 0) + 1;
    return counts;
  }, {});
  const speedSeries = points.map((point, index) => {
    const firstMs = pointTimestamp(points[0]);
    const currentMs = pointTimestamp(point);
    return {
      index,
      label: currentMs != null && firstMs != null
        ? `${Math.round((currentMs - firstMs) / 60000)}m`
        : `${index + 1}`,
      speed: Math.round(pointSpeed(point) || 0),
      limit: Number.isFinite(Number(point.speed_limit_kmh)) ? Math.round(Number(point.speed_limit_kmh)) : null,
    };
  });
  const bandRows = SPEED_BANDS.map((band, index) => {
    const next = SPEED_BANDS[index + 1];
    const segments = timeline.segments.filter((segment) => segment.band?.id === band.id);
    return {
      id: band.id,
      label: band.label,
      color: band.color,
      range: next ? `${band.min}-${next.min - 1} km/h` : `${band.min}+ km/h`,
      distanceKm: segments.reduce((sum, segment) => sum + (Number(segment.distanceKm) || 0), 0),
      durationSeconds: segments.reduce((sum, segment) => sum + (Number(segment.durationSeconds) || 0), 0),
    };
  }).filter((row) => row.distanceKm > 0 || row.durationSeconds > 0);
  const eventRows = Object.entries(EVENT_LABELS).map(([type, label]) => ({
    type,
    label,
    count: eventCounts[type] || 0,
  })).filter((row) => row.count > 0);
  const speedInsightRows = [
    fastestPoint ? {
      label: 'Fastest point',
      value: `${Math.round(fastestPoint.speed_kmh)} km/h`,
      detail: fastestPoint.timestamp ? formatDateTime(fastestPoint.timestamp) : 'Time unavailable',
    } : null,
    violations.length > 0 ? {
      label: 'Largest limit gap',
      value: `${Math.round(maxOverLimit)} km/h over`,
      detail: `${violations.length} over-limit segment${violations.length === 1 ? '' : 's'}`,
    } : null,
    strongestAcceleration ? {
      label: strongestAcceleration.accelMs2 >= 0 ? 'Sharpest acceleration' : 'Sharpest braking',
      value: `${Math.abs(strongestAcceleration.accelMs2).toFixed(1)} m/s2`,
      detail: `${Math.round(Math.abs(strongestAcceleration.speedDeltaKmh))} km/h change`,
    } : null,
    timeline.stops?.length ? {
      label: 'Longest stop',
      value: formatDuration(Math.max(...timeline.stops.map((stop) => stop.durationSeconds || 0))),
      detail: `${timeline.stops.length} stop${timeline.stops.length === 1 ? '' : 's'} detected`,
    } : null,
  ].filter(Boolean);

  return {
    timeline,
    speedSeries,
    bandRows,
    eventRows,
    speedInsightRows,
    averageMovingSpeed: Number.isFinite(averageMovingSpeed) ? averageMovingSpeed : timeline.stats.avgSpeedKmh,
    maxSpeed: Number.isFinite(maxSpeed) && maxSpeed > 0 ? maxSpeed : timeline.stats.maxSpeedKmh,
    p85Speed: percentile(movingSpeeds, 85),
    variabilityPct,
    smoothnessScore,
    timeOverSeconds,
    maxOverLimit,
    pointCount: points.length,
  };
}

function MetricCard({ icon: Icon, label, value, detail, tone = 'text-primary' }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <Icon className={`mb-3 h-4 w-4 ${tone}`} />
      <div className="font-grotesk text-2xl font-bold">{value}</div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {detail && <div className="mt-2 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

export default function SpeedAnalysis() {
  const { id } = useParams();
  const navigate = useNavigate();
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const [speedKnowledgeRevision, setSpeedKnowledgeRevision] = useState(0);
  const [speedLimitLocalKnowledgeResults, setSpeedLimitLocalKnowledgeResults] = useState([]);
  const { data: trip, isLoading } = useQuery({
    queryKey: tripQueryKeys.detail(id),
    queryFn: () => tripService.getById(id),
  });
  useEffect(() => {
    let cancelled = false;
    const loadLocalSpeedKnowledge = async () => {
      const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
      if (!points.length) {
        if (!cancelled) setSpeedLimitLocalKnowledgeResults([]);
        return;
      }
      const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
      const results = typeof knowledge.getForPoints === 'function'
        ? await knowledge.getForPoints(points).catch(() => points.map(() => null))
        : await prefetchLocalKnowledge(points, knowledge).catch(() => points.map(() => null));
      if (!cancelled) setSpeedLimitLocalKnowledgeResults(results);
    };
    loadLocalSpeedKnowledge();
    return () => {
      cancelled = true;
    };
  }, [trip?.id, trip?.route_points, speedKnowledgeRevision]);

  useEffect(() => {
    const onSpeedKnowledgeChanged = () => {
      setSpeedKnowledgeRevision((value) => value + 1);
    };
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onSpeedKnowledgeChanged);
    return () => window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onSpeedKnowledgeChanged);
  }, []);

  const localSpeedKnowledge = useMemo(
    () => applyLocalSpeedKnowledgeToTrip(trip || {}, speedLimitLocalKnowledgeResults),
    [speedLimitLocalKnowledgeResults, trip]
  );
  const speedTrip = localSpeedKnowledge.trip;
  const analytics = useMemo(() => buildSpeedAnalytics(speedTrip || {}), [speedTrip]);
  const limitIntelligence = useMemo(
    () => summarizeTripSpeedLimitIntelligence(speedTrip || {}),
    [speedTrip]
  );

  if (isLoading) {
    return (
      <div className="space-y-4 pb-4">
        <div className="h-10 w-40 animate-pulse rounded-xl bg-secondary/50" />
        <div className="h-96 animate-pulse rounded-3xl bg-secondary/50" />
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <AlertTriangle className="mb-4 h-12 w-12 text-muted-foreground" />
        <div className="font-semibold">Trip not found</div>
        <button onClick={() => navigate('/trips')} className="mt-4 text-sm text-primary">
          Back to trips
        </button>
      </div>
    );
  }

  const noRoute = trip.privacy_mode === 'summary_only' || trip.route_data_expired_at || analytics.pointCount === 0;
  const tripTitle = getTripDisplayName(trip);
  const speedLimitDetail = analytics.timeOverSeconds > 0
    ? `${formatDuration(analytics.timeOverSeconds)} above known or estimated limits`
    : 'No over-limit route segments in saved route data';

  return (
    <div className="space-y-6 pb-4">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to={`/trips/${id}`} className="mb-2 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Review
          </Link>
          <h1 className="text-2xl font-grotesk font-bold">Speed Analysis</h1>
          <p className="mt-1 text-sm text-muted-foreground">{tripTitle} - {formatDateTime(trip.start_time)}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <div className="rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-muted-foreground">
            {analytics.pointCount} GPS point{analytics.pointCount === 1 ? '' : 's'}
          </div>
          {localSpeedKnowledge.savedLimitCount > 0 && (
            <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300">
              {localSpeedKnowledge.confirmedCount > 0 ? `${localSpeedKnowledge.confirmedCount} confirmed sign` : `${localSpeedKnowledge.savedLimitCount} saved speed`} point{(localSpeedKnowledge.confirmedCount || localSpeedKnowledge.savedLimitCount) === 1 ? '' : 's'}
            </div>
          )}
        </div>
      </motion.div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          icon={Gauge}
          label="Moving average"
          value={formatSpeed(analytics.averageMovingSpeed, units)}
          detail={`85th percentile ${formatSpeed(analytics.p85Speed, units)}`}
        />
        <MetricCard
          icon={Zap}
          label="Peak speed"
          value={formatSpeed(analytics.maxSpeed, units)}
          detail={`${analytics.variabilityPct}% speed variability`}
          tone="text-orange-500"
        />
        <MetricCard
          icon={ShieldCheck}
          label="Speed-limit behavior"
          value={analytics.maxOverLimit > 0 ? `${Math.round(analytics.maxOverLimit)} over` : 'Within'}
          detail={speedLimitDetail}
          tone={analytics.maxOverLimit > 0 ? 'text-red-500' : 'text-emerald-500'}
        />
        <MetricCard
          icon={TrendingDown}
          label="Smoothness"
          value={analytics.smoothnessScore == null ? 'Learning' : Math.round(analytics.smoothnessScore)}
          detail="From speed variability scoring"
          tone="text-sky-500"
        />
      </div>

      <section className="border-y border-border bg-card py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="font-semibold">Speed-Limit Intelligence</h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Coverage and certainty are kept separate. Estimated traffic behavior can request review, but it does not become posted-sign evidence.
            </p>
          </div>
          <Link
            to={`/speed-limits?tripId=${id}`}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold hover:bg-secondary"
          >
            <MapPin className="h-3.5 w-3.5" />
            Review road speeds
          </Link>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="border-l-4 border-emerald-500 pl-3">
            <div className="text-2xl font-bold">{limitIntelligence.coveragePercent}%</div>
            <div className="text-xs text-muted-foreground">Limit coverage</div>
          </div>
          <div className="border-l-4 border-sky-500 pl-3">
            <div className="text-2xl font-bold">{limitIntelligence.verifiedCoveragePercent}%</div>
            <div className="text-xs text-muted-foreground">Verified coverage</div>
          </div>
          <div className="border-l-4 border-amber-500 pl-3">
            <div className="text-2xl font-bold">{limitIntelligence.lowConfidencePointCount}</div>
            <div className="text-xs text-muted-foreground">Low-confidence points</div>
          </div>
          <div className="border-l-4 border-red-500 pl-3">
            <div className="text-2xl font-bold">{limitIntelligence.overLimitPointCount}</div>
            <div className="text-xs text-muted-foreground">Points above limit + margin</div>
          </div>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <div className="text-xs font-semibold">Evidence sources</div>
            <div className="mt-2 space-y-2">
              {limitIntelligence.sources.length > 0 ? limitIntelligence.sources.map((source) => (
                <div key={source.source} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">{speedLimitSourceLabel(source.source)}</span>
                  <span className="font-semibold">{source.count} point{source.count === 1 ? '' : 's'}</span>
                </div>
              )) : (
                <div className="text-xs text-muted-foreground">No speed-limit evidence is stored for this route.</div>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-background p-3">
            <div className="text-xs font-semibold">Recommended actions</div>
            <div className="mt-2 space-y-2 text-xs text-muted-foreground">
              {limitIntelligence.recommendations.map((recommendation) => (
                <div key={recommendation} className="flex gap-2">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  <span>{recommendation}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {noRoute ? (
        <section className="flex h-[260px] items-center justify-center rounded-3xl border border-dashed border-border bg-secondary/30 px-6 text-center text-sm text-muted-foreground">
          Speed map and replay need saved GPS route coordinates for this trip.
        </section>
      ) : (
        <section className="rounded-3xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Advanced Speed Map</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Speed-colored route, replay marker, events, stops, timeline scrubber, and saved road-speed compliance.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
              {localSpeedKnowledge.savedLimitCount > 0 ? (
                <>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1"><span className="h-2 w-2 rounded-full bg-emerald-500" />Within saved limit</span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1"><span className="h-2 w-2 rounded-full bg-orange-500" />Over saved limit</span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1"><span className="h-2 w-2 rounded-full bg-red-500" />Well over</span>
                </>
              ) : SPEED_BANDS.map((band) => (
                  <span key={band.id} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: band.color }} />
                    {band.label}
                  </span>
                ))}
            </div>
          </div>
          {localSpeedKnowledge.savedLimitCount > 0 && (
            <div className="mb-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
              This map is using saved local road-speed knowledge first. {localSpeedKnowledge.sources.map((source) => `${source.count} ${source.label}`).join(', ')}.
            </div>
          )}
          <Suspense fallback={<div className="flex h-[420px] items-center justify-center rounded-2xl bg-secondary/50 text-sm text-muted-foreground">Loading speed replay...</div>}>
            <TripPlayback trip={speedTrip} height="430px" colorMode={localSpeedKnowledge.savedLimitCount > 0 ? 'speedLimit' : 'speedBand'} />
          </Suspense>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
        <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
          <h2 className="font-semibold">Speed Timeline</h2>
          <p className="mt-1 text-xs text-muted-foreground">Actual speed with saved speed-limit line when available</p>
          <div className="mt-3 flex flex-wrap gap-3 text-xs font-medium text-muted-foreground" aria-label="Speed timeline legend">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-5 rounded bg-blue-600" />
              Blue: actual vehicle speed
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-5 border-t-2 border-dashed border-red-500" />
              Red dashed: saved or estimated speed limit
            </span>
          </div>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={analytics.speedSeries} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                  formatter={(value, name, item) => {
                    const label = item?.dataKey === 'limit' ? 'Speed limit' : 'Actual speed';
                    return [`${Math.round(Number(value) || 0)} km/h`, label];
                  }}
                />
                <Line type="monotone" dataKey="speed" stroke="#2563eb" strokeWidth={2.5} dot={false} name="Actual speed" />
                <Line type="stepAfter" dataKey="limit" stroke="#ef4444" strokeDasharray="5 5" strokeWidth={2} dot={false} name="Speed limit" connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
          <h2 className="font-semibold">Key Moments</h2>
          <div className="mt-3 space-y-2">
            {analytics.speedInsightRows.length > 0 ? analytics.speedInsightRows.map((row) => (
              <div key={row.label} className="rounded-2xl bg-secondary/50 p-3">
                <div className="text-xs font-medium text-muted-foreground">{row.label}</div>
                <div className="mt-1 font-grotesk text-xl font-bold">{row.value}</div>
                <div className="mt-1 text-xs text-muted-foreground">{row.detail}</div>
              </div>
            )) : (
              <div className="rounded-2xl bg-secondary/50 p-3 text-sm text-muted-foreground">
                More speed moments unlock after the route has speed, time, and event samples.
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
          <h2 className="font-semibold">Speed Bands</h2>
          <p className="mt-1 text-xs text-muted-foreground">How much of the trip happened in each speed range</p>
          <div className="mt-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.bandRows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                  formatter={(value) => [formatDistance(value, units), 'Distance']}
                />
                <Bar dataKey="distanceKm" radius={[5, 5, 0, 0]}>
                  {analytics.bandRows.map((row) => <Cell key={row.id} fill={row.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {analytics.bandRows.map((row) => (
              <div key={row.id} className="rounded-xl bg-secondary/50 px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />
                    {row.label}
                  </span>
                  <span className="text-muted-foreground">{row.range}</span>
                </div>
                <div className="mt-1 text-muted-foreground">{formatDistance(row.distanceKm, units)} - {formatDuration(row.durationSeconds)}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
          <h2 className="font-semibold">Speed Events</h2>
          <p className="mt-1 text-xs text-muted-foreground">Events connected to speed changes and compliance</p>
          <div className="mt-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={analytics.eventRows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                <Area type="monotone" dataKey="count" stroke="#f97316" fill="#f97316" fillOpacity={0.18} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {analytics.eventRows.length > 0 ? analytics.eventRows.map((row) => (
              <span key={row.type} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${eventTone[row.type]}`}>
                {row.count} {row.label}
              </span>
            )) : (
              <div className="rounded-xl bg-secondary/50 px-3 py-2 text-sm text-muted-foreground">
                No speed-related events recorded for this trip.
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <MapPin className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <h2 className="font-semibold">Review Connection</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The Review page stays focused on the overall drive score. This Speed Analysis page is the deep investigation for where speed changed, where limits mattered, and which exact moments shaped the speed story.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
