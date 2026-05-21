import { motion } from 'framer-motion';
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Brain, Gauge, MapPinned, ShieldCheck, Target } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { tripService } from '@/api/trips';
import { formatDistance, formatSpeed } from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import {
  analyzeDayOfWeek,
  analyzeTimeOfDay,
  buildDrivingCoachInsights,
  buildDriverSignature,
} from '@/lib/tripInsights';
import { setJson } from '@/lib/mobileStorage';
import { buildWeeklyCoachSummary } from '@/lib/weeklyCoaching';
import { buildOnDeviceDriverModel, scoreTripAnomaly } from '@/lib/driverAnomaly';

const focusLabels = {
  braking: 'Brake Earlier',
  acceleration: 'Smoother Starts',
  cornering: 'Cleaner Turns',
  'speed control': 'Speed Discipline',
  'fatigue breaks': 'Break Timing',
  'lane discipline': 'Lane Discipline',
  'following distance': 'Following Distance',
  'distraction risk': 'Distraction Risk',
  anticipation: 'Anticipation',
  'progressive braking': 'Progressive Braking',
  phone_distraction: 'Phone Distraction',
  consistency: 'Consistency',
};

const DRIVER_SIGNATURE_KEY = 'drivesense_driver_signature';

export default function DrivingCoach() {
  const settings = localSettings.get();
  const units = settings.units || 'metric';
  const { data: allTrips = [], isLoading } = useQuery({
    queryKey: ['coach-trips'],
    queryFn: () => tripService.listAll({ sort: '-start_time' }),
  });

  const completed = allTrips.filter((trip) => trip.status === 'completed');
  const coach = buildDrivingCoachInsights(completed, settings);
  const weeklySummary = buildWeeklyCoachSummary(completed);
  const driverSignature = useMemo(() => buildDriverSignature(completed), [completed]);
  const driverModel = useMemo(() => buildOnDeviceDriverModel(completed), [completed]);
  const latestAnomaly = completed[0] && driverModel ? scoreTripAnomaly(completed[0], driverModel) : null;
  const signatureChartData = driverSignature
    ? [
      { dimension: 'Aggression', value: Math.round(driverSignature.dimensions.aggression * 100) },
      { dimension: 'Smooth', value: Math.round(driverSignature.dimensions.smoothness * 100) },
      { dimension: 'Eco', value: Math.round(driverSignature.dimensions.ecoMindedness * 100) },
      { dimension: 'Speed', value: Math.round(driverSignature.dimensions.speedTolerance * 100) },
      { dimension: 'Braking', value: Math.round(driverSignature.dimensions.brakingStyle * 100) },
      { dimension: 'Consistent', value: Math.round(driverSignature.dimensions.consistencyIdx * 100) },
    ]
    : [];
  const increasingAggressionShift = driverSignature?.style_shifts?.find((shift) => (
    shift.dimension === 'aggression' && shift.direction === 'increasing'
  ));
  useEffect(() => {
    if (driverSignature) setJson(DRIVER_SIGNATURE_KEY, driverSignature).catch(() => {});
  }, [driverSignature]);
  const timeOfDay = analyzeTimeOfDay(completed);
  const dayOfWeek = analyzeDayOfWeek(completed);
  const avgMergeScore = completed.length
    ? Math.round(completed.reduce((sum, trip) => sum + (trip.merge_score ?? 100), 0) / completed.length)
    : null;
  const avgSvi = completed.length
    ? Math.round(completed.reduce((sum, trip) => sum + (trip.speed_variability_index || 0), 0) / completed.length * 10) / 10
    : null;
  const latestSviLabel = completed.find((trip) => trip.svi_label)?.svi_label || 'unknown';

  return (
    <div className="space-y-6 pb-4">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-grotesk font-bold">Driving Coach</h1>
          <p className="text-muted-foreground text-sm mt-1">Actionable driving patterns from your trip history</p>
        </div>
        <div className="w-11 h-11 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Brain className="w-5 h-5 text-primary" />
        </div>
      </motion.div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-28 rounded-2xl bg-secondary/60 animate-pulse" />
          ))}
        </div>
      ) : completed.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <Brain className="w-12 h-12 text-muted-foreground mb-3" />
          <div className="font-semibold">No coaching data yet</div>
          <div className="text-muted-foreground text-sm mt-1">Complete trips to unlock driving insights</div>
        </div>
      ) : (
        <>
          {increasingAggressionShift && (
            <div className="rounded-3xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-300">
              <div className="font-semibold">Style shift detected</div>
              <div className="mt-1">
                Your driving has become more aggressive in the last 5 trips. The shift is +{Math.round(increasingAggressionShift.delta * 100)} percentage points from your prior baseline.
              </div>
            </div>
          )}

          {driverSignature && (
            <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Your Driving Style</h2>
                  <div className="mt-1 text-2xl font-grotesk font-bold capitalize">
                    {driverSignature.archetype.replaceAll('_', ' ')}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Built from {driverSignature.trip_count_used} recent trips.
                  </p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <RadarChart data={signatureChartData} outerRadius={76}>
                  <PolarGrid />
                  <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 10 }} />
                  <Radar dataKey="value" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.22} />
                  <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                </RadarChart>
              </ResponsiveContainer>
              {driverSignature.style_shifts.length > 0 && (
                <div className="rounded-xl bg-secondary/50 p-3 text-xs text-muted-foreground">
                  {driverSignature.style_shifts.map((shift) => (
                    <span key={`${shift.dimension}-${shift.direction}`} className="mr-2 capitalize">
                      {shift.dimension}: {shift.direction} {Math.round(shift.delta * 100)}%
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <Brain className="mt-0.5 h-5 w-5 text-primary" />
              <div>
                <h2 className="font-semibold">Local Weekly Coach</h2>
                <div className="mt-2 text-lg font-grotesk font-bold">{weeklySummary.headline}</div>
                <p className="mt-1 text-xs text-muted-foreground">{weeklySummary.insight}</p>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {weeklySummary.actions.map((action) => (
                <div key={action} className="rounded-xl bg-secondary/50 p-3 text-sm text-muted-foreground">{action}</div>
              ))}
            </div>
          </div>

          {weeklySummary.plan?.length > 0 && (
            <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <Target className="mt-0.5 h-5 w-5 text-primary" />
                <div>
                  <h2 className="font-semibold">This Week's Plan</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Three small actions tied to your current driving pattern</p>
                </div>
              </div>
              <div className="mt-4 grid gap-2 md:grid-cols-3">
                {weeklySummary.plan.map((item) => (
                  <div key={item.id} className="rounded-2xl bg-secondary/50 p-3">
                    <div className="text-xs font-bold uppercase text-primary">{item.title}</div>
                    <div className="mt-2 text-sm font-semibold">{item.action}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{item.target}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {latestAnomaly && latestAnomaly.anomaly_level !== 'unknown' && (
            <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold">On-Device Driver Signature</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Last trip compared against {latestAnomaly.model_trip_count} local trips.
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase ${
                  latestAnomaly.anomaly_level === 'high'
                    ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                    : latestAnomaly.anomaly_level === 'moderate'
                      ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
                      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                }`}>
                  {latestAnomaly.anomaly_level}
                </span>
              </div>
              <div className="mt-3 text-sm text-muted-foreground">
                Anomaly score {latestAnomaly.anomaly_score}/100
                {latestAnomaly.reasons.length ? ` · unusual: ${latestAnomaly.reasons.join(', ').replace(/_/g, ' ')}` : ''}
              </div>
            </div>
          )}

          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Target className="w-6 h-6 text-primary" />
              </div>
              <div className="flex-1">
                <div className="text-xs text-muted-foreground mb-1">Current focus</div>
                <h2 className="font-grotesk font-bold text-2xl">
                  {focusLabels[coach.focus_area] || coach.focus_area}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Based on {coach.trip_count} completed trips, {coach.risk_rate.total_events} risky events, and route speed samples.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-card border border-border rounded-2xl p-4">
              <AlertTriangle className="w-5 h-5 text-orange-500 mb-2" />
              <div className="font-grotesk font-bold text-2xl">{coach.risk_rate.events_per_100km}</div>
              <div className="text-xs text-muted-foreground">events per 100 km</div>
            </div>
            <div className="bg-card border border-border rounded-2xl p-4">
              <ShieldCheck className="w-5 h-5 text-emerald-500 mb-2" />
              <div className="font-grotesk font-bold text-2xl">{coach.consistency.consistency_score ?? '-'}</div>
              <div className="text-xs text-muted-foreground">consistency score</div>
            </div>
            <div className="bg-card border border-border rounded-2xl p-4">
              <Gauge className="w-5 h-5 text-blue-500 mb-2" />
              <div className="font-grotesk font-bold text-2xl">{formatSpeed(coach.speed_discipline.p85_speed_kmh || 0, units)}</div>
              <div className="text-xs text-muted-foreground">85th percentile speed</div>
            </div>
            <div className="bg-card border border-border rounded-2xl p-4">
              <MapPinned className="w-5 h-5 text-violet-500 mb-2" />
              <div className="font-grotesk font-bold text-2xl">{formatDistance(coach.risk_rate.distance_km, units)}</div>
              <div className="text-xs text-muted-foreground">distance analyzed</div>
            </div>
            <div className="bg-card border border-border rounded-2xl p-4">
              <ShieldCheck className="w-5 h-5 text-blue-500 mb-2" />
              <div className="font-grotesk font-bold text-2xl">{coach.risk_rate.totals.tailgate_cycles || 0}</div>
              <div className="text-xs text-muted-foreground">following gaps</div>
            </div>
            <div className="bg-card border border-border rounded-2xl p-4">
              <Gauge className="w-5 h-5 text-slate-500 mb-2" />
              <div className="font-grotesk font-bold text-2xl">{coach.risk_rate.totals.lane_changes || 0}</div>
              <div className="text-xs text-muted-foreground">lane changes</div>
            </div>
          </div>

          {coach.baseline?.trend !== 'unknown' && (
            <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
              <h2 className="font-semibold mb-1">Adaptive Baseline</h2>
              <p className="text-xs text-muted-foreground mb-4">This week compared with your rolling 4-week average</p>
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-secondary/50 rounded-xl p-3">
                  <div className="font-grotesk font-bold text-xl">{coach.baseline.this_week_avg ?? '-'}</div>
                  <div className="text-xs text-muted-foreground">this week</div>
                </div>
                <div className="bg-secondary/50 rounded-xl p-3">
                  <div className="font-grotesk font-bold text-xl">{coach.baseline.baseline_avg ?? '-'}</div>
                  <div className="text-xs text-muted-foreground">baseline</div>
                </div>
                <div className="bg-secondary/50 rounded-xl p-3">
                  <div className={`font-grotesk font-bold text-xl capitalize ${
                    coach.baseline.trend === 'improving' ? 'text-emerald-500' : coach.baseline.trend === 'declining' ? 'text-red-500' : ''
                  }`}>{coach.baseline.trend}</div>
                  <div className="text-xs text-muted-foreground">trend</div>
                </div>
              </div>
            </div>
          )}

          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <h2 className="font-semibold mb-3">Next Driving Actions</h2>
            <div className="space-y-2">
              {coach.actions.map((action) => (
                <div key={action} className="text-sm text-muted-foreground bg-secondary/50 rounded-xl p-3">
                  {action}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <h2 className="font-semibold mb-1">Speed Discipline</h2>
            <p className="text-xs text-muted-foreground mb-4">
              {coach.speed_discipline.over_limit_percent}% of sampled route points were above the configured speed threshold.
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl">{coach.speed_discipline.sample_points}</div>
                <div className="text-xs text-muted-foreground">samples</div>
              </div>
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl">{coach.speed_discipline.over_limit_points}</div>
                <div className="text-xs text-muted-foreground">over limit</div>
              </div>
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl capitalize">{coach.speed_discipline.level.replace('_', ' ')}</div>
                <div className="text-xs text-muted-foreground">status</div>
              </div>
            </div>
          </div>

          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <h2 className="font-semibold mb-1">Highway And Traffic Pressure</h2>
            <p className="text-xs text-muted-foreground mb-4">Merge quality, speed variability, and peak-hour behavior</p>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className={`font-grotesk font-bold text-xl ${
                  (avgMergeScore ?? 100) >= 80 ? 'text-emerald-500' : (avgMergeScore ?? 100) >= 60 ? 'text-yellow-500' : 'text-red-500'
                }`}>{avgMergeScore ?? '-'}</div>
                <div className="text-xs text-muted-foreground">merge score</div>
              </div>
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl">{avgSvi ?? '-'}</div>
                <div className="text-xs text-muted-foreground">SVI km/h</div>
                <div className="text-[11px] text-muted-foreground capitalize">{latestSviLabel}</div>
              </div>
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl">{coach.peak_hour_stress.stress_ratio}x</div>
                <div className="text-xs text-muted-foreground">peak stress</div>
                <div className="text-[11px] text-muted-foreground capitalize">{coach.peak_hour_stress.peak_stress_label}</div>
              </div>
            </div>
          </div>

          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <h2 className="font-semibold mb-1">Best Driving Window</h2>
            <p className="text-xs text-muted-foreground mb-4">Average score by trip start time</p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={timeOfDay} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="avgScore" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="Avg score" />
                <Bar dataKey="events" fill="#f97316" radius={[4, 4, 0, 0]} name="Risk events" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <h2 className="font-semibold mb-1">Day Pattern</h2>
            <p className="text-xs text-muted-foreground mb-4">Risk events and score across the week</p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={dayOfWeek} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="events" fill="#ef4444" radius={[4, 4, 0, 0]} name="Risk events" />
                <Bar dataKey="avgScore" fill="#22c55e" radius={[4, 4, 0, 0]} name="Avg score" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
