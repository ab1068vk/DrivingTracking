import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { tripService } from '@/api/trips';
import { useQuery } from '@tanstack/react-query';
import {
  Car, Play, Square, Navigation, Gauge,
  AlertTriangle, Zap, TrendingDown, CornerUpRight, RefreshCw, MapPin
} from 'lucide-react';
import {
  DEFAULT_THRESHOLDS,
  calculateTripStats, detectDrivingEvents, calculateTripScores,
  formatDistance, formatDuration, formatSpeed, getScoreColor
} from '@/lib/tripEngine';
import { activeTripStore, localSettings } from '@/lib/trackingStore';
import { createDrivingTrackingService } from '@/lib/trackingService';
import { scheduleLongTripReminder, cancelLongTripReminder, notifyTripCompleted } from '@/lib/notificationService';
import { requestActivityRecognitionPermission, requestBackgroundLocationPermission, requestForegroundLocationPermission } from '@/lib/permissions';
import { startActivityRecognition, shouldAutoStartTracking, shouldAutoStopTracking } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import ScoreRing from '@/components/ScoreRing';
import StatCard from '@/components/StatCard';
import TripCard from '@/components/TripCard';
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';

const MIN_MANUAL_SAVE_SECONDS = 5;

export default function Dashboard() {
  const [activeTrip, setActiveTrip] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [locationError, setLocationError] = useState(null);
  const locationService = useRef(null);
  const autoLocationService = useRef(null);
  const activityStopRef = useRef(null);
  const activeTripRef = useRef(null);
  const trackingRef = useRef(false);
  const latestActivityRef = useRef(null);
  const recentMovingSinceRef = useRef(null);
  const stillSinceRef = useRef(null);
  const timerRef = useRef(null);
  const settings = localSettings.get();

  useEffect(() => {
    activeTripRef.current = activeTrip;
  }, [activeTrip]);

  useEffect(() => {
    trackingRef.current = tracking;
  }, [tracking]);

  // Load recent trips
  const { data: recentTrips = [], refetch } = useQuery({
    queryKey: ['recent-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 20 }),
  });

  const completedTrips = recentTrips.filter(t => t.status === 'completed');

  // Resume active trip from session (crash recovery)
  useEffect(() => {
    const recovered = activeTripStore.get();
    if (recovered) {
      setActiveTrip(recovered);
      setTracking(true);
      startTimer(new Date(recovered.start_time));
      // Re-attach GPS
      startGPS();
    }
    return () => {
      stopTimer();
      locationService.current?.stop();
    };
  }, []);

  const startTimer = (startTime) => {
    stopTimer();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.getTime()) / 1000));
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startGPS = useCallback(() => {
    const cfg = localSettings.get();
    const useBackground = cfg.background_tracking_enabled || cfg.tracking_mode === 'background_auto';
    if (!locationService.current) {
      locationService.current = createDrivingTrackingService({ background: useBackground });
    }
    locationService.current.start(
      (point) => {
        setCurrentLocation(point);
        setLocationError(null);
        activeTripStore.addPoint(point);
        setActiveTrip(prev => {
          if (!prev) return prev;
          const updated = { ...prev, route_points: [...(prev.route_points || []), point] };
          activeTripStore.set(updated);
          return updated;
        });
      },
      (err) => setLocationError(err.message)
    );
  }, []);

  const handleStartTrip = useCallback(async ({ autoStarted = false } = {}) => {
    if (trackingRef.current) return;

    const cfg = localSettings.get();
    if (cfg.tracking_paused) {
      setLocationError('Tracking is paused in Settings.');
      return;
    }

    const useBackground = cfg.background_tracking_enabled || cfg.tracking_mode === 'background_auto';
    if ((autoStarted || cfg.auto_tracking_enabled || cfg.tracking_mode !== 'manual') && isAndroid()) {
      const activityGranted = await requestActivityRecognitionPermission();
      if (!activityGranted) {
        setLocationError('Physical activity permission is required for auto trip detection.');
        return;
      }
    }

    const granted = useBackground
      ? await requestBackgroundLocationPermission()
      : await requestForegroundLocationPermission();

    if (!granted) {
      setLocationError(useBackground
        ? 'Background tracking needs location and notification permission before a trip can start.'
        : 'Location permission denied. Please enable location to start a trip.');
      return;
    }

    const tripData = {
      start_time: new Date().toISOString(),
      status: 'active',
      route_points: [],
      driving_events: [],
      background_tracking: useBackground,
      start_source: autoStarted ? 'auto' : 'manual',
    };

    activeTripStore.set(tripData);
    setActiveTrip(tripData);
    setTracking(true);
    startTimer(new Date());
    startGPS();
    scheduleLongTripReminder(tripData.start_time);
  }, [startGPS]);

  const handleEndTrip = async () => {
    const tripToEnd = activeTripRef.current || activeTrip;
    if (!tripToEnd) return;

    locationService.current?.stop();
    locationService.current = null;
    stopTimer();
    await cancelLongTripReminder();

    const endTime = new Date().toISOString();
    const pts = tripToEnd.route_points || [];
    const stats = calculateTripStats(pts, tripToEnd.start_time, endTime);

    const isManualTrip = tripToEnd.start_source !== 'auto';
    const shouldDiscard = isManualTrip
      ? pts.length === 0 || stats.duration_seconds < MIN_MANUAL_SAVE_SECONDS
      : stats.distance_km < DEFAULT_THRESHOLDS.MIN_TRIP_DISTANCE_KM ||
        stats.duration_seconds < DEFAULT_THRESHOLDS.MIN_TRIP_DURATION_SECONDS;

    if (shouldDiscard) {
      activeTripStore.clear();
      setActiveTrip(null);
      setTracking(false);
      setElapsed(0);
      setLocationError(isManualTrip
        ? 'Trip was not saved because GPS did not get a fix yet. Wait a few seconds after Start, then stop again.'
        : 'Auto-detected trip was ignored because it was too short.');
      return;
    }

    const events = detectDrivingEvents(pts, {
      HARSH_BRAKE_MS2: settings.threshold_harsh_brake_ms2 || 4.5,
      RAPID_ACCEL_MS2: settings.threshold_rapid_accel_ms2 || 3.5,
      SHARP_TURN_DEG_PER_S: settings.threshold_sharp_turn_degs || 45,
      SPEEDING_FALLBACK_KMH: settings.threshold_speeding_kmh || 130,
      IDLE_SPEED_KMH: 5,
      IDLE_EVENT_SECONDS: settings.threshold_idle_seconds || 60,
      LONG_DRIVE_MINUTES: settings.threshold_long_drive_minutes || 120,
    });

    const scores = calculateTripScores(events, stats);

    const completedTrip = {
      ...stats,
      start_time: tripToEnd.start_time,
      end_time: endTime,
      route_points: pts,
      driving_events: events,
      ...scores,
      status: 'completed',
      background_tracking: tripToEnd.background_tracking,
      start_source: tripToEnd.start_source || 'manual',
    };

    await tripService.create(completedTrip);
    if (settings.trip_end_notification) await notifyTripCompleted(completedTrip);
    activeTripStore.clear();
    setActiveTrip(null);
    setTracking(false);
    setElapsed(0);
    refetch();
  };

  // Stats
  const totalTrips = completedTrips.length;
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const weekTrips = completedTrips.filter(t => new Date(t.start_time) >= weekAgo);
  const weekDistance = weekTrips.reduce((s, t) => s + (t.distance_km || 0), 0);
  const avgScore = completedTrips.length
    ? Math.round(completedTrips.reduce((s, t) => s + (t.score_overall || 0), 0) / completedTrips.length)
    : 0;
  const latestTrip = completedTrips[0];
  const scoreTrend = completedTrips.slice(0, 10).reverse().map((t, i) => ({ i, score: t.score_overall || 0 }));

  const { color: scoreColor } = getScoreColor(avgScore);
  const units = settings.units || 'metric';

  return (
    <div className="space-y-6 pb-4">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-grotesk font-bold">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
      </motion.div>

      {/* Location Error */}
      <AnimatePresence>
        {locationError && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-start gap-3 p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-2xl"
          >
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold text-red-700 dark:text-red-400">Location Error</div>
              <div className="text-xs text-red-600 dark:text-red-500 mt-0.5">{locationError}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Active Trip Card */}
      <AnimatePresence mode="wait">
        {tracking ? (
          <motion.div
            key="active"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className="bg-gradient-to-br from-blue-600 to-blue-800 rounded-3xl p-6 text-white shadow-2xl"
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2.5 h-2.5 bg-red-400 rounded-full animate-pulse" />
                  <span className="text-white/80 text-sm font-medium">Trip Active</span>
                </div>
                <div className="font-grotesk font-bold text-4xl">{formatDuration(elapsed)}</div>
                <div className="text-white/70 text-sm mt-1">
                  {activeTrip?.route_points?.length ? (
                    (() => {
                      const stats = calculateTripStats(
                        activeTrip.route_points,
                        activeTrip.start_time,
                        new Date().toISOString()
                      );
                      return `${formatDistance(stats.distance_km, units)} · ${formatSpeed(stats.avg_speed_kmh, units)} avg`;
                    })()
                  ) : 'Getting GPS signal...'}
                </div>
              </div>
              <div className="p-3 bg-white/10 rounded-2xl">
                <Car className="w-8 h-8" />
              </div>
            </div>

            {currentLocation && (() => {
              const spd = currentLocation.speed_kmh || 0;
              const overLimit = settings.threshold_speeding_kmh || 130;
              const warnOffset = settings.threshold_speed_over_kmh ?? 10;
              const isOverWarn = spd > overLimit + warnOffset;
              return (
                <div className="flex items-center gap-2 text-sm mb-4">
                  <MapPin className="w-3.5 h-3.5 text-white/70" />
                  <span className={`font-semibold ${isOverWarn ? 'text-red-300 animate-pulse' : 'text-white/70'}`}>
                    {formatSpeed(spd, units)}{isOverWarn ? ' ⚠️ Over limit!' : ''}
                  </span>
                  <span className="opacity-50 text-white/70">·</span>
                  <span className="text-white/70">Acc: {Math.round(currentLocation.accuracy || 0)}m</span>
                </div>
              );
            })()}

            <button
              onClick={handleEndTrip}
              className="w-full py-3 bg-white/15 hover:bg-white/25 backdrop-blur rounded-xl font-semibold transition-colors flex items-center justify-center gap-2"
            >
              <Square className="w-4 h-4" />
              End Trip
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="idle"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className="bg-card border border-border rounded-3xl p-6 shadow-sm"
          >
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="text-muted-foreground text-sm mb-1">Ready to drive?</div>
                <div className="font-grotesk font-bold text-xl">Start a new trip</div>
                <div className="text-muted-foreground text-xs mt-1">Tap to begin tracking your route</div>
              </div>
              <button
                onClick={handleStartTrip}
                className="w-16 h-16 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl flex items-center justify-center shadow-lg hover:opacity-90 transition-opacity"
              >
                <Play className="w-7 h-7 text-white ml-0.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={Navigation}
          label="This Week"
          value={formatDistance(weekDistance, units)}
          gradient="bg-gradient-to-br from-blue-500 to-indigo-600"
          index={0}
        />
        <StatCard
          icon={Car}
          label="Total Trips"
          value={totalTrips}
          gradient="bg-gradient-to-br from-emerald-400 to-green-600"
          index={1}
        />
      </div>

      {/* Score & Trend */}
      <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="font-semibold text-base">Driving Score</h2>
            <p className="text-muted-foreground text-xs mt-0.5">Last {Math.min(10, completedTrips.length)} trips</p>
          </div>
          {avgScore > 0 && (
            <ScoreRing score={avgScore} size={72} strokeWidth={6} sublabel="avg" />
          )}
        </div>

        {scoreTrend.length > 2 ? (
          <ResponsiveContainer width="100%" height={60}>
            <LineChart data={scoreTrend}>
              <Line
                type="monotone"
                dataKey="score"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={false}
              />
              <Tooltip
                contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                formatter={(v) => [v, 'Score']}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-12 flex items-center justify-center text-muted-foreground text-xs">
            Complete more trips to see trend
          </div>
        )}
      </div>

      {/* Quick event stats */}
      {completedTrips.length > 0 && (() => {
        const hb = completedTrips.reduce((s, t) => s + (t.harsh_brakes_count || 0), 0);
        const ra = completedTrips.reduce((s, t) => s + (t.rapid_accel_count || 0), 0);
        const st = completedTrips.reduce((s, t) => s + (t.sharp_turns_count || 0), 0);
        const sp = completedTrips.reduce((s, t) => s + (t.speeding_events_count || 0), 0);
        return (
          <div>
            <h2 className="font-semibold text-base mb-3">Event Summary</h2>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Harsh Brakes', value: hb, icon: TrendingDown, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-950/30' },
                { label: 'Rapid Accel', value: ra, icon: Zap, color: 'text-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-950/30' },
                { label: 'Sharp Turns', value: st, icon: CornerUpRight, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' },
                { label: 'Speeding', value: sp, icon: Gauge, color: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/30' },
              ].map(({ label, value, icon: Icon, color, bg }) => (
                <div key={label} className={`${bg} rounded-2xl p-4 border border-border/50`}>
                  <Icon className={`w-5 h-5 ${color} mb-2`} />
                  <div className={`font-grotesk font-bold text-2xl ${color}`}>{value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Recent Trips */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-base">Recent Trips</h2>
          <button onClick={() => refetch()} className="p-1.5 hover:bg-secondary rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {completedTrips.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-16 h-16 bg-secondary rounded-3xl flex items-center justify-center mb-4">
              <Car className="w-8 h-8 text-muted-foreground" />
            </div>
            <div className="font-semibold text-foreground mb-1">No trips yet</div>
            <div className="text-muted-foreground text-sm">Start your first trip to see it here</div>
          </div>
        ) : (
          <div className="space-y-3">
            {completedTrips.slice(0, 5).map((trip, i) => (
              <TripCard key={trip.id} trip={trip} units={units} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
