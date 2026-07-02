// @ts-check
import { lazy, Suspense, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { AlertTriangle, ArrowLeft, CalendarDays, Gauge, Map, Route, Timer } from 'lucide-react';
import { tripDetailQueryOptions } from '@/api/trips';
import { formatDateTime, formatDistance, formatDuration, formatSpeed } from '@/lib/tripEngine';
import { buildPlaybackTimeline, prepareMapRoutePoints } from '@/lib/mapPlaybackInsights';
import { getTripDisplayName } from '@/lib/tripMetadata';
import { recordSystemEvent } from '@/lib/systemLog';

const TripDrive3D = lazy(() => import('@/components/TripDrive3D'));

const routePointCount = (trip = {}) => (
  Array.isArray(trip.route_points) ? trip.route_points.length : 0
);

const canShow3D = (trip = {}) => (
  trip?.privacy_mode !== 'summary_only' &&
  !trip?.route_data_expired_at &&
  routePointCount(trip) > 1
);

function unavailableReason(trip = {}) {
  if (trip?.privacy_mode === 'summary_only') return 'This private trip saved summary data only.';
  if (trip?.route_data_expired_at) return 'Route coordinates for this trip have expired.';
  return 'This trip does not have enough saved GPS points.';
}

export default function TripDrive3DPage({ embeddedTrip = null, embeddedLoading = false }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryId = id || embeddedTrip?.id || '';
  const { data: fetchedTrip, isLoading: fetchedLoading } = useQuery({
    ...tripDetailQueryOptions(queryId),
    enabled: Boolean(queryId && !embeddedTrip),
  });
  const trip = embeddedTrip || fetchedTrip;
  const isLoading = embeddedLoading || fetchedLoading;

  const points = prepareMapRoutePoints(trip?.route_points || [], { maxPoints: 900 });
  const events = Array.isArray(trip?.driving_events) ? trip.driving_events : [];
  const timeline = buildPlaybackTimeline(points, events);
  const title = trip ? getTripDisplayName(trip) : '3D Drive';
  const available = Boolean(trip && canShow3D(trip));
  const distanceKm = Number(trip?.distance_km) > 0 ? Number(trip.distance_km) : timeline.stats.distanceKm;
  const durationSeconds = Number(trip?.duration_seconds) > 0 ? Number(trip.duration_seconds) : timeline.stats.durationSeconds;
  const maxSpeedKmh = Number(trip?.max_speed_kmh) > 0 ? Number(trip.max_speed_kmh) : timeline.stats.maxSpeedKmh;

  useEffect(() => {
    if (!trip?.id) return;
    recordSystemEvent('trip_3d_page_opened', {
      trip_id: trip.id,
      available,
      route_point_count: routePointCount(trip),
      event_count: events.length,
    }, {
      category: 'navigation',
      title: '3D drive page opened',
    });
  }, [available, events.length, trip?.id, trip?.route_points]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-40 animate-pulse rounded-xl bg-secondary/60" />
        <div className="h-[520px] animate-pulse rounded-2xl bg-secondary/50" />
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="flex min-h-[55vh] flex-col items-center justify-center text-center">
        <AlertTriangle className="mb-4 h-10 w-10 text-muted-foreground" />
        <div className="font-semibold">Trip not found</div>
        <button onClick={() => navigate('/trips')} className="mt-4 text-sm font-semibold text-primary">
          Back to trips
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-4">
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"
      >
        <div className="min-w-0">
          <button
            onClick={() => navigate(`/trips/${trip.id}`)}
            className="mb-2 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Trip details
          </button>
          <h1 className="truncate font-grotesk text-2xl font-bold">{title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3.5 w-3.5" />
              {formatDateTime(trip.start_time || trip.created_at)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Route className="h-3.5 w-3.5" />
              {routePointCount(trip)} GPS
            </span>
            <span className="inline-flex items-center gap-1">
              <Map className="h-3.5 w-3.5" />
              {events.length} events
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:w-[30rem]">
          {[
            { label: 'Distance', value: formatDistance(distanceKm), icon: Route },
            { label: 'Duration', value: durationSeconds ? formatDuration(durationSeconds) : '-', icon: Timer },
            { label: 'Max speed', value: formatSpeed(maxSpeedKmh), icon: Gauge },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-border bg-card px-3 py-2">
              <div className="flex items-center gap-1 text-[10px] font-bold uppercase text-muted-foreground">
                <Icon className="h-3 w-3" />
                {label}
              </div>
              <div className="mt-1 truncate font-grotesk text-lg font-bold">{value}</div>
            </div>
          ))}
        </div>
      </motion.div>

      {available ? (
        <Suspense fallback={<div className="flex h-[560px] items-center justify-center rounded-2xl border border-border bg-secondary/50 text-sm text-muted-foreground">Loading 3D drive...</div>}>
          <TripDrive3D
            trip={trip}
            events={events}
            height="clamp(470px, calc(100dvh - 15rem), 780px)"
          />
        </Suspense>
      ) : (
        <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-dashed border-border bg-secondary/30 px-6 text-center text-sm text-muted-foreground">
          {unavailableReason(trip)}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-card p-3 text-xs text-muted-foreground">
        <span>{timeline.stats.stopCount} stops - {timeline.stats.violationCount} over-limit segments - {Math.round(timeline.stats.avgSpeedKmh || 0)} km/h average</span>
        <Link to={`/trips/${trip.id}`} className="font-semibold text-primary">
          Open full trip details
        </Link>
      </div>
    </div>
  );
}
