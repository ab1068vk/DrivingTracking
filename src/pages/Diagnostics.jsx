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
import { localSettings } from '@/lib/trackingStore';

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

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'time unknown';
  return date.toLocaleString();
}

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
        <div className="mt-0.5 text-xs text-muted-foreground">{formatTime(event.timestamp)}</div>
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

export default function Diagnostics() {
  const [permissionStatus, setPermissionStatus] = useState(null);
  const [nativeStatus, setNativeStatus] = useState(null);
  const [batteryStatus, setBatteryStatus] = useState(null);
  const [nativeDiagnostics, setNativeDiagnostics] = useState({ enabled: false, events: [] });
  const [webDiagnostics, setWebDiagnostics] = useState(() => getTrackingDiagnostics());
  const [refreshing, setRefreshing] = useState(false);

  const { data: trips = [], refetch } = useQuery({
    queryKey: ['diagnostics-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 20 }),
  });
  const latestTrip = trips.find((trip) => trip.status === 'completed') || null;

  const refresh = async () => {
    setRefreshing(true);
    setWebDiagnostics(getTrackingDiagnostics());
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
      await refetch();
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
  const settings = localSettings.get();
  const backgroundAutoEnabled = settings.tracking_mode === 'background_auto' && !settings.tracking_paused;

  const clearLogs = async () => {
    clearTrackingDiagnostics();
    if (isAndroid()) await clearNativeDiagnostics().catch(() => {});
    await refresh();
  };

  const armNative = async () => {
    if (!isAndroid()) return;
    await startNativeAutoTracking().catch(() => {});
    await refresh();
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
