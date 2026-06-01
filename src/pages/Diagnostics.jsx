import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  Battery,
  Bluetooth,
  Car,
  CheckCircle2,
  Clock,
  MapPin,
  RefreshCw,
  Satellite,
  Shield,
  Smartphone,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { tripService } from '@/api/trips';
import { getPermissionStatus } from '@/lib/permissions';
import {
  clearNativeDiagnostics,
  getAndroidBatteryOptimizationStatus,
  getNativeAutoTrackingStatus,
  getNativeDiagnostics,
  startNativeAutoTracking,
} from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import {
  buildParkingTimeline,
  buildTrackingHealth,
  clearTrackingDiagnostics,
  getTrackingDiagnostics,
  normalizeNativeDiagnosticEvents,
} from '@/lib/trackingDiagnostics';
import { activeTripStore, localSettings } from '@/lib/trackingStore';
import { formatDateTime } from '@/lib/gps/formatting';
import { buildLocalFeatureTestTrips, LOCAL_TEST_TRIP_PREFIX } from '@/lib/localTestTrips';
import {
  buildMotionSensorDiagnostics,
  requestMotionSensorPermission,
} from '@/lib/sensorFusionModel';
import { logError } from '@/lib/errorReporting';
import PageNotFound from '@/lib/PageNotFound';

const statusStyle = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
  warn: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-900/60 dark:bg-yellow-950/30 dark:text-yellow-300',
  bad: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300',
  unknown: 'border-border bg-secondary/50 text-muted-foreground',
};

const typeIcon = {
  service_armed: Shield,
  armed_location_watch: Satellite,
  candidate_started: Activity,
  candidate_confirmed: Car,
  candidate_hidden_parking_cooldown: MapPin,
  auto_start: Car,
  ending_review: Clock,
  tail_trimmed: MapPin,
  trip_started: Car,
  trip_ended: MapPin,
  auto_stop: MapPin,
  trip_discarded: AlertTriangle,
  parking_detected: MapPin,
  parked_idle: Clock,
  traffic_stop: Clock,
};

function EventRow({ event }) {
  const Icon = typeIcon[event.type] || Activity;
  const metricBits = [
    event.reason ? `reason: ${String(event.reason).replace(/_/g, ' ')}` : null,
    event.speed_kmh != null ? `${Math.round(event.speed_kmh)} km/h` : null,
    event.stopped_seconds != null && event.stopped_seconds > 0 ? `stopped ${Math.round(event.stopped_seconds)}s` : null,
    event.drift_m != null && event.drift_m > 0 ? `drift ${Math.round(event.drift_m)}m` : null,
  ].filter(Boolean);

  return (
    <div className="flex gap-3 rounded-xl border border-border bg-card p-3">
      <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg bg-secondary">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-sm">{event.title || event.type}</div>
          <span className="text-[11px] font-medium uppercase text-muted-foreground">{event.source || 'web'}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(event.timestamp) || 'time unknown'}</div>
        {(event.detail || metricBits.length > 0) && (
          <div className="mt-1 text-xs text-muted-foreground">
            {[event.detail, ...metricBits].filter(Boolean).join(' - ')}
          </div>
        )}
      </div>
    </div>
  );
}

function HealthIcon({ id }) {
  const icons = {
    native: Shield,
    location: MapPin,
    background: Satellite,
    activity: Activity,
    motion: SlidersHorizontal,
    notifications: Smartphone,
    bluetooth: Bluetooth,
    battery: Battery,
    usage: Smartphone,
    'latest-trip': Car,
  };
  const Icon = icons[id] || CheckCircle2;
  return <Icon className="h-4 w-4" />;
}

function yesNo(value) {
  return value ? 'Yes' : 'No';
}

function relativeAge(value) {
  const timestamp = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(timestamp)) return 'never';
  const diffMs = Math.max(0, Date.now() - timestamp);
  const days = Math.floor(diffMs / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} ago`;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const minutes = Math.floor(diffMs / 60_000);
  return minutes <= 1 ? 'just now' : `${minutes} minutes ago`;
}

function motionEvidenceLabel(status) {
  const labels = {
    current_trip: 'Current trip received IMU samples',
    latest_trip: 'Latest trip received IMU samples',
    current_trip_pending: 'Current trip has no saved IMU summary yet',
    latest_trip_missing: 'Latest trip has no IMU samples',
    none: 'No trip evidence yet',
  };
  return labels[status] || labels.none;
}

function DiagnosticsContent() {
  const [permissionStatus, setPermissionStatus] = useState(null);
  const [nativeStatus, setNativeStatus] = useState(null);
  const [batteryStatus, setBatteryStatus] = useState(null);
  const [nativeDiagnostics, setNativeDiagnostics] = useState({ enabled: false, events: [] });
  const [webDiagnostics, setWebDiagnostics] = useState(() => getTrackingDiagnostics());
  const [activeTrip, setActiveTrip] = useState(() => activeTripStore.get());
  const [refreshing, setRefreshing] = useState(false);
  const [motionPermissionBusy, setMotionPermissionBusy] = useState(false);
  const [testDataBusy, setTestDataBusy] = useState(false);
  const [testDataNotice, setTestDataNotice] = useState('');

  const { data: trips = [], refetch } = useQuery({
    queryKey: ['diagnostics-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 20 }),
  });
  const { data: storedTestTrips = [], refetch: refetchStoredTestTrips } = useQuery({
    queryKey: ['diagnostics-local-test-trips'],
    queryFn: async () => {
      const storedTrips = await tripService.listAll({ sort: '-start_time' });
      return storedTrips.filter((trip) => String(trip.id || '').startsWith(LOCAL_TEST_TRIP_PREFIX));
    },
    enabled: import.meta.env.DEV,
  });
  const latestTrip = trips.find((trip) => trip.status === 'completed') || null;
  const localTestTripCount = storedTestTrips.length;

  const refresh = async () => {
    setRefreshing(true);
    setWebDiagnostics(getTrackingDiagnostics());
    setActiveTrip(activeTripStore.get());
    try {
      const [permissions, native, battery, nativeLog] = await Promise.all([
        getPermissionStatus(),
        isAndroid() ? getNativeAutoTrackingStatus().catch(() => null) : Promise.resolve(null),
        isAndroid() ? getAndroidBatteryOptimizationStatus().catch(() => null) : Promise.resolve(null),
        isAndroid() ? getNativeDiagnostics().catch(() => ({ enabled: false, events: [] })) : Promise.resolve({ enabled: false, events: [] }),
      ]);
      setPermissionStatus(permissions);
      setNativeStatus(native);
      setBatteryStatus(battery);
      setNativeDiagnostics(nativeLog || { enabled: false, events: [] });
      setActiveTrip(activeTripStore.get());
      await Promise.all([
        refetch(),
        import.meta.env.DEV ? refetchStoredTestTrips() : Promise.resolve(),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const health = useMemo(() => buildTrackingHealth({
    permissionStatus,
    nativeStatus,
    batteryStatus,
    latestTrip,
  }), [permissionStatus, nativeStatus, batteryStatus, latestTrip]);

  const combinedEvents = useMemo(() => {
    const nativeEvents = normalizeNativeDiagnosticEvents(nativeDiagnostics);
    const webEvents = webDiagnostics.events || [];
    return [...nativeEvents, ...webEvents]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 60);
  }, [nativeDiagnostics, webDiagnostics]);

  const parkingTimeline = useMemo(() => buildParkingTimeline(latestTrip), [latestTrip]);
  const latestOvertakeDiagnostics = useMemo(() => ({
    eventCount: Number(latestTrip?.overtake_event_count ?? 0),
    qualityScore: latestTrip?.overtake_quality_score ?? null,
    unsafeReentryCount: Number(latestTrip?.unsafe_reentry_count ?? 0),
    status: latestTrip?.overtake_quality_status || 'development_diagnostic_only',
  }), [latestTrip]);
  const settings = localSettings.get();
  const backgroundAutoEnabled = settings.tracking_mode === 'background_auto' && !settings.tracking_paused;
  const osrmLastReachable = settings.osrm_last_reachable_at ? relativeAge(settings.osrm_last_reachable_at) : 'never';
  const motionDiagnostics = useMemo(() => buildMotionSensorDiagnostics({
    permissionState: permissionStatus?.motionSensors,
    settings,
    currentTrip: activeTrip,
    latestTrip,
  }), [permissionStatus?.motionSensors, settings, activeTrip, latestTrip]);

  const clearLogs = async () => {
    clearTrackingDiagnostics();
    if (isAndroid()) await clearNativeDiagnostics().catch((err) => {
      logError('native_diagnostics_clear', err);
    });
    await refresh();
  };

  const requestMotionPermission = async () => {
    setMotionPermissionBusy(true);
    try {
      await requestMotionSensorPermission();
      await refresh();
    } finally {
      setMotionPermissionBusy(false);
    }
  };

  const armNative = async () => {
    if (!isAndroid()) return;
    await startNativeAutoTracking().catch((err) => {
      logError('native_auto_tracking_start_diagnostics', err);
    });
    await refresh();
  };

  const seedLocalTestTrips = async () => {
    setTestDataBusy(true);
    try {
      const seeded = await tripService.upsertMany(buildLocalFeatureTestTrips(new Date(), {
        allowSyntheticTestData: import.meta.env.DEV === true,
      }));
      await refresh();
      setTestDataNotice(`${seeded.length} synthetic trips are available in this local profile.`);
    } finally {
      setTestDataBusy(false);
    }
  };

  const removeLocalTestTrips = async () => {
    setTestDataBusy(true);
    try {
      await Promise.all(storedTestTrips.map((trip) => tripService.delete(trip.id)));
      await refresh();
      setTestDataNotice(`${storedTestTrips.length} synthetic trips removed from this local profile.`);
    } finally {
      setTestDataBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-grotesk text-2xl font-bold">Tracking Diagnostics</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live health, auto-start decisions, parking endings, and Android service history.
          </p>
        </div>
        <div className="flex gap-2">
          {isAndroid() && (
            <button
              onClick={armNative}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-semibold hover:bg-secondary"
            >
              <Shield className="h-4 w-4" />
              Arm native
            </button>
          )}
          <button
            onClick={refresh}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {import.meta.env.DEV && (
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <h2 className="font-semibold">Local Test Data</h2>
              <div className="mt-1 text-xs text-muted-foreground">
                Synthetic completed trips in this profile: {localTestTripCount}
              </div>
              {testDataNotice && <div className="mt-1 text-xs font-medium text-primary">{testDataNotice}</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={seedLocalTestTrips}
                disabled={testDataBusy}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                <Car className="h-4 w-4" />
                Seed test trips
              </button>
              <button
                onClick={removeLocalTestTrips}
                disabled={testDataBusy || localTestTripCount === 0}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Remove test trips
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <h2 className="font-semibold">Development Diagnostics</h2>
            <div className="mt-1 text-xs text-muted-foreground">
              Overtake pattern detection is hidden from Trip Detail and excluded from scores, coaching, route risk, and achievements.
            </div>
          </div>
          <span className="w-fit rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-bold uppercase text-muted-foreground">
            {latestOvertakeDiagnostics.status.replace(/_/g, ' ')}
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <div className="text-[11px] font-bold uppercase text-muted-foreground">Overtake patterns</div>
            <div className="mt-1 text-sm font-semibold">{latestOvertakeDiagnostics.eventCount}</div>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <div className="text-[11px] font-bold uppercase text-muted-foreground">Quality score</div>
            <div className="mt-1 text-sm font-semibold">{latestOvertakeDiagnostics.qualityScore ?? 'unavailable'}</div>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <div className="text-[11px] font-bold uppercase text-muted-foreground">Unsafe re-entry alerts</div>
            <div className="mt-1 text-sm font-semibold">{latestOvertakeDiagnostics.unsafeReentryCount}</div>
          </div>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">System Health</h2>
          <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${backgroundAutoEnabled ? statusStyle.good : statusStyle.warn}`}>
            {backgroundAutoEnabled ? 'Background auto on' : 'Background auto off'}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {health.map((item, index) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.03 }}
              className="rounded-2xl border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-secondary">
                  <HealthIcon id={item.id} />
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase ${statusStyle[item.status] || statusStyle.unknown}`}>
                  {item.value}
                </span>
              </div>
              <div className="mt-3 font-semibold">{item.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">{item.detail}</div>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <h2 className="font-semibold">OSRM Route Snapping</h2>
            <div className="mt-1 text-xs text-muted-foreground">
              OSRM last reachable: {osrmLastReachable}. {settings.osrm_health_status === 'unreachable' && settings.osrm_last_health_error ? settings.osrm_last_health_error : 'Health checks run when the endpoint is saved in Settings.'}
            </div>
          </div>
          <span className={`w-fit rounded-full border px-2.5 py-1 text-xs font-bold uppercase ${
            settings.osrm_health_status === 'connected'
              ? statusStyle.good
              : settings.osrm_health_status === 'unreachable'
                ? statusStyle.bad
                : statusStyle.unknown
          }`}>
            {settings.osrm_map_matching_url && settings.osrm_data_sharing_consented === true
              ? settings.osrm_health_status || 'not checked'
              : 'not configured'}
          </span>
        </div>
      </section>

      <section>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-secondary">
                <SlidersHorizontal className="h-4 w-4" />
              </div>
              <div>
                <h2 className="font-semibold">Motion Sensor</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  IMU evidence used for sensor fusion, harsh-event enrichment, and possible incident detection.
                </p>
              </div>
            </div>
          </div>
          <span className={`w-fit rounded-full border px-2.5 py-1 text-xs font-bold uppercase ${motionDiagnostics.crashDetectionActive ? statusStyle.good : statusStyle.warn}`}>
            Crash detection: {motionDiagnostics.crashDetectionActive ? 'active' : 'inactive'}
          </span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <div className="text-[11px] font-bold uppercase text-muted-foreground">Sensor available</div>
            <div className="mt-1 text-sm font-semibold">{yesNo(motionDiagnostics.sensorAvailable)}</div>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <div className="text-[11px] font-bold uppercase text-muted-foreground">Permission</div>
            <div className="mt-1 text-sm font-semibold capitalize">{motionDiagnostics.permissionState}</div>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <div className="text-[11px] font-bold uppercase text-muted-foreground">Trip IMU samples</div>
            <div className="mt-1 text-sm font-semibold">{motionEvidenceLabel(motionDiagnostics.evidenceSource)}</div>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <div className="text-[11px] font-bold uppercase text-muted-foreground">Sample quality</div>
            <div className="mt-1 text-sm font-semibold capitalize">
              {motionDiagnostics.sampleCount} samples / {motionDiagnostics.quality}
            </div>
          </div>
        </div>

        {!motionDiagnostics.crashDetectionActive && (
          <div className="mt-4 flex flex-col gap-3 rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-900/60 dark:bg-yellow-950/30 dark:text-yellow-200 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <div className="font-semibold">
                  Crash detection is inactive because {motionDiagnostics.inactiveReasons.join(', ') || 'motion readiness is unknown'}.
                </div>
                <div className="mt-1 text-xs">
                  {motionDiagnostics.supportNote || 'Road Sage needs device motion samples before it can evaluate impact-like movement.'}
                </div>
              </div>
            </div>
            {motionDiagnostics.sensorAvailable && motionDiagnostics.permissionState !== 'granted' && (
              <button
                onClick={requestMotionPermission}
                disabled={motionPermissionBusy}
                className="inline-flex shrink-0 items-center justify-center rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
              >
                {motionPermissionBusy ? 'Requesting...' : 'Request permission'}
              </button>
            )}
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Latest Parking Timeline</h2>
            {latestTrip && <span className="text-xs text-muted-foreground">{latestTrip.distance_km?.toFixed?.(1) || latestTrip.distance_km || 0} km</span>}
          </div>
          <div className="space-y-2">
            {parkingTimeline.length > 0 ? (
              parkingTimeline.map((event, index) => <EventRow key={`${event.type}-${event.timestamp}-${index}`} event={event} />)
            ) : (
              <div className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">
                No completed trip timeline yet.
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Decision Log</h2>
            <button
              onClick={clearLogs}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          </div>
          <div className="space-y-2">
            {combinedEvents.length > 0 ? (
              combinedEvents.map((event) => <EventRow key={event.id} event={event} />)
            ) : (
              <div className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">
                No diagnostic decisions recorded yet. Start or auto-detect a trip to populate this log.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export default function Diagnostics() {
  if (!import.meta.env.DEV) {
    return <PageNotFound />;
  }

  return <DiagnosticsContent />;
}
