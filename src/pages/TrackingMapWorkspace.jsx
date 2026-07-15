import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  EyeOff,
  Filter,
  Gauge,
  Layers,
  Map as MapIcon,
  Route,
  ShieldCheck,
} from 'lucide-react';
import { limitedTripSummaryQueryOptions, tripDetailQueryOptions } from '@/api/trips';
import TripMap from '@/components/TripMap';
import TripPlayback from '@/components/TripPlayback';
import {
  buildPlaybackTimeline,
  prepareMapRoutePoints,
} from '@/lib/mapPlaybackInsights';
import { prefetchLocalKnowledge } from '@/lib/tripEngine';
import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { buildRiskHotspots } from '@/lib/mediumInsights';
import { buildRouteRiskIndex, getSegmentsForTrip } from '@/lib/routeRiskIndex';
import {
  getPrivacyZones,
  maskEventsForPrivacy,
  maskRoutePointsForPrivacy,
} from '@/lib/privacyZones';
import useLocalSettings from '@/hooks/useLocalSettings';

const SUMMARY_LIMIT = 50;
const OVERVIEW_ROUTE_LIMIT = 6;
const EVENT_FILTERS = ['harsh_brake', 'rapid_acceleration', 'sharp_turn', 'speeding', 'phone_use', 'possible_crash'];

const MAP_ROUTE_COLORS = ['#2563eb', '#059669', '#f97316', '#7c3aed', '#0891b2', '#dc2626'];

const formatDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
    : 'Unavailable';
};

const titleCase = (value) => String(value || 'event')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

const hasRoute = (trip) => (
  Array.isArray(trip?.route_points) && trip.route_points.filter((point) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng))).length > 1
);

const pointPrivacyMasked = (point) => (
  point?.masked_for_privacy === true ||
  point?.privacy_gap === true ||
  point?.privacy_live_redacted === true ||
  point?.privacy_purged === true ||
  point?.privacy_boundary === true
);

const eventPrivacyMasked = (event) => (
  event?.privacy_event_redacted === true ||
  event?.masked_for_privacy === true ||
  event?.privacy_zone_id ||
  event?.privacy_zone_label ||
  !Number.isFinite(Number(event?.lat)) ||
  !Number.isFinite(Number(event?.lng))
);

const progressStyle = (start, end, color) => ({
  left: `${Math.max(0, Math.min(100, Number(start) || 0))}%`,
  width: `${Math.max(0.5, Math.min(100, (Number(end) || 0) - (Number(start) || 0)))}%`,
  backgroundColor: color,
});

export default function TrackingMapWorkspace() {
  const settings = useLocalSettings();
  const privacyZones = useMemo(() => getPrivacyZones(settings), [settings]);
  const [selectedTripId, setSelectedTripId] = useState('');
  const [savedFilter, setSavedFilter] = useState('all');
  const [eventFilters, setEventFilters] = useState(() => new Set(EVENT_FILTERS));
  const [surfaceMode, setSurfaceMode] = useState('map');
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [showSpeedLimits, setShowSpeedLimits] = useState(true);
  const [showRouteRisk, setShowRouteRisk] = useState(true);
  const [showDangerZones, setShowDangerZones] = useState(false);
  const [localKnowledgeResults, setLocalKnowledgeResults] = useState([]);
  const deferredSavedFilter = useDeferredValue(savedFilter);
  const deferredEventFilters = useDeferredValue(eventFilters);
  const deferredSurfaceMode = useDeferredValue(surfaceMode);
  const deferredShowSpeedLimits = useDeferredValue(showSpeedLimits);
  const deferredShowRouteRisk = useDeferredValue(showRouteRisk);
  const deferredShowDangerZones = useDeferredValue(showDangerZones);

  const { data: summaries = [], isLoading: summariesLoading } = useQuery({
    ...limitedTripSummaryQueryOptions(SUMMARY_LIMIT),
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });

  const filteredSummaries = useMemo(() => summaries.filter((trip) => {
    if (deferredSavedFilter === 'night') return trip.night_driving;
    if (deferredSavedFilter === 'events') return (
      Number(trip.harsh_brakes_count || 0) +
      Number(trip.rapid_accel_count || 0) +
      Number(trip.sharp_turns_count || 0) +
      Number(trip.speeding_events_count || 0)
    ) > 0;
    if (deferredSavedFilter === 'route_retained') return !trip.route_data_expired_at;
    return true;
  }), [deferredSavedFilter, summaries]);

  const effectiveSelectedTripId = selectedTripId || (filteredSummaries[0]?.id ? String(filteredSummaries[0].id) : '');
  const deferredSelectedTripId = useDeferredValue(effectiveSelectedTripId);
  const workspacePending = deferredSavedFilter !== savedFilter ||
    deferredEventFilters !== eventFilters ||
    deferredSurfaceMode !== surfaceMode ||
    deferredShowSpeedLimits !== showSpeedLimits ||
    deferredShowRouteRisk !== showRouteRisk ||
    deferredShowDangerZones !== showDangerZones ||
    deferredSelectedTripId !== effectiveSelectedTripId;
  const { data: selectedTripRaw, isLoading: selectedTripLoading } = useQuery(tripDetailQueryOptions(deferredSelectedTripId));
  const selectedTrip = selectedTripRaw || filteredSummaries.find((trip) => String(trip.id) === String(deferredSelectedTripId)) || null;

  const overviewTripSummaries = useMemo(
    () => effectiveSelectedTripId ? [] : filteredSummaries.slice(0, OVERVIEW_ROUTE_LIMIT),
    [effectiveSelectedTripId, filteredSummaries]
  );
  const overviewQueries = useQueries({
    queries: overviewTripSummaries.map((trip) => tripDetailQueryOptions(trip.id)),
  });
  const overviewTrips = overviewQueries.map((query) => query.data).filter(hasRoute);

  const visibleEvents = useMemo(() => {
    const rawEvents = settings.phone_use_show_on_map === false
      ? (selectedTrip?.driving_events || []).filter((event) => event.type !== 'phone_use')
      : (selectedTrip?.driving_events || []);
    const maskedEvents = maskEventsForPrivacy(rawEvents, settings);
    return maskedEvents.filter((event) => deferredEventFilters.has(event.type));
  }, [deferredEventFilters, selectedTrip, settings]);

  useEffect(() => {
    if (!visibleEvents.length) {
      setSelectedEvent(null);
      return;
    }
    if (!selectedEvent || !visibleEvents.some((event) => event === selectedEvent)) {
      setSelectedEvent(visibleEvents[0]);
    }
  }, [selectedEvent, visibleEvents]);

  const safeRoutePoints = useMemo(
    () => maskRoutePointsForPrivacy(selectedTrip?.route_points || [], settings),
    [selectedTrip, settings]
  );
  const visualRoutePoints = useMemo(
    () => prepareMapRoutePoints(safeRoutePoints, { maxPoints: null, smooth: false }),
    [safeRoutePoints]
  );
  const timeline = useMemo(
    () => buildPlaybackTimeline(visualRoutePoints, visibleEvents),
    [visibleEvents, visualRoutePoints]
  );

  useEffect(() => {
    let cancelled = false;
    const loadKnowledge = async () => {
      if (!selectedTrip?.route_points?.length) {
        setLocalKnowledgeResults([]);
        return;
      }
      const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
      const results = await prefetchLocalKnowledge(selectedTrip.route_points, knowledge).catch(() => []);
      if (!cancelled) setLocalKnowledgeResults(results);
    };
    loadKnowledge();
    return () => {
      cancelled = true;
    };
  }, [selectedTrip?.id, selectedTrip?.route_points]);

  const overlayTrips = useMemo(
    () => selectedTrip ? [selectedTrip, ...overviewTrips] : overviewTrips,
    [overviewTrips, selectedTrip]
  );
  const dangerZones = useMemo(() => buildRiskHotspots(overlayTrips), [overlayTrips]);
  const routeRiskIndex = useMemo(() => buildRouteRiskIndex(overlayTrips, privacyZones), [overlayTrips, privacyZones]);
  const routeRiskSegments = useMemo(
    () => selectedTrip ? getSegmentsForTrip(selectedTrip, routeRiskIndex) : [],
    [routeRiskIndex, selectedTrip]
  );

  const mapRoutes = useMemo(() => (
    selectedTrip && hasRoute(selectedTrip)
      ? [{
        id: selectedTrip.id,
        label: formatDate(selectedTrip.start_time),
        selected: true,
        color: '#2563eb',
        route_points: selectedTrip.route_points,
        rawPointCount: selectedTrip.route_points_raw_count,
      }]
      : overviewTrips.map((trip, index) => ({
        id: trip.id,
        label: formatDate(trip.start_time),
        selected: false,
        color: MAP_ROUTE_COLORS[index % MAP_ROUTE_COLORS.length],
        route_points: trip.route_points,
        rawPointCount: trip.route_points_raw_count,
      }))
  ), [overviewTrips, selectedTrip]);

  const routeGapCount = visualRoutePoints.filter((point) => point.tracking_gap || point.route_gap).length;
  const privacyGapCount = safeRoutePoints.filter(pointPrivacyMasked).length;
  const speedLimitChangeCount = timeline.segments.filter((segment, index, list) => (
    index > 0 && segment.speedLimitKmh != null && segment.speedLimitKmh !== list[index - 1].speedLimitKmh
  )).length;
  const inspectedEvent = selectedEvent || visibleEvents[0] || null;

  const toggleEventFilter = (type) => {
    setEventFilters((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div className="tracking-map-workspace flex min-h-[calc(100dvh-8.5rem)] min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-background/80 px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-bold text-muted-foreground">Advanced trip tracking</div>
          <h1 className="font-grotesk text-xl font-bold tracking-normal">Route Map</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {workspacePending && <span className="rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs font-semibold text-muted-foreground">Applying selection</span>}
          <SegmentedButton active={surfaceMode === 'map'} onClick={() => setSurfaceMode('map')}>Map</SegmentedButton>
          <SegmentedButton active={surfaceMode === 'playback'} onClick={() => setSurfaceMode('playback')}>Playback</SegmentedButton>
          <IconToggle active={showSpeedLimits} onClick={() => setShowSpeedLimits((value) => !value)} icon={Gauge} label="Speed limits" />
          <IconToggle active={showRouteRisk} onClick={() => setShowRouteRisk((value) => !value)} icon={Route} label="Route risk" />
          <IconToggle active={showDangerZones} onClick={() => setShowDangerZones((value) => !value)} icon={AlertTriangle} label="Danger zones" />
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[17rem_minmax(0,1fr)_19rem]">
        <aside className="min-h-0 border-b border-border bg-card/70 lg:border-b-0 lg:border-r">
          <div className="flex h-full min-h-0 flex-col">
            <PaneHeader icon={Filter} title="Choose a trip" detail={`${filteredSummaries.length} local trip summaries`} />
            <div className="space-y-3 overflow-y-auto p-3">
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Saved filters</div>
                <div className="grid grid-cols-2 gap-1">
                  {[
                    ['all', 'All'],
                    ['night', 'Night'],
                    ['events', 'Events'],
                    ['route_retained', 'Route retained'],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setSavedFilter(id)}
                      className={`rounded-md border px-2 py-1.5 text-xs font-semibold ${savedFilter === id ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-secondary'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Event type filters</div>
                <div className="grid gap-1">
                  {EVENT_FILTERS.map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => toggleEventFilter(type)}
                      className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-xs font-semibold ${eventFilters.has(type) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-secondary'}`}
                    >
                      <span>{titleCase(type)}</span>
                      <span>{visibleEvents.filter((event) => event.type === type).length}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Trip selector</div>
                <div className="grid gap-1">
                  {summariesLoading && <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">Loading trip summaries</div>}
                  {!summariesLoading && filteredSummaries.length === 0 && (
                    <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">No completed trips match the selected filter.</div>
                  )}
                  {filteredSummaries.slice(0, 28).map((trip) => (
                    <button
                      key={trip.id}
                      type="button"
                      onClick={() => {
                        setSelectedTripId(String(trip.id));
                        setSelectedEvent(null);
                      }}
                      className={`rounded-md border px-2 py-2 text-left text-xs ${String(effectiveSelectedTripId) === String(trip.id) ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary/70'}`}
                    >
                      <div className="font-semibold">{formatDate(trip.start_time)}</div>
                      <div className="mt-1 text-muted-foreground">{Number(trip.distance_km || 0).toFixed(1)} km / {trip.route_data_expired_at ? 'route expired' : 'route retained'}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </aside>

        <main className="relative min-h-[32rem] min-w-0 bg-secondary/30">
          {selectedTripLoading && !selectedTrip ? (
            <WorkspaceEmpty title="Loading selected trip" detail="Reading local route detail." />
          ) : selectedTrip && hasRoute(selectedTrip) ? (
            deferredSurfaceMode === 'playback' ? (
              <div className="h-full p-2">
                <TripPlayback trip={{ ...selectedTrip, route_points: safeRoutePoints, driving_events: visibleEvents }} height="calc(100dvh - 18rem)" />
              </div>
            ) : (
              <TripMap
                routes={mapRoutes}
                events={visibleEvents}
                height="100%"
                className="h-full min-h-[32rem]"
                showSpeedLimits={deferredShowSpeedLimits}
                showRouteRisk={deferredShowRouteRisk}
                routeRiskSegments={routeRiskSegments}
                showDangerZones={deferredShowDangerZones}
                dangerZones={dangerZones}
                speedLimitKnowledgeResults={localKnowledgeResults}
                onEventSelect={setSelectedEvent}
              />
            )
          ) : (
            <WorkspaceEmpty title="No route selected" detail="Select a completed trip with retained route points." />
          )}
        </main>

        <aside className="min-h-0 border-t border-border bg-card/80 lg:border-l lg:border-t-0">
          <div className="flex h-full min-h-0 flex-col">
            <PaneHeader icon={Layers} title="Route details" detail="Selected layer and event details" />
            <div className="space-y-3 overflow-y-auto p-3 text-sm">
              <InspectorRow label="Selected trip" value={selectedTrip ? formatDate(selectedTrip.start_time) : 'source unavailable'} />
              <InspectorRow label="Route points retained" value={String(visualRoutePoints.length)} />
              <InspectorRow label="Route gaps" value={String(routeGapCount)} />
              <InspectorRow label="Privacy gaps" value={String(privacyGapCount)} />
              <InspectorRow label="Speed-limit changes" value={String(speedLimitChangeCount)} />
              <InspectorRow label="Local speed knowledge" value={`${localKnowledgeResults.filter(Boolean).length} point matches`} />
              <InspectorRow label="Danger zones" value={`${dangerZones.length} computed`} />
              <InspectorRow label="Route risk segments" value={`${routeRiskSegments.length} visible`} />

              <div className="rounded-lg border border-border bg-secondary/30 p-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                  <MapIcon className="h-4 w-4" />
                  Selected Event
                </div>
                {inspectedEvent ? (
                  <div className="mt-2 space-y-2 text-xs">
                    <InspectorRow label="Type" value={titleCase(inspectedEvent.type)} />
                    <InspectorRow label="Time" value={formatDate(inspectedEvent.timestamp || inspectedEvent.startTime)} />
                    <InspectorRow label="Speed" value={Number.isFinite(Number(inspectedEvent.speed_kmh)) ? `${Math.round(Number(inspectedEvent.speed_kmh))} km/h` : 'source unavailable'} />
                    <InspectorRow label="Source" value={inspectedEvent.source || inspectedEvent.speed_limit_source || 'source unavailable'} />
                    <InspectorRow label="Coordinates" value={eventPrivacyMasked(inspectedEvent) ? 'privacy masked' : 'available on map marker'} />
                    {eventPrivacyMasked(inspectedEvent) && (
                      <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                        Privacy masked event. Raw coordinates are not shown in the inspector.
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Select an event marker or timeline row to inspect neutral telemetry details.</p>
                )}
              </div>

              <div className="rounded-lg border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
                <div className="flex items-center gap-2 font-semibold text-foreground">
                  <ShieldCheck className="h-4 w-4" />
                  Privacy handling
                </div>
                <p className="mt-2 leading-relaxed">
                  Privacy-masked points and events are represented as gaps or redacted rows. Raw coordinates are not displayed in this workspace.
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <TimelineTracks
        timeline={timeline}
        routePoints={visualRoutePoints}
        events={visibleEvents}
        selectedEvent={inspectedEvent}
        onSelectEvent={setSelectedEvent}
        pending={workspacePending}
      />
    </div>
  );
}

function PaneHeader({ icon: Icon, title, detail }) {
  return (
    <div className="shrink-0 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function SegmentedButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground hover:bg-secondary'}`}
    >
      {children}
    </button>
  );
}

function IconToggle({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold ${active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:bg-secondary'}`}
      aria-pressed={active}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function InspectorRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/50 pb-2 last:border-0 last:pb-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="max-w-[62%] text-right text-xs font-semibold">{value}</span>
    </div>
  );
}

function WorkspaceEmpty({ title, detail }) {
  return (
    <div className="grid h-full min-h-[32rem] place-items-center p-6 text-center">
      <div>
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-lg border border-border bg-card text-muted-foreground">
          <MapIcon className="h-5 w-5" />
        </div>
        <h2 className="mt-3 text-sm font-semibold">{title}</h2>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function TimelineTracks({ timeline, routePoints, events, selectedEvent, onSelectEvent, pending = false }) {
  const duration = Math.max(1, Number(timeline.stats?.durationSeconds) || 1);
  const routeGaps = routePoints
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => point.tracking_gap || point.route_gap);
  const privacyGaps = routePoints
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => pointPrivacyMasked(point));
  const speedLimitRuns = timeline.segments.filter((segment) => segment.speedLimitKmh != null);

  return (
    <section role="region" aria-label="Map workspace timeline" className="shrink-0 border-t border-border bg-card/95 px-3 py-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Timeline tracks</div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {pending && <span className="font-semibold text-foreground">Applying selection</span>}
          <span>Speed</span>
          <span>Events</span>
          <span>Route gaps</span>
          <span>Privacy gaps</span>
          <span>Speed-limit changes</span>
        </div>
      </div>
      <div className="space-y-1.5">
        <Track label="Speed">
          {timeline.segments.map((segment) => (
            <span key={segment.id} className="absolute top-1 h-3 rounded-sm" style={progressStyle(segment.timeProgressStart, segment.timeProgressEnd, segment.speedBandColor || '#64748b')} />
          ))}
        </Track>
        <Track label="Events">
          {events.map((event, index) => {
            const timelineEvent = timeline.events.find((item) => item === event || (item.timestamp === event.timestamp && item.type === event.type));
            const left = timelineEvent ? Math.max(0, Math.min(100, (timelineEvent.offsetSeconds / duration) * 100)) : 0;
            const masked = eventPrivacyMasked(event);
            return (
              <button
                key={`${event.type}-${event.timestamp || index}`}
                type="button"
                onClick={() => onSelectEvent(event)}
                className={`absolute top-0 h-5 w-2 -translate-x-1 rounded-sm ${selectedEvent === event ? 'bg-primary' : masked ? 'bg-amber-500' : 'bg-red-500'}`}
                style={{ left: `${left}%` }}
                title={`${titleCase(event.type)}${masked ? ' privacy masked' : ''}`}
              />
            );
          })}
        </Track>
        <Track label="Route gaps">
          {routeGaps.map(({ index }) => (
            <span key={`route-gap-${index}`} className="absolute top-0 h-5 w-1 rounded-sm bg-slate-500" style={{ left: `${routePoints.length > 1 ? (index / (routePoints.length - 1)) * 100 : 0}%` }} />
          ))}
        </Track>
        <Track label="Privacy gaps">
          {privacyGaps.map(({ index }) => (
            <span
              key={`privacy-gap-${index}`}
              className="absolute top-0 grid h-5 w-5 -translate-x-2 place-items-center rounded-full bg-amber-100 text-amber-700 ring-1 ring-amber-300"
              style={{ left: `${routePoints.length > 1 ? (index / (routePoints.length - 1)) * 100 : 0}%` }}
            >
              <EyeOff className="h-3 w-3" />
            </span>
          ))}
        </Track>
        <Track label="Speed limits">
          {speedLimitRuns.map((segment) => (
            <span key={`limit-${segment.id}`} className="absolute top-1 h-3 rounded-sm" style={progressStyle(segment.timeProgressStart, segment.timeProgressEnd, segment.speedLimitColor || '#22c55e')} />
          ))}
        </Track>
      </div>
    </section>
  );
}

function Track({ label, children }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
      <div className="truncate text-[11px] font-semibold text-muted-foreground">{label}</div>
      <div className="relative h-5 min-w-0 overflow-hidden rounded bg-secondary">
        {children}
      </div>
    </div>
  );
}
