import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Bell,
  ChevronRight,
  Clock3,
  Gauge,
  Map,
  Navigation,
  Mic,
  Route,
  Radio,
  Satellite,
  ShieldCheck,
  Square,
  Signal,
  TimerReset,
  TrendingUp,
  Waves,
  Zap,
} from 'lucide-react';
import { tripSummaryQueryOptions } from '@/api/trips';
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
import { buildLiveTrackingSnapshot, formatLiveDuration } from '@/lib/liveTrackingTelemetry';
import {
  formatDistance as formatTripDistance,
  formatDuration as formatTripDuration,
  formatSpeed as formatTripSpeed,
} from '@/lib/tripEngine';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import {
  convertDistanceKm,
  convertPerDistanceRate,
  convertSpeedKmh,
  distanceUnitLabel,
  formatPerDistanceRate,
  speedUnitLabel,
} from '@/lib/unitFormatting';
import { Button } from '@/components/ui/button';
import PostDriveReviewCard from '@/components/PostDriveReviewCard';
import usePendingPostDriveReview from '@/hooks/usePendingPostDriveReview';

const OVERVIEW_TRIP_LIMIT = 30;
const RECENT_TRIP_TABLE_LIMIT = 8;

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

const formatDistance = (trip, units = 'metric') => {
  const distance = Number(trip?.distance_km);
  return Number.isFinite(distance) ? formatTripDistance(distance, units) : '-';
};

const formatDuration = (seconds) => {
  if (seconds == null || seconds === '') return '-';
  const value = Number(seconds);
  return Number.isFinite(value) && value >= 0 ? formatTripDuration(value) : '-';
};

const convertTrendUnits = (rows, units = 'metric') => {
  if (units !== 'imperial') return rows;
  return rows.map((row) => ({
    ...row,
    distanceKm: convertDistanceKm(row.distanceKm, units),
    averageSpeedKmh: convertSpeedKmh(row.averageSpeedKmh, units),
    eventRate: convertPerDistanceRate(row.eventRate, units),
  }));
};

const scoreEstimate = (trip) => {
  const score = Number(trip?.score_overall ?? trip?.overall_score ?? trip?.score);
  return Number.isFinite(score) ? Math.round(score) : null;
};

const routePointCount = (trip) => {
  if (Array.isArray(trip?.route_points)) return trip.route_points.length;
  if (Array.isArray(trip?.route_preview) && trip.route_preview.length) {
    const reported = Number(trip?.route_point_count);
    return Number.isFinite(reported) ? Math.max(0, Math.round(reported)) : trip.route_preview.length;
  }
  const count = Number(
    trip?.route_points_map_count
      ?? trip?.route_point_count
      ?? trip?.route_points_count
      ?? trip?.route_points_retained
  );
  return Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
};

const eventCount = (trip) => {
  if (Array.isArray(trip?.driving_events)) return trip.driving_events.length;
  if (Array.isArray(trip?.live_events)) return trip.live_events.length;
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

function buildOverviewIntelligence(trips = []) {
  const rows = Array.isArray(trips) ? trips : [];
  const weekCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const totals = rows.reduce((summary, trip) => {
    const distance = Number(trip?.distance_km);
    const duration = Number(trip?.duration_seconds);
    const startedAt = new Date(trip?.start_time || 0).getTime();
    const points = routePointCount(trip);
    const events = eventCount(trip);
    summary.distanceKm += Number.isFinite(distance) ? Math.max(0, distance) : 0;
    summary.durationSeconds += Number.isFinite(duration) ? Math.max(0, duration) : 0;
    summary.events += events;
    summary.routeRetained += points > 1 ? 1 : 0;
    if (Number.isFinite(startedAt) && startedAt >= weekCutoff) {
      summary.weekTrips += 1;
      summary.weekDistanceKm += Number.isFinite(distance) ? Math.max(0, distance) : 0;
    }
    return summary;
  }, {
    distanceKm: 0,
    durationSeconds: 0,
    events: 0,
    routeRetained: 0,
    weekTrips: 0,
    weekDistanceKm: 0,
  });
  const routeCoverage = rows.length ? Math.round((totals.routeRetained / rows.length) * 100) : 0;
  const eventRate = totals.distanceKm > 0 ? (totals.events / totals.distanceKm) * 100 : null;
  const confidence = rows.length >= 5 && routeCoverage >= 80
    ? { label: 'Strong', tone: 'good', detail: 'Enough recent routes are retained for dependable comparisons.' }
    : rows.length
      ? { label: 'Developing', tone: 'warn', detail: 'More completed routes will improve trend and comparison confidence.' }
      : { label: 'Waiting for drives', tone: 'neutral', detail: 'Complete a few drives to establish advanced tracking context.' };
  return {
    rows: rows.length,
    weekTrips: totals.weekTrips,
    weekDistanceKm: totals.weekDistanceKm,
    routeCoverage,
    eventRate,
    confidence,
  };
}

export default function TrackingOverview() {
  const navigate = useNavigate();
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const queryClient = useQueryClient();
  const [webActiveTrip, setWebActiveTrip] = useState(() => activeTripStore.get());
  const [endingNativeTrip, setEndingNativeTrip] = useState(false);
  const [liveView, setLiveView] = useState('drive');
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const [permissionStatus, setPermissionStatus] = useState(() => ({
    foregroundLocation: settings.location_permission_granted ? 'granted' : 'unknown',
    backgroundLocation: settings.background_location_granted ? 'granted' : 'unknown',
    activityRecognition: settings.activity_permission_granted ? 'granted' : 'unknown',
    notifications: settings.notification_permission_granted ? 'granted' : 'unknown',
  }));
  const [nativeStatus, setNativeStatus] = useState(() => ({ enabled: false, recordingActive: false, activeTrip: null, completedTripsCount: 0 }));
  const diagnostics = useMemo(() => getTrackingDiagnostics(), []);

  const summariesQuery = useQuery(tripSummaryQueryOptions());
  const allTrips = Array.isArray(summariesQuery.data) ? summariesQuery.data : [];
  const recentTrips = useMemo(() => allTrips.slice(0, OVERVIEW_TRIP_LIMIT), [allTrips]);
  const {
    dismiss: dismissPostDriveReview,
    showTrip: showPostDriveReview,
    trip: postDriveReviewTrip,
  } = usePendingPostDriveReview(recentTrips);
  const trendSeries = useMemo(
    () => convertTrendUnits(buildTrackingTrendSeries(recentTrips), units),
    [recentTrips, units]
  );
  const intelligence = useMemo(() => {
    const recent = buildOverviewIntelligence(recentTrips);
    const completeHistory = buildOverviewIntelligence(allTrips);
    return {
      ...recent,
      weekTrips: completeHistory.weekTrips,
      weekDistanceKm: completeHistory.weekDistanceKm,
    };
  }, [allTrips, recentTrips]);
  const latestTrip = recentTrips[0] || null;
  const nativeActiveTrip = normalizeNativeActiveTrip(nativeStatus);
  const activeTrip = webActiveTrip || nativeActiveTrip;
  const displayTrip = activeTrip || latestTrip;
  const liveSnapshot = useMemo(
    () => activeTrip ? buildLiveTrackingSnapshot(activeTrip, liveNowMs) : null,
    [activeTrip, liveNowMs]
  );

  useEffect(() => {
    if (!activeTrip) return undefined;
    setLiveNowMs(Date.now());
    const interval = window.setInterval(() => setLiveNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [Boolean(activeTrip)]);

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
    const interval = window.setInterval(refreshNativeStatus, 2000);
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
      const syncResult = await syncNativeCompletedTrips();
      const completedNativeTrip = syncResult?.matchedActiveTrip || syncResult?.importedTrips?.[0] || null;
      if (completedNativeTrip) {
        await showPostDriveReview(completedNativeTrip, 'tracking_native_completion');
      }
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
    <div className="min-w-0 space-y-5 pb-2">
      {activeTrip && liveSnapshot ? (
        <LiveTrackingCockpit
          snapshot={liveSnapshot}
          units={units}
          view={liveView}
          onViewChange={setLiveView}
          nativeActive={Boolean(nativeActiveTrip)}
          ending={endingNativeTrip}
          onEnd={endNativeRecording}
        />
      ) : (
      <section aria-labelledby="tracking-home-title" className="tracking-home-hero rounded-3xl p-5 sm:p-7">
        <div className="relative z-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white/90 ring-1 ring-white/20">
              <span className={`h-2 w-2 rounded-full ${activeTrip ? 'animate-pulse bg-emerald-300' : nativeStatus?.enabled ? 'bg-sky-200' : 'bg-white/60'}`} />
              {activeTrip ? activeRecordingLabel : nativeStatus?.enabled ? 'Automatic tracking is ready' : 'Ready for your next drive'}
            </div>
            <h1 id="tracking-home-title" className="mt-4 font-grotesk text-3xl font-bold tracking-tight sm:text-4xl">
              {activeTrip ? 'Your drive is being tracked' : 'Track your next drive'}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/80 sm:text-base">
              {activeTrip
                ? nativeActiveTrip ? 'Road Sage is recording this drive in the background. Live distance, time, speed, and route points stay visible here.' : 'The in-app recorder is collecting this drive. Open it for live controls and trip details.'
                : nativeStatus?.enabled ? 'Automatic tracking is armed and waiting for driving. You can also start a manual recording at any time.' : 'Start a manual recording now, or turn on automatic tracking in Settings for hands-free trip capture.'}
            </p>

            {activeTrip ? (
              <div className="mt-5 grid max-w-2xl grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Live trip measurements">
                <HeroMetric label="Distance" value={formatDistance(activeTrip, units)} />
                <HeroMetric label="Time" value={formatDuration(activeTrip.duration_seconds)} />
                <HeroMetric label="Current speed" value={formatTripSpeed(Math.max(0, Number(activeTrip.speed_kmh) || 0), units)} />
                <HeroMetric label="Route points" value={String(routePointCount(activeTrip))} />
              </div>
            ) : (
              <div className="mt-5 flex flex-wrap gap-2 text-xs font-medium text-white/80">
                <span className="rounded-full bg-white/10 px-3 py-1.5 ring-1 ring-white/20">GPS: {locationPermission === 'granted' ? 'ready' : 'needs attention'}</span>
                <span className="rounded-full bg-white/10 px-3 py-1.5 ring-1 ring-white/20">{recentTrips.length} recent trips ready</span>
                <span className="rounded-full bg-white/10 px-3 py-1.5 ring-1 ring-white/20">Privacy masking on</span>
              </div>
            )}
          </div>

          <div className="relative z-10 flex min-w-52 flex-col gap-2">
            {nativeActiveTrip ? (
              <Button
                type="button"
                variant="destructive"
                size="lg"
                onClick={endNativeRecording}
                loading={endingNativeTrip}
                loadingText="Ending recording..."
                className="min-h-12 rounded-xl px-5 shadow-lg"
              >
                <Square className="h-4 w-4" />
                End recording
              </Button>
            ) : (
              <Button asChild size="lg" className="min-h-12 rounded-xl bg-white px-5 text-slate-950 shadow-lg hover:bg-white/90">
                <Link to="/tracking/recorder">
                  <Radio className="h-5 w-5" />
                  {activeTrip ? 'Open live recorder' : 'Start tracking'}
                </Link>
              </Button>
            )}
            <Button asChild variant="outline" className="min-h-11 rounded-xl border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white">
              <Link to="/tracking/map"><Map className="h-4 w-4" />Open route map</Link>
            </Button>
          </div>
        </div>
      </section>
      )}

      {!activeTrip && postDriveReviewTrip && (
        <PostDriveReviewCard
          trip={postDriveReviewTrip}
          previousTrips={recentTrips}
          units={units}
          mode="tracking"
          onDismiss={dismissPostDriveReview}
          onOpenTrip={() => navigate(`/trips/${encodeURIComponent(postDriveReviewTrip.id)}`)}
          onOpenNextAction={() => navigate(`/tracking/events?trip=${encodeURIComponent(postDriveReviewTrip.id)}`)}
        />
      )}

      {summariesQuery.isError && (
        <section role="alert" className="flex flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-900 sm:flex-row sm:items-center sm:justify-between dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
          <div>
            <h2 className="font-semibold">Recent trips could not be loaded</h2>
            <p className="mt-1 text-sm opacity-80">Your recordings are still stored locally. Retry the trip summary without leaving this screen.</p>
          </div>
          <Button variant="outline" onClick={() => summariesQuery.refetch()} loading={summariesQuery.isFetching} loadingText="Retrying...">
            Retry loading trips
          </Button>
        </section>
      )}

      <section aria-label="Tracking shortcuts" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <TrackingShortcut to="/tracking/recorder" icon={Radio} title="Record" detail="Start or resume" />
        <TrackingShortcut to="/trips" icon={Route} title="My trips" detail="Recent drives" />
        <TrackingShortcut to="/tracking/map" icon={Map} title="Routes" detail="Explore the map" />
        <TrackingShortcut to="/tracking/events" icon={Bell} title="Drive events" detail="Review the timeline" />
        <TrackingShortcut to="/tracking/replay" icon={Activity} title="Compare" detail="Replay two drives" />
        <TrackingShortcut to="/tracking/privacy" icon={ShieldCheck} title="Privacy" detail="Manage trip zones" />
      </section>

      <section aria-labelledby="tracking-intelligence-title" className="tracking-intelligence-panel rounded-3xl border border-border/70 bg-card/90 p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs font-semibold text-primary">Advanced tracking insights</div>
            <h2 id="tracking-intelligence-title" className="mt-1 font-grotesk text-xl font-bold">What your recent tracking data can tell you</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Seven-day totals use complete local trip summaries; comparison metrics use the latest {OVERVIEW_TRIP_LIMIT}.</p>
          </div>
          <StatusChip tone={intelligence.confidence.tone}>Data confidence: {intelligence.confidence.label}</StatusChip>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <IntelligenceCard
            icon={Route}
            label="Last 7 days"
            value={formatTripDistance(intelligence.weekDistanceKm, units)}
            detail={`${intelligence.weekTrips} tracked drive${intelligence.weekTrips === 1 ? '' : 's'} in the last week`}
          />
          <IntelligenceCard
            icon={Signal}
            label="Route retention"
            value={`${intelligence.routeCoverage}%`}
            detail={`${intelligence.rows ? Math.round((intelligence.routeCoverage / 100) * intelligence.rows) : 0} of ${intelligence.rows} recent trips include a usable route`}
          />
          <IntelligenceCard
            icon={Activity}
            label="Recorded event rate"
            value={formatPerDistanceRate(intelligence.eventRate, units)}
            detail="Neutral recorded observations, normalized for distance"
          />
          <IntelligenceCard
            icon={Gauge}
            label="Comparison readiness"
            value={intelligence.confidence.label}
            detail={intelligence.confidence.detail}
          />
        </div>
      </section>

      <section aria-label="Tracking readiness" className="grid min-w-0 gap-2 md:grid-cols-2 xl:grid-cols-5">
        {statusStrip.map(({ icon: Icon, tone, label, detail }, index) => (
          <div key={`${label}-${index}`} className="min-w-0 rounded-2xl border border-border/70 bg-card/90 p-4 shadow-sm">
            <div className="flex min-w-0 items-center gap-2">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <StatusChip tone={tone}>{label}</StatusChip>
            </div>
            <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{detail}</p>
          </div>
        ))}
      </section>

      <TrackingTrendChart rows={trendSeries} units={units} />

      <section className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.05fr)_minmax(20rem,0.95fr)_minmax(18rem,0.7fr)]">
        <RecentTripsTable trips={recentTrips.slice(0, RECENT_TRIP_TABLE_LIMIT)} loading={summariesQuery.isLoading} units={units} />

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
                <MetricCell label="Distance" value={formatDistance(displayTrip, units)} />
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
                    <span className="font-grotesk text-xl font-bold">{formatEstimatedScore(score)}</span>
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
              <h2 className="text-sm font-semibold">Tracking health</h2>
              <p className="text-xs text-muted-foreground">Permissions and recording readiness</p>
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

const liveNumber = (value, digits = 0) => Number.isFinite(Number(value))
  ? Number(value).toFixed(digits)
  : 'Unavailable';

const telemetryLabel = (value) => String(value || 'unavailable')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (character) => character.toUpperCase());

const eventAgeLabel = (timestamp) => {
  const time = new Date(timestamp || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return 'Time unavailable';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};

export function LiveTrackingCockpit({ snapshot, units = 'metric', view, onViewChange, nativeActive, ending, onEnd }) {
  const tabs = [
    { id: 'drive', label: 'Drive', icon: Gauge },
    { id: 'route', label: 'Route', icon: Navigation },
    { id: 'signals', label: 'Signals', icon: Waves },
  ];
  const recordingLabel = snapshot.state === 'candidate' ? 'Checking movement' : 'Recording active';
  const updateLabel = snapshot.updateAgeSeconds == null
    ? 'Snapshot age unavailable'
    : snapshot.updateAgeSeconds < 2
      ? 'Snapshot updated now'
      : `Snapshot updated ${Math.round(snapshot.updateAgeSeconds)}s ago`;

  return (
    <section aria-labelledby="live-cockpit-title" className="overflow-hidden rounded-3xl border border-slate-700/70 bg-slate-950 text-slate-50 shadow-xl">
      <div className="border-b border-white/10 bg-gradient-to-r from-blue-700/60 via-slate-950 to-teal-700/40 px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-300/10 px-3 py-1 text-emerald-200">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" />
                {recordingLabel}
              </span>
              <span className={`rounded-full border px-3 py-1 ${
                snapshot.gps.tone === 'good'
                  ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200'
                  : snapshot.gps.tone === 'error'
                    ? 'border-red-300/30 bg-red-300/10 text-red-200'
                    : 'border-amber-300/30 bg-amber-300/10 text-amber-100'
              }`}>{snapshot.gps.label}</span>
              <span className="text-slate-400">{updateLabel}</span>
            </div>
            <h1 id="live-cockpit-title" className="mt-3 font-grotesk text-2xl font-bold tracking-tight sm:text-3xl">Live drive telemetry</h1>
            <p className="mt-1 text-sm text-slate-300">On-device recording, local calculations, and privacy-redacted route telemetry.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {nativeActive ? (
              <Button type="button" variant="destructive" onClick={onEnd} loading={ending} loadingText="Ending..." className="min-h-11 rounded-xl">
                <Square className="h-4 w-4" />End recording
              </Button>
            ) : (
              <Button asChild className="min-h-11 rounded-xl bg-white text-slate-950 hover:bg-slate-100">
                <Link to="/tracking/recorder"><Radio className="h-4 w-4" />Open recorder</Link>
              </Button>
            )}
            <Button asChild variant="outline" className="min-h-11 rounded-xl border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white">
              <Link to="/tracking/map"><Map className="h-4 w-4" />Map workspace</Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="flex overflow-x-auto border-b border-white/10 bg-slate-900/70 px-2" role="tablist" aria-label="Live telemetry views">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => onViewChange(id)}
            className={`inline-flex min-h-12 min-w-28 items-center justify-center gap-2 border-b-2 px-4 text-sm font-semibold transition-colors ${
              view === id ? 'border-cyan-300 text-white' : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="min-h-[28rem]">
        {view === 'drive' && <DriveTelemetryView snapshot={snapshot} units={units} />}
        {view === 'route' && <RouteTelemetryView snapshot={snapshot} />}
        {view === 'signals' && <SignalTelemetryView snapshot={snapshot} />}
      </div>
    </section>
  );
}

function DriveTelemetryView({ snapshot, units = 'metric' }) {
  const eventCounts = Object.entries(snapshot.eventCounts).filter(([, count]) => count > 0).slice(0, 6);
  const speedKnown = snapshot.currentSpeedKmh != null;
  const overKnownLimit = snapshot.speedDeltaKmh != null && snapshot.speedDeltaKmh > 0;
  const speedUnit = speedUnitLabel(units);
  const currentSpeed = speedKnown ? Math.round(convertSpeedKmh(snapshot.currentSpeedKmh, units)) : '—';
  return (
    <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
      <div className="min-w-0 border-b border-white/10 p-4 sm:p-6 lg:border-b-0 lg:border-r">
        <div className="grid gap-5 sm:grid-cols-[minmax(12rem,0.65fr)_minmax(0,1fr)] sm:items-end">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Current speed</div>
            <div className="mt-2 flex items-end gap-3">
              <span className="font-grotesk text-7xl font-bold leading-none tracking-tight sm:text-8xl">{currentSpeed}</span>
              <span className="mb-2 text-lg font-semibold text-slate-400">{speedUnit}</span>
            </div>
            <div className={`mt-3 inline-flex rounded-lg border px-3 py-2 text-sm font-semibold ${
              speedKnown ? 'border-white/10 bg-white/5 text-slate-200' : 'border-amber-300/20 bg-amber-300/10 text-amber-100'
            }`}>
              {speedKnown ? snapshot.currentSpeedKmh < 1 ? 'Reliable fix · stationary' : snapshot.gps.label : 'Speed unavailable · GPS settling'}
            </div>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Local speed context</div>
                <div className="mt-1 font-grotesk text-3xl font-bold">
                  {snapshot.speedLimitKmh == null ? 'Limit unavailable' : formatTripSpeed(snapshot.speedLimitKmh, units)}
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {snapshot.speedLimitSource ? `Source: ${telemetryLabel(snapshot.speedLimitSource)}` : 'No saved local road limit matched this position.'}
                </div>
              </div>
              {snapshot.speedDeltaKmh != null && (
                <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                  overKnownLimit ? 'border-red-300/30 bg-red-300/10 text-red-200' : 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200'
                }`}>
                  {overKnownLimit ? `+${formatTripSpeed(snapshot.speedDeltaKmh, units)} threshold` : `${formatTripSpeed(Math.abs(snapshot.speedDeltaKmh), units)} below`}
                </span>
              )}
            </div>
            <div className="mt-5"><SpeedTrace points={snapshot.routePreview} units={units} /></div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 border-y border-white/10 sm:grid-cols-5">
          <LiveMetric label="Elapsed" value={formatLiveDuration(snapshot.durationSeconds)} icon={Clock3} />
          <LiveMetric label="Distance" value={formatTripDistance(snapshot.distanceKm, units)} icon={Navigation} />
          <LiveMetric label="Average" value={snapshot.averageSpeedKmh == null ? '—' : formatTripSpeed(snapshot.averageSpeedKmh, units)} icon={TrendingUp} />
          <LiveMetric label="Maximum" value={snapshot.maxSpeedKmh == null ? '—' : formatTripSpeed(snapshot.maxSpeedKmh, units)} icon={Gauge} />
          <LiveMetric label="Stopped" value={formatLiveDuration(snapshot.stoppedSeconds)} icon={TimerReset} />
        </div>
      </div>

      <aside className="min-w-0 p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div><div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Live observations</div><h2 className="mt-1 text-lg font-bold">Event timeline</h2></div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300">{snapshot.events.length} recent</span>
        </div>
        {snapshot.possibleIncidentActive && (
          <div className="mt-4 rounded-xl border border-red-300/30 bg-red-400/10 p-3 text-sm text-red-100">
            <div className="font-bold">Possible incident signal active</div>
            <div className="mt-1 text-xs text-red-100/80">Review the emergency check-in when it is safe.</div>
          </div>
        )}
        {snapshot.latestEvent ? (
          <div className="mt-4 border-l-2 border-cyan-300 pl-3">
            <div className="text-sm font-semibold">{snapshot.latestEvent.title}</div>
            <div className="mt-1 text-xs text-slate-400">{eventAgeLabel(snapshot.latestEvent.timestamp)}{snapshot.latestEvent.speedKmh != null ? ` · ${formatTripSpeed(snapshot.latestEvent.speedKmh, units)}` : ''}</div>
          </div>
        ) : (
          <div className="mt-4 border-l-2 border-slate-700 pl-3 text-sm text-slate-400">No live threshold events recorded.</div>
        )}
        <div className="mt-5 divide-y divide-white/10 border-y border-white/10">
          {eventCounts.length ? eventCounts.map(([type, count]) => (
            <div key={type} className="flex items-center justify-between gap-3 py-3 text-sm">
              <span className="text-slate-300">{telemetryLabel(type)}</span><span className="font-grotesk text-lg font-bold">{count}</span>
            </div>
          )) : <div className="py-5 text-sm text-slate-400">Counts will appear when a configured on-device threshold is exceeded.</div>}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-slate-500">Keep attention on the road. Detailed signals are intended for a passenger or parked review.</p>
      </aside>
    </div>
  );
}

function RouteTelemetryView({ snapshot }) {
  return (
    <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 border-b border-white/10 p-4 sm:p-6 lg:border-b-0 lg:border-r">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">API-free route view</div><h2 className="mt-1 text-xl font-bold">Local route trace</h2></div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300">{snapshot.routePointCount} points recorded</span>
        </div>
        <div className="mt-4"><LiveRoutePlot points={snapshot.routePreview} maskedCount={snapshot.routeMaskedCount} /></div>
      </div>
      <aside className="divide-y divide-white/10 p-4 sm:p-6">
        <SignalRow label="Route points retained" value={String(snapshot.routePointCount)} />
        <SignalRow label="Preview points" value={String(snapshot.routePreview.length)} />
        <SignalRow label="Route gaps" value={String(snapshot.routeGapCount)} />
        <SignalRow label="Gap time" value={formatLiveDuration(snapshot.gapSeconds)} />
        <SignalRow label="Privacy-masked samples" value={String(snapshot.routeMaskedCount)} />
        <SignalRow label="Heading" value={snapshot.headingDeg == null ? 'Unavailable' : `${Math.round(snapshot.headingDeg)}°`} />
        <SignalRow label="Altitude" value={snapshot.altitudeM == null ? 'Unavailable' : `${Math.round(snapshot.altitudeM)} m`} />
        <div className="pt-4 text-xs leading-relaxed text-slate-500">This trace is drawn from local GPS samples. It does not require map tiles, routing services, or a paid API.</div>
      </aside>
    </div>
  );
}

function SignalTelemetryView({ snapshot }) {
  return (
    <div className="grid min-w-0 md:grid-cols-2 xl:grid-cols-3">
      <SignalGroup icon={Satellite} title="GPS evidence">
        <SignalRow label="Fix state" value={snapshot.gps.label} />
        <SignalRow label="Accuracy" value={snapshot.gps.accuracyM == null ? 'Unavailable' : `±${Math.round(snapshot.gps.accuracyM)} m`} />
        <SignalRow label="Fix age" value={snapshot.gps.fixAgeSeconds == null ? 'Unavailable' : `${Math.round(snapshot.gps.fixAgeSeconds)} s`} />
        <SignalRow label="Snapshot age" value={snapshot.updateAgeSeconds == null ? 'Unavailable' : `${Math.round(snapshot.updateAgeSeconds)} s`} />
        <SignalRow label="Permission loss" value={snapshot.gps.key === 'lost' ? 'Recorded' : 'Not recorded'} />
      </SignalGroup>
      <SignalGroup icon={Zap} title="Motion evidence">
        <SignalRow label="Longitudinal acceleration" value={snapshot.accelerationMs2 == null ? 'Unavailable' : `${liveNumber(snapshot.accelerationMs2, 2)} m/s²`} />
        <SignalRow label="Estimated lateral force" value={snapshot.lateralG == null ? 'Unavailable' : `${liveNumber(snapshot.lateralG, 3)} g`} />
        <SignalRow label="Heading rate" value={snapshot.headingRateDegS == null ? 'Unavailable' : `${liveNumber(snapshot.headingRateDegS, 1)}°/s`} />
        <SignalRow label="Linear motion" value={snapshot.linearMotionMagnitudeMs2 == null ? 'Unavailable' : `${liveNumber(snapshot.linearMotionMagnitudeMs2, 2)} m/s²`} />
        <SignalRow label="Rotation" value={snapshot.rotationMagnitudeDegS == null ? 'Unavailable' : `${liveNumber(snapshot.rotationMagnitudeDegS, 1)}°/s`} />
      </SignalGroup>
      <SignalGroup icon={Activity} title="Recorder state">
        <SignalRow label="Activity" value={`${telemetryLabel(snapshot.activityType)}${snapshot.activityConfidence == null ? '' : ` · ${Math.round(snapshot.activityConfidence)}%`}`} />
        <SignalRow label="Motion samples" value={String(snapshot.motionSampleCount)} />
        <SignalRow label="Linear sensor" value={snapshot.linearAccelerationSensorReady ? 'Available' : 'Unavailable'} />
        <SignalRow label="Gyroscope" value={snapshot.gyroscopeSensorReady ? 'Available' : 'Unavailable'} />
        <SignalRow label="Stopped drift" value={`${liveNumber(snapshot.maxDriftSinceStopM, 1)} m`} />
      </SignalGroup>
    </div>
  );
}

function LiveMetric({ label, value, icon: Icon }) {
  return (
    <div className="min-w-0 border-b border-white/10 px-3 py-4 odd:border-r sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500"><Icon className="h-3.5 w-3.5" />{label}</div>
      <div className="mt-2 truncate font-grotesk text-lg font-bold text-slate-100">{value}</div>
    </div>
  );
}

function SignalGroup({ icon: Icon, title, children }) {
  return (
    <section className="min-w-0 border-b border-white/10 p-4 sm:p-6 md:border-r xl:border-b-0 xl:last:border-r-0">
      <div className="flex items-center gap-2"><Icon className="h-4 w-4 text-cyan-300" /><h2 className="font-semibold">{title}</h2></div>
      <div className="mt-4 divide-y divide-white/10">{children}</div>
    </section>
  );
}

function SignalRow({ label, value }) {
  return <div className="flex items-start justify-between gap-4 py-3 text-sm"><span className="text-slate-400">{label}</span><span className="max-w-[58%] text-right font-semibold text-slate-100">{value}</span></div>;
}

function SpeedTrace({ points = [], units = 'metric' }) {
  const speeds = points.map((point) => Number(point?.speed_kmh)).filter(Number.isFinite).slice(-60);
  if (speeds.length < 2) return <div className="grid h-20 place-items-center rounded-lg border border-dashed border-white/10 text-xs text-slate-500">Speed trace waiting for samples</div>;
  const max = Math.max(20, ...speeds);
  const coordinates = speeds.map((speed, index) => {
    const x = speeds.length === 1 ? 0 : index / (speeds.length - 1) * 100;
    const y = 38 - Math.max(0, Math.min(1, speed / max)) * 34;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div>
      <svg viewBox="0 0 100 42" preserveAspectRatio="none" className="h-20 w-full" role="img" aria-label="Recent speed trace">
        <line x1="0" y1="38" x2="100" y2="38" stroke="rgba(148,163,184,.2)" strokeWidth=".5" />
        <polyline points={coordinates} fill="none" stroke="#67e8f9" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-500"><span>Recent speed</span><span>Peak {formatTripSpeed(max, units)}</span></div>
    </div>
  );
}

function LiveRoutePlot({ points = [], maskedCount = 0 }) {
  const segments = [];
  let segment = [];
  points.forEach((point) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    const gap = point?.masked_for_privacy === true || point?.tracking_gap === true || point?.route_gap === true || !Number.isFinite(lat) || !Number.isFinite(lng);
    if (gap) {
      if (segment.length) segments.push(segment);
      segment = [];
      return;
    }
    segment.push({ lat, lng });
  });
  if (segment.length) segments.push(segment);
  const coordinates = segments.flat();
  if (coordinates.length < 2) {
    return <div className="grid min-h-80 place-items-center rounded-xl border border-dashed border-white/10 bg-slate-900/60 p-6 text-center text-sm text-slate-400">Route trace is waiting for at least two public GPS samples.</div>;
  }
  const lats = coordinates.map((point) => point.lat);
  const lngs = coordinates.map((point) => point.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latRange = Math.max(0.00001, maxLat - minLat);
  const lngRange = Math.max(0.00001, maxLng - minLng);
  const project = (point) => ({
    x: 5 + ((point.lng - minLng) / lngRange) * 90,
    y: 95 - ((point.lat - minLat) / latRange) * 90,
  });
  const projected = segments.map((row) => row.map(project));
  const finalPoint = projected[projected.length - 1]?.[projected[projected.length - 1].length - 1];
  return (
    <div className="relative min-h-80 overflow-hidden rounded-xl border border-white/10 bg-slate-900/80">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" role="img" aria-label="Privacy-redacted local route trace">
        {[20, 40, 60, 80].map((position) => <g key={position}><line x1={position} y1="0" x2={position} y2="100" stroke="rgba(148,163,184,.08)" strokeWidth=".4" /><line x1="0" y1={position} x2="100" y2={position} stroke="rgba(148,163,184,.08)" strokeWidth=".4" /></g>)}
        {projected.map((row, index) => <polyline key={index} points={row.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#22d3ee" strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />)}
        {finalPoint && <circle cx={finalPoint.x} cy={finalPoint.y} r="2.2" fill="#a7f3d0" stroke="#0f172a" strokeWidth=".7" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="absolute left-3 top-3 rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-xs text-slate-300">North ↑</div>
      <div className="absolute bottom-3 left-3 right-3 flex flex-wrap justify-between gap-2 rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-xs text-slate-300"><span>{coordinates.length} preview samples</span><span>{maskedCount ? `${maskedCount} privacy-masked` : 'No masked samples in preview'}</span></div>
    </div>
  );
}

function HeroMetric({ label, value }) {
  return (
    <div className="rounded-xl bg-white/10 px-3 py-2.5 ring-1 ring-white/20 backdrop-blur-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-white/65">{label}</div>
      <div className="mt-1 truncate font-grotesk text-lg font-bold text-white">{value}</div>
    </div>
  );
}

function TrackingShortcut({ to, icon: Icon, title, detail }) {
  return (
    <Link
      to={to}
      className="group flex min-h-24 items-center gap-3 rounded-2xl border border-border/70 bg-card/90 p-3 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </Link>
  );
}

function IntelligenceCard({ icon: Icon, label, value, detail }) {
  return (
    <article className="rounded-2xl border border-border/60 bg-background/70 p-4">
      <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>
        {label}
      </div>
      <div className="mt-3 font-grotesk text-2xl font-bold tracking-tight">{value}</div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </article>
  );
}

function TrackingTrendChart({ rows, units = 'metric' }) {
  const distanceUnit = distanceUnitLabel(units);
  const speedUnit = speedUnitLabel(units);
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-1 border-b border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="text-sm font-semibold">Recent telemetry trend</h2><p className="text-xs text-muted-foreground">Up to 30 completed trips; observations are normalized per 10 {distanceUnit}.</p></div>
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
              <Bar yAxisId="left" dataKey="distanceKm" name={`Distance (${distanceUnit})`} fill="#94a3b8" opacity={0.45} />
              <Line yAxisId="left" type="monotone" dataKey="averageSpeedKmh" name={`Average speed (${speedUnit})`} stroke="#2563eb" strokeWidth={2} dot={false} connectNulls />
              <Line yAxisId="right" type="monotone" dataKey="eventRate" name={`Observations / 10 ${distanceUnit}`} stroke="#f97316" strokeWidth={2} dot={false} connectNulls />
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

function RecentTripsTable({ trips, loading, units = 'metric' }) {
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
                    <td className="px-3 py-2 text-muted-foreground">{formatDistance(trip, units)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDuration(trip.duration_seconds)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{eventCount(trip)}</td>
                    <td className="px-3 py-2">
                      <StatusChip tone={score == null ? 'neutral' : 'good'}>{formatEstimatedScore(score, { empty: 'Unavailable' })}</StatusChip>
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
