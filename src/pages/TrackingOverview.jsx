import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Bell,
  ChevronRight,
  Gauge,
  Map,
  Mic,
  Route,
  Radio,
  ShieldCheck,
  Square,
  Signal,
} from 'lucide-react';
import { limitedTripSummaryQueryOptions, tripSummaryQueryOptions } from '@/api/trips';
import useLocalSettings from '@/hooks/useLocalSettings';
import { ACTIVE_TRIP_CHANGED_EVENT, activeTripStore } from '@/lib/trackingStore';
import { getPermissionStatus } from '@/lib/permissions';
import { endNativeActiveTrip, getNativeAutoTrackingStatus, normalizeNativeActiveTrip } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import {
  buildDashboardTrackingExplanation,
  getTrackingDiagnostics,
} from '@/lib/trackingDiagnostics';
import { getVoiceAlertDeliveryStatus } from '@/lib/voiceAlerts';
import { requestAppAlert, requestAppConfirm } from '@/lib/appDialog';
import DeferredRecharts from '@/components/DeferredRecharts';
import { buildTrackingTrendSeries } from '@/lib/trackingTelemetryAnalytics';

const RECENT_TRIP_LIMIT = 12;

const statusStyles = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
  warn: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
  error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300',
  neutral: 'border-border bg-secondary/60 text-muted-foreground',
};

const compactDate = (value) => {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unavailable';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
};

const formatDistance = (trip) => {
  const distance = Number(trip?.distance_km);
  return Number.isFinite(distance) ? `${distance.toFixed(distance >= 10 ? 0 : 1)} km` : '-';
};

const formatDuration = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '-';
  const minutes = Math.round(value / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const scoreEstimate = (trip) => {
  const score = Number(trip?.score_overall ?? trip?.overall_score ?? trip?.score);
  return Number.isFinite(score) ? Math.round(score) : null;
};

const routePointCount = (trip) => {
  if (Array.isArray(trip?.route_points)) return trip.route_points.length;
  const count = Number(trip?.route_point_count ?? trip?.route_points_count ?? trip?.route_points_retained);
  return Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
};

const eventCount = (trip) => {
  if (Array.isArray(trip?.driving_events)) return trip.driving_events.length;
  const count = Number(trip?.driving_events_count ?? trip?.event_count);
  return Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
};

function modeLabel(settings = {}) {
  if (settings.tracking_paused) return 'Tracking paused';
  if (settings.tracking_mode === 'background_auto') return 'Background auto tracking armed';
  if (settings.tracking_mode === 'auto_detect' || settings.auto_tracking_enabled) return 'Auto tracking armed';
  return 'Manual tracking ready';
}

function privacySyncStatus(settings = {}) {
  if (settings.privacy_zones_native_sync_status === 'failed') {
    return {
      tone: 'error',
      label: 'Native privacy-zone sync failed',
      detail: settings.privacy_zones_native_sync_failed_at
        ? `Last failure ${compactDate(settings.privacy_zones_native_sync_failed_at)}.`
        : 'Privacy zones remain local; Android native sync needs review.',
    };
  }
  if (settings.privacy_zones_native_sync_status === 'ok') {
    return {
      tone: 'good',
      label: 'Native privacy-zone sync ok',
      detail: `${Number(settings.privacy_zones_native_sync_zone_count) || 0} zone(s) available to native tracking.`,
    };
  }
  return {
    tone: 'neutral',
    label: 'Privacy-zone sync local',
    detail: 'Privacy zones are enforced by the app and export masking.',
  };
}

function permissionTone(value) {
  if (value === 'granted') return 'good';
  if (value === 'denied' || value === 'unavailable') return 'error';
  return 'warn';
}

function trackingExplanationTone(status) {
  if (status === 'good') return 'good';
  if (status === 'warn') return 'warn';
  return 'error';
}

export default function TrackingOverview() {
  const settings = useLocalSettings();
  const queryClient = useQueryClient();
  const [webActiveTrip, setWebActiveTrip] = useState(() => activeTripStore.get());
  const [endingNativeTrip, setEndingNativeTrip] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState(() => ({
    foregroundLocation: settings.location_permission_granted ? 'granted' : 'unknown',
    backgroundLocation: settings.background_location_granted ? 'granted' : 'unknown',
    activityRecognition: settings.activity_permission_granted ? 'granted' : 'unknown',
    notifications: settings.notification_permission_granted ? 'granted' : 'unknown',
  }));
  const [nativeStatus, setNativeStatus] = useState(() => ({ enabled: false, recordingActive: false, activeTrip: null, completedTripsCount: 0 }));
  const diagnostics = useMemo(() => getTrackingDiagnostics(), []);

  const recentTripsQuery = useQuery(limitedTripSummaryQueryOptions(RECENT_TRIP_LIMIT));
  const allTripsQuery = useQuery(tripSummaryQueryOptions());
  const recentTrips = Array.isArray(recentTripsQuery.data) ? recentTripsQuery.data : [];
  const allTrips = Array.isArray(allTripsQuery.data) ? allTripsQuery.data : recentTrips;
  const trendSeries = useMemo(() => buildTrackingTrendSeries(allTrips), [allTrips]);
  const latestTrip = recentTrips[0] || null;
  const nativeActiveTrip = normalizeNativeActiveTrip(nativeStatus);
  const activeTrip = webActiveTrip || nativeActiveTrip;
  const displayTrip = activeTrip || latestTrip;

  useEffect(() => {
    let active = true;
    const refreshActiveTrip = () => {
      if (!active) return;
      setWebActiveTrip(activeTripStore.get());
    };
    refreshActiveTrip();
    const interval = window.setInterval(refreshActiveTrip, 5000);
    window.addEventListener(ACTIVE_TRIP_CHANGED_EVENT, refreshActiveTrip);
    window.addEventListener('focus', refreshActiveTrip);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener(ACTIVE_TRIP_CHANGED_EVENT, refreshActiveTrip);
      window.removeEventListener('focus', refreshActiveTrip);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let statusRefresh = null;
    const refreshNativeStatus = () => {
      if (statusRefresh || document.visibilityState === 'hidden') return statusRefresh;
      statusRefresh = getNativeAutoTrackingStatus()
        .then((status) => {
          if (active && status) setNativeStatus(status);
          return status;
        })
        .catch(() => null)
        .finally(() => {
          statusRefresh = null;
        });
      return statusRefresh;
    };
    getPermissionStatus()
      .then((status) => {
        if (active && status) setPermissionStatus(status);
      })
      .catch(() => {});
    void refreshNativeStatus();
    const interval = window.setInterval(refreshNativeStatus, 3000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshNativeStatus();
    };
    window.addEventListener('focus', refreshNativeStatus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshNativeStatus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const trackingExplanation = buildDashboardTrackingExplanation({
    settings,
    permissionStatus,
    nativeStatus,
    diagnostics,
    latestTrip,
    tracking: Boolean(activeTrip),
    isAndroidPlatform: isAndroid(),
  });
  const voiceStatus = getVoiceAlertDeliveryStatus({
    settings,
    trip: activeTrip,
    isAndroidPlatform: isAndroid(),
    nativeStatus,
    tracking: Boolean(activeTrip),
  });
  const privacyStatus = privacySyncStatus(settings);
  const locationPermission = permissionStatus.foregroundLocation || 'unknown';
  const routePoints = routePointCount(displayTrip);
  const score = scoreEstimate(displayTrip);

  const endNativeRecording = async () => {
    if (!nativeActiveTrip || endingNativeTrip) return;
    const confirmed = await requestAppConfirm({
      title: 'End active recording?',
      message: 'The native trip will be finalized and added to your local trip history.',
      confirmLabel: 'End recording',
      cancelLabel: 'Keep recording',
      destructive: true,
    });
    if (!confirmed) return;
    setEndingNativeTrip(true);
    try {
      await endNativeActiveTrip({ keepArmed: settings.tracking_mode === 'background_auto' && !settings.tracking_paused });
      let finalizedStatus = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        finalizedStatus = await getNativeAutoTrackingStatus().catch(() => null);
        if (finalizedStatus?.recordingActive !== true) break;
      }
      const { syncNativeCompletedTrips } = await import('@/lib/localTripRepository');
      await syncNativeCompletedTrips();
      await queryClient.invalidateQueries({ queryKey: ['trip-summaries'] });
      setNativeStatus(finalizedStatus || ((current) => ({ ...current, recordingActive: false, activeTrip: null })));
    } catch (error) {
      await requestAppAlert({
        title: 'Recording could not be ended',
        message: error?.message || 'The native recorder did not confirm that the trip ended. It may still be recording.',
      });
    } finally {
      setEndingNativeTrip(false);
    }
  };

  const activeRecordingLabel = activeTrip?.state === 'candidate' || activeTrip?.trip_state === 'candidate'
    ? 'Checking movement'
    : 'Recording active';
  const activeRecordingDetail = nativeActiveTrip
    ? 'Android is recording this trip in the background. This status updates from the native recorder.'
    : activeTrip
    ? 'The in-app recorder is actively collecting trip data.'
    : trackingExplanation.detail;

  const statusStrip = [
    {
      icon: Activity,
      tone: activeTrip ? 'good' : trackingExplanationTone(trackingExplanation.status),
      label: activeTrip ? activeRecordingLabel : modeLabel(settings),
      detail: activeRecordingDetail,
    },
    {
      icon: Signal,
      tone: permissionTone(locationPermission),
      label: locationPermission === 'granted' ? 'GPS permission available' : 'GPS permission unavailable',
      detail: `Foreground location: ${locationPermission}.`,
    },
    {
      icon: Gauge,
      tone: nativeStatus?.enabled ? 'good' : settings.tracking_mode === 'background_auto' ? 'warn' : 'neutral',
      label: nativeActiveTrip ? activeRecordingLabel : nativeStatus?.enabled ? 'Native auto tracking armed' : modeLabel(settings),
      detail: nativeActiveTrip ? 'Android native trip recording is active.' : nativeStatus?.enabled ? 'Android native service is armed and waiting for driving.' : 'Native background service is not active.',
    },
    {
      icon: Mic,
      tone: voiceStatus.status === 'disabled' ? 'warn' : 'good',
      label: voiceStatus.label,
      detail: voiceStatus.detail,
    },
    {
      icon: ShieldCheck,
      tone: privacyStatus.tone,
      label: privacyStatus.label,
      detail: privacyStatus.detail,
    },
  ];

  return (
    <div className="min-w-0 space-y-3">
      <header className="flex flex-col gap-3 border-b border-border pb-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-normal text-muted-foreground">Advanced Tracking Mode</div>
          <h1 className="mt-1 font-grotesk text-2xl font-bold tracking-normal">Tracking Overview</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Local telemetry view for recording state, permissions, recent trips, route retention, and diagnostics.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusChip tone="neutral">Completed trips: {allTrips.length}</StatusChip>
          <StatusChip tone={activeTrip ? 'good' : 'neutral'}>{activeTrip ? activeRecordingLabel : 'No active recording'}</StatusChip>
        </div>
      </header>

      <section aria-label="Live recording control" className={activeTrip ? 'rounded-lg border border-emerald-300 bg-emerald-50/70 p-3 dark:border-emerald-900/70 dark:bg-emerald-950/20' : 'rounded-lg border border-border bg-card p-3'}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className={activeTrip ? 'grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-600 text-white' : 'grid h-10 w-10 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground'}>
              {activeTrip ? <Radio className="h-5 w-5 animate-pulse" /> : <Activity className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{activeTrip ? activeRecordingLabel : 'No trip is currently recording'}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {activeTrip
                  ? nativeActiveTrip ? 'Native background recorder is supplying the live status below.' : 'The in-app recorder is supplying the live status below.'
                  : nativeStatus?.enabled ? 'Automatic tracking is armed. You can also open the manual recorder.' : 'Open the recorder to start a manual trip, or enable automatic tracking in Settings.'}
              </p>
              {activeTrip && (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium">
                  <span>{formatDistance(activeTrip)}</span>
                  <span>{formatDuration(activeTrip.duration_seconds)}</span>
                  <span>{Math.max(0, Math.round(Number(activeTrip.speed_kmh) || 0))} km/h</span>
                  <span>{routePointCount(activeTrip)} points</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {nativeActiveTrip ? (
              <button
                type="button"
                onClick={endNativeRecording}
                disabled={endingNativeTrip}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-red-600 px-3 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-wait disabled:opacity-70"
              >
                <Square className="h-3.5 w-3.5" />
                {endingNativeTrip ? 'Ending...' : 'End recording'}
              </button>
            ) : (
              <Link
                to="/tracking/recorder"
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
              >
                <Radio className="h-4 w-4" />
                {activeTrip ? 'Open recorder' : 'Open manual recorder'}
              </Link>
            )}
          </div>
        </div>
      </section>

      <section aria-label="Tracking status strip" className="grid min-w-0 gap-2 md:grid-cols-2 xl:grid-cols-5">
        {statusStrip.map(({ icon: Icon, tone, label, detail }, index) => (
          <div key={`${label}-${index}`} className="min-w-0 rounded-lg border border-border bg-card p-3">
            <div className="flex min-w-0 items-center gap-2">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <StatusChip tone={tone}>{label}</StatusChip>
            </div>
            <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{detail}</p>
          </div>
        ))}
      </section>

      <TrackingTrendChart rows={trendSeries} />

      <section className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.05fr)_minmax(20rem,0.95fr)_minmax(18rem,0.7fr)]">
        <RecentTripsTable trips={recentTrips} loading={recentTripsQuery.isLoading} />

        <div className="min-w-0 rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
            <div>
              <h2 className="text-sm font-semibold">{activeTrip ? 'Live route summary' : 'Last route summary'}</h2>
              <p className="text-xs text-muted-foreground">{activeTrip ? 'Current recording snapshot' : 'Latest completed trip snapshot'}</p>
            </div>
            <Route className="h-4 w-4 text-muted-foreground" />
          </div>
          {displayTrip ? (
            <div className="grid gap-3 p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MetricCell label="Distance" value={formatDistance(displayTrip)} />
                <MetricCell label="Duration" value={formatDuration(displayTrip.duration_seconds)} />
                <MetricCell label="Events recorded" value={String(eventCount(displayTrip))} />
                <MetricCell label="Route points retained" value={String(routePoints)} />
              </div>
              <div className="min-h-52 rounded-lg border border-dashed border-border bg-secondary/40 p-3">
                <div className="flex h-full min-h-44 flex-col justify-between">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Route surface</div>
                      <div className="mt-1 text-sm font-medium">{activeTrip ? 'Recording active' : 'Completed route available'}</div>
                    </div>
                    <Map className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <div>Started: {compactDate(displayTrip.start_time)}</div>
                    <div>Ended: {displayTrip.end_time ? compactDate(displayTrip.end_time) : 'Recording active'}</div>
                    <div>Source: {displayTrip.start_source || displayTrip.source || 'source unavailable'}</div>
                    <div>Confidence: {displayTrip.score_provenance?.components?.overall || displayTrip.score_safety_confidence || 'confidence low'}</div>
                  </div>
                </div>
              </div>
              {score != null && (
                <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold">Score estimate</span>
                    <span className="font-grotesk text-xl font-bold">{score}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Evidence: {displayTrip.score_provenance?.components?.overall || displayTrip.score_safety_confidence || 'confidence low'}.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <EmptyPanel title="No route data available" detail="Start tracking or import completed local trips to populate this route summary." />
          )}
        </div>

        <aside className="min-w-0 rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
            <div>
              <h2 className="text-sm font-semibold">Inspector</h2>
              <p className="text-xs text-muted-foreground">Read-only tracking details</p>
            </div>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="grid gap-3 p-3">
            <InspectorRow label="Tracking state" value={activeTrip ? 'Recording active' : trackingExplanation.headline} />
            <InspectorRow label="Tracking mode" value={modeLabel(settings)} />
            <InspectorRow label="GPS permission" value={locationPermission === 'granted' ? 'available' : 'unavailable'} />
            <InspectorRow label="Voice delivery" value={voiceStatus.label} />
            <InspectorRow label="Privacy sync" value={privacyStatus.label} />
            <InspectorRow label="Diagnostics events" value={String(diagnostics.events?.length || 0)} />
            <div className="rounded-lg border border-border bg-secondary/30 p-3">
              <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Latest diagnostic</div>
              <div className="mt-1 text-sm font-medium">
                {trackingExplanation.lastDecision?.title || trackingExplanation.lastDecision?.type || 'source unavailable'}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {trackingExplanation.lastDecision?.detail || trackingExplanation.detail}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <LinkButton to="/tracking/map" icon={Map}>Map</LinkButton>
              <LinkButton to="/tracking/events" icon={Bell}>Events</LinkButton>
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}

function TrackingTrendChart({ rows }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-1 border-b border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="text-sm font-semibold">Recent telemetry trend</h2><p className="text-xs text-muted-foreground">Up to 30 completed trips; observations are normalized per 10 km.</p></div>
        <StatusChip tone="neutral">{rows.length} plotted trips</StatusChip>
      </div>
      {rows.length ? <div className="p-3">
        <DeferredRecharts height={220}>{({ ResponsiveContainer, ComposedChart, Bar, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend }) => (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="label" minTickGap={22} />
              <YAxis yAxisId="left" width={58} />
              <YAxis yAxisId="right" orientation="right" width={50} />
              <Tooltip />
              <Legend />
              <Bar yAxisId="left" dataKey="distanceKm" name="Distance (km)" fill="#94a3b8" opacity={0.45} />
              <Line yAxisId="left" type="monotone" dataKey="averageSpeedKmh" name="Average speed (km/h)" stroke="#2563eb" strokeWidth={2} dot={false} connectNulls />
              <Line yAxisId="right" type="monotone" dataKey="eventRate" name="Observations / 10 km" stroke="#f97316" strokeWidth={2} dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        )}</DeferredRecharts>
      </div> : <EmptyPanel title="No trend data available" detail="Complete trips to populate distance, average speed, and normalized observation trends." />}
    </section>
  );
}

function StatusChip({ tone = 'neutral', children }) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-1 text-[11px] font-semibold leading-none ${statusStyles[tone] || statusStyles.neutral}`}>
      <span className="truncate">{children}</span>
    </span>
  );
}

function MetricCell({ label, value }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-secondary/30 p-3">
      <div className="truncate text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-grotesk text-xl font-bold">{value}</div>
    </div>
  );
}

function InspectorRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="max-w-[60%] text-right text-xs font-semibold">{value}</span>
    </div>
  );
}

function EmptyPanel({ title, detail }) {
  return (
    <div className="p-6 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-lg border border-border bg-secondary/50 text-muted-foreground">
        <Route className="h-5 w-5" />
      </div>
      <h3 className="mt-3 text-sm font-semibold">{title}</h3>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

function LinkButton({ to, icon: Icon, children }) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      <Icon className="h-4 w-4" />
      {children}
    </Link>
  );
}

function RecentTripsTable({ trips, loading }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold">Recent trips</h2>
          <p className="text-xs text-muted-foreground">Completed trip summaries</p>
        </div>
        <Link to="/trips" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground" aria-label="Open trips">
          <ChevronRight className="h-4 w-4" />
        </Link>
      </div>
      {loading ? (
        <EmptyPanel title="Loading trip summaries" detail="Reading local completed-trip summaries." />
      ) : trips.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead className="border-b border-border bg-secondary/40 text-[11px] uppercase tracking-normal text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-semibold">Start</th>
                <th className="px-3 py-2 font-semibold">Distance</th>
                <th className="px-3 py-2 font-semibold">Duration</th>
                <th className="px-3 py-2 font-semibold">Events</th>
                <th className="px-3 py-2 font-semibold">Index estimate</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((trip) => {
                const score = scoreEstimate(trip);
                return (
                  <tr key={trip.id || trip.start_time} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">
                      <Link to={trip.id ? `/trips/${trip.id}` : '/trips'} className="font-medium text-foreground hover:underline">
                        {compactDate(trip.start_time)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDistance(trip)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDuration(trip.duration_seconds)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{eventCount(trip)}</td>
                    <td className="px-3 py-2">
                      <StatusChip tone={score == null ? 'neutral' : 'good'}>{score == null ? 'Unavailable' : score}</StatusChip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyPanel title="No completed trips" detail="Completed local trip summaries will appear here after recording or native sync." />
      )}
    </div>
  );
}
