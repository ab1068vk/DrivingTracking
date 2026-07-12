// @ts-check
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, Gauge, MapPinned, ShieldCheck, Target, TrendingUp } from 'lucide-react';
import { limitedTripSummaryQueryOptions, tripSummaryQueryOptions } from '@/api/trips';
import { formatDistance, formatSpeed } from '@/lib/tripEngine';
import useLocalSettings from '@/hooks/useLocalSettings';
import {
  analyzeDayOfWeek,
  analyzeTimeOfDay,
  buildDrivingCoachInsights,
  buildDriverSignature,
} from '@/lib/tripInsights';
import { setJson } from '@/lib/mobileStorage';
import { buildWeeklyCoachSummary } from '@/lib/weeklyCoaching';
import { buildOnDeviceDriverModel, scoreTripAnomaly } from '@/lib/driverAnomaly';
import { logError } from '@/lib/errorReporting';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import InlineRefreshBadge from '@/components/InlineRefreshBadge';
import DeferredRecharts from '@/components/DeferredRecharts';
import { PageEmptyState, PageHeader } from '@/components/PageChrome';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const focusLabels = {
  braking: 'Brake Earlier',
  acceleration: 'Smoother Starts',
  cornering: 'Cleaner Turns',
  'speed control': 'Speed Discipline',
  'fatigue breaks': 'Break Timing',
  'heading events': 'Heading Events (Beta)',
  'stop-start patterns': 'Stop-Start Patterns',
  'distraction risk': 'Attention Pattern Review',
  'attention-pattern review': 'Attention Pattern Review',
  anticipation: 'Anticipation',
  'progressive braking': 'Progressive Braking',
  phone_distraction: 'Phone Distraction',
  consistency: 'Consistency',
};

const DRIVER_SIGNATURE_KEY = 'drivesense_driver_signature';

function MetricCard({ icon: Icon, iconClassName, value, label, detail = null }) {
  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <Icon className={`mb-2 h-5 w-5 ${iconClassName}`} />
      <div className="font-grotesk font-bold text-2xl">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {detail && <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div>}
    </div>
  );
}

function MiniMetric({ value, label, detail = null, className = '' }) {
  return (
    <div className="bg-secondary/50 rounded-xl p-3">
      <div className={`font-grotesk font-bold text-xl ${className}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {detail && <div className="text-[11px] text-muted-foreground capitalize">{detail}</div>}
    </div>
  );
}

export default function DrivingCoach() {
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const {
    data: recentCompleted = [],
    isLoading,
    isFetching: recentFetching,
    isSuccess: recentTripsLoaded,
  } = useQuery({
    ...limitedTripSummaryQueryOptions(50),
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const {
    data: fullHistoryCompleted = [],
    isFetching: fullHistoryFetching,
  } = useQuery({
    ...tripSummaryQueryOptions(),
    enabled: recentTripsLoaded,
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const completed = fullHistoryCompleted.length > 0 ? fullHistoryCompleted : recentCompleted;
  const isFetching = recentFetching || fullHistoryFetching;

  const coach = buildDrivingCoachInsights(completed, settings);
  const coachBrief = coach.coach_brief;
  const riskPatternMax = Math.max(1, ...(coach.risk_patterns || []).map((pattern) => pattern.count));
  const coachBaselineRangeLabel = coach.baseline?.baseline_includes_older_scores
    ? coach.baseline.baseline_label
    : coach.baseline?.baseline_confidence_interval_label;
  const weeklySummary = buildWeeklyCoachSummary(completed);
  const driverSignature = useMemo(() => buildDriverSignature(completed), [completed]);
  const driverModel = useMemo(() => buildOnDeviceDriverModel(completed), [completed]);
  const latestAnomaly = completed[0] && driverModel ? scoreTripAnomaly(completed[0], driverModel) : null;
  const brakingStyle = driverSignature?.dimensions.brakingStyle ?? null;
  const brakingConfidence = driverSignature?.braking_confidence ?? 0;
  const signatureChartData = driverSignature
    ? [
      { dimension: 'Aggression', value: Math.round(driverSignature.dimensions.aggression * 100) },
      { dimension: 'Smooth', value: Math.round(driverSignature.dimensions.smoothness * 100) },
      { dimension: 'Eco', value: Math.round(driverSignature.dimensions.ecoMindedness * 100) },
      { dimension: 'Speeding', value: Math.round(driverSignature.dimensions.speedTolerance * 100) },
      { dimension: 'Braking', value: brakingStyle == null ? null : Math.round(brakingStyle * 100) },
      { dimension: 'Consistent', value: Math.round(driverSignature.dimensions.consistencyIdx * 100) },
    ].filter((item) => Number.isFinite(item.value))
    : [];
  const increasingAggressionShift = driverSignature?.style_shifts?.find((shift) => (
    shift.dimension === 'aggression' && shift.direction === 'increasing'
  ));

  useEffect(() => {
    if (driverSignature) {
      setJson(DRIVER_SIGNATURE_KEY, driverSignature).catch((err) => {
        logError('driver_signature_save', err, {
          trip_count: completed.length,
          style_shift_count: driverSignature.style_shifts?.length || 0,
        });
      });
    }
  }, [driverSignature, completed.length]);

  const timeOfDay = analyzeTimeOfDay(completed);
  const dayOfWeek = analyzeDayOfWeek(completed);
  const mergeScoreValues = completed
    .map((trip) => trip.merge_score)
    .filter((score) => score != null && Number.isFinite(Number(score)))
    .map(Number);
  const avgMergeScore = mergeScoreValues.length
    ? Math.round(mergeScoreValues.reduce((sum, score) => sum + score, 0) / mergeScoreValues.length)
    : null;
  const sviValues = completed
    .map((trip) => trip.speed_variability_index)
    .filter((value) => value != null && value !== '' && Number.isFinite(Number(value)))
    .map(Number);
  const avgSvi = sviValues.length
    ? Math.round(sviValues.reduce((sum, value) => sum + value, 0) / sviValues.length * 10) / 10
    : null;
  const latestSviLabel = completed.find((trip) => trip.svi_score != null && trip.svi_label)?.svi_label || 'unknown';
  const coachingProgress = [...completed].sort((a, b) => new Date(a.start_time || 0).getTime() - new Date(b.start_time || 0).getTime()).slice(-16).map((trip) => {
    const distance = Number(trip.distance_km) || 0;
    const events = Array.isArray(trip.driving_events)
      ? trip.driving_events.length
      : Number(trip.driving_events_count ?? trip.event_count ?? trip.harsh_brakes_count ?? 0) || 0;
    const score = Number(trip.score_overall ?? trip.overall_score ?? trip.score);
    return {
      id: trip.id || trip.start_time,
      label: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(trip.start_time)),
      score: Number.isFinite(score) ? score : null,
      eventRate: distance > 0 ? Math.round(events / distance * 100) / 10 : null,
    };
  });
  const progressHalves = [coachingProgress.slice(0, Math.floor(coachingProgress.length / 2)), coachingProgress.slice(Math.floor(coachingProgress.length / 2))];
  const averageRate = (rows) => {
    const values = rows.map((row) => row.eventRate).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const earlierRate = averageRate(progressHalves[0]);
  const recentRate = averageRate(progressHalves[1]);
  const rateChange = earlierRate && recentRate != null ? Math.round((recentRate - earlierRate) / earlierRate * 100) : null;

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title="Driving Coach"
        description="Actionable driving patterns from your trip history"
        icon={Target}
        status={<InlineRefreshBadge visible={isFetching && !isLoading} label="Refreshing coaching" />}
      />

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-28 rounded-2xl bg-secondary/60 animate-pulse" />
          ))}
        </div>
      ) : completed.length === 0 ? (
        <PageEmptyState
          icon={Target}
          title="No coaching data yet"
          description="Complete trips to unlock driving insights."
        />
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

          {coachBrief && (
            <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="max-w-2xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-bold uppercase text-primary">
                      Current focus
                    </span>
                    <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold capitalize text-muted-foreground">
                      {coachBrief.confidence} evidence
                    </span>
                  </div>
                  <h2 className="mt-3 text-2xl font-grotesk font-bold">
                    {focusLabels[coach.focus_area] || coachBrief.title}
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">{coachBrief.why}</p>
                </div>
                <div className="rounded-2xl bg-primary/10 p-3 text-primary">
                  <Target className="h-6 w-6" />
                </div>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl bg-secondary/50 p-4">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase text-muted-foreground">
                    <Activity className="h-4 w-4" />
                    Practice cue
                  </div>
                  <p className="mt-2 text-sm font-semibold">{coachBrief.cue}</p>
                </div>
                <div className="rounded-2xl bg-secondary/50 p-4">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4" />
                    Success target
                  </div>
                  <p className="mt-2 text-sm font-semibold">{coachBrief.target.summary}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {coachBrief.target.metric}: {coachBrief.target.current} to {coachBrief.target.goal}
                  </p>
                </div>
                <div className="rounded-2xl bg-secondary/50 p-4">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase text-muted-foreground">
                    <TrendingUp className="h-4 w-4" />
                    Progress check
                  </div>
                  <p className="mt-2 text-sm font-semibold">{coachBrief.progress_note}</p>
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
                <div>
                  <div className="text-xs font-bold uppercase text-muted-foreground">{coachBrief.drill.title}</div>
                  <div className="mt-3 space-y-2">
                    {coachBrief.drill.steps.map((step, index) => (
                      <div key={step} className="flex gap-3 rounded-xl border border-border/70 p-3 text-sm">
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                          {index + 1}
                        </div>
                        <div className="text-muted-foreground">{step}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-bold uppercase text-muted-foreground">Evidence used</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {coachBrief.evidence.map((item) => (
                      <span key={item} className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-muted-foreground">
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          <Tabs defaultValue="plan" className="space-y-4">
            <TabsList className="grid h-auto w-full grid-cols-3 rounded-2xl">
              <TabsTrigger value="plan" className="rounded-xl py-2 text-xs sm:text-sm">Plan</TabsTrigger>
              <TabsTrigger value="evidence" className="rounded-xl py-2 text-xs sm:text-sm">Evidence</TabsTrigger>
              <TabsTrigger value="profile" className="rounded-xl py-2 text-xs sm:text-sm">Profile</TabsTrigger>
            </TabsList>

            <TabsContent value="plan" className="space-y-4">
              <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
                <div className="flex items-start gap-3">
                  <Target className="mt-0.5 h-5 w-5 text-primary" />
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
                  <h2 className="font-semibold">This Week's Plan</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Three small actions tied to your current driving pattern</p>
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
            </TabsContent>

            <TabsContent value="evidence" className="space-y-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                <MetricCard
                  icon={AlertTriangle}
                  iconClassName="text-orange-500"
                  value={coach.risk_rate.events_per_100km ?? '-'}
                  label={coach.risk_rate.insufficient_data ? `needs ${coach.risk_rate.minimum_distance_km} km` : 'events per 100 km'}
                />
                <MetricCard
                  icon={ShieldCheck}
                  iconClassName="text-emerald-500"
                  value={formatEstimatedScore(coach.consistency.consistency_score)}
                  label="consistency score"
                />
                <MetricCard
                  icon={Gauge}
                  iconClassName="text-blue-500"
                  value={formatSpeed(coach.speed_discipline.p85_speed_kmh || 0, units)}
                  label="85th percentile speed"
                />
                <MetricCard
                  icon={MapPinned}
                  iconClassName="text-violet-500"
                  value={formatDistance(coach.risk_rate.distance_km, units)}
                  label="distance analyzed"
                />
                <MetricCard
                  icon={ShieldCheck}
                  iconClassName="text-blue-500"
                  value={coach.risk_rate.totals.stop_start_patterns || coach.risk_rate.totals.tailgate_cycles || 0}
                  label="stop-start patterns"
                />
                <MetricCard
                  icon={Gauge}
                  iconClassName="text-slate-500"
                  value={coach.risk_rate.totals.heading_deviations || 0}
                  label="heading events (beta)"
                />
              </div>

              <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="font-semibold">Progress Across Recent Trips</h2>
                    <p className="mt-1 text-xs text-muted-foreground">Scores and event frequency are shown together so progress is not reduced to one number.</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${rateChange == null ? 'bg-secondary text-muted-foreground' : rateChange <= 0 ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>
                    {rateChange == null ? 'More trips needed' : rateChange === 0 ? 'Event rate steady' : `${Math.abs(rateChange)}% ${rateChange < 0 ? 'fewer' : 'more'} events / 10 km`}
                  </span>
                </div>
                <div className="mt-4">
                  <DeferredRecharts height={220}>
                    {({ ResponsiveContainer, ComposedChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend }) => (
                      <ResponsiveContainer width="100%" height={220}>
                        <ComposedChart data={coachingProgress} margin={{ top: 4, right: 0, left: -18, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                          <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} minTickGap={24} />
                          <YAxis yAxisId="score" domain={[0, 100]} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                          <YAxis yAxisId="events" orientation="right" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                          <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                          <Legend />
                          <Line yAxisId="score" type="monotone" dataKey="score" name="Score estimate" stroke="#22c55e" strokeWidth={2} dot={false} connectNulls />
                          <Line yAxisId="events" type="monotone" dataKey="eventRate" name="Events / 10 km" stroke="#f97316" strokeWidth={2} dot={false} connectNulls />
                        </ComposedChart>
                      </ResponsiveContainer>
                    )}
                  </DeferredRecharts>
                </div>
              </div>

              {(coach.risk_patterns || []).length > 0 && (
                <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-semibold">Risk Pattern Breakdown</h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Top contributors behind the current coaching focus.
                      </p>
                    </div>
                    <AlertTriangle className="h-5 w-5 text-orange-500" />
                  </div>
                  <div className="mt-4 space-y-3">
                    {coach.risk_patterns.map((pattern) => (
                      <div key={pattern.key}>
                        <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                          <span className="font-semibold">{pattern.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {pattern.count} events
                            {pattern.events_per_100km == null ? '' : ` - ${pattern.events_per_100km}/100 km`}
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${Math.max(8, Math.round((pattern.count / riskPatternMax) * 100))}%` }}
                          />
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">{pattern.share_percent}% of recorded risk events</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid gap-4 xl:grid-cols-2">
                {coach.baseline?.trend !== 'unknown' && (
                  <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
                    <h2 className="font-semibold mb-1">Adaptive Baseline</h2>
                    <p className="text-xs text-muted-foreground mb-4">This week compared with your rolling 4-week average</p>
                    <div className="grid grid-cols-3 gap-3">
                      <MiniMetric value={coach.baseline.this_week_avg ?? '-'} label="this week" />
                      <MiniMetric
                        value={coach.baseline.baseline_avg == null ? '-' : coachBaselineRangeLabel ? `${coach.baseline.baseline_avg} (${coachBaselineRangeLabel})` : coach.baseline.baseline_avg}
                        label="baseline"
                      />
                      <MiniMetric
                        value={coach.baseline.trend}
                        label="trend"
                        className={`capitalize ${coach.baseline.trend === 'improving' ? 'text-emerald-500' : coach.baseline.trend === 'declining' ? 'text-red-500' : ''}`}
                      />
                    </div>
                  </div>
                )}

                <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
                  <h2 className="font-semibold mb-1">Speed Discipline</h2>
                  <p className="text-xs text-muted-foreground mb-4">
                    {coach.speed_discipline.over_limit_percent}% of sampled route points were above the configured speed threshold.
                  </p>
                  <div className="grid grid-cols-3 gap-3">
                    <MiniMetric value={coach.speed_discipline.sample_points} label="samples" />
                    <MiniMetric value={coach.speed_discipline.over_limit_points} label="over limit" />
                    <MiniMetric value={coach.speed_discipline.level.replace('_', ' ')} label="status" className="capitalize" />
                  </div>
                </div>
              </div>

              <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
                <h2 className="font-semibold mb-1">Highway And Traffic Pressure</h2>
                <p className="text-xs text-muted-foreground mb-4">Merge quality, speed variability, and peak-hour behavior</p>
                <div className="grid grid-cols-3 gap-3">
                  <MiniMetric
                    value={formatEstimatedScore(avgMergeScore)}
                    label="merge score"
                    detail={avgMergeScore == null ? 'No merge evidence' : null}
                    className={avgMergeScore == null ? 'text-muted-foreground' : avgMergeScore >= 80 ? 'text-emerald-500' : avgMergeScore >= 60 ? 'text-yellow-500' : 'text-red-500'}
                  />
                  <MiniMetric value={avgSvi ?? '-'} label="SVI km/h" detail={latestSviLabel} />
                  <MiniMetric
                    value={coach.peak_hour_stress.stress_ratio == null ? '-' : `${coach.peak_hour_stress.stress_ratio}x`}
                    label="peak stress"
                    detail={coach.peak_hour_stress.peak_stress_label}
                  />
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
                  <h2 className="font-semibold mb-1">Best Driving Window</h2>
                  <p className="text-xs text-muted-foreground mb-4">
                    Average score by trip start time. Best-window coaching needs at least {coach.best_window_min_trips} trips in a bucket.
                  </p>
                  <DeferredRecharts height={180}>
                    {({ ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip }) => (
                      <ResponsiveContainer width="100%" height={180}>
                        <BarChart data={timeOfDay} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                          <XAxis dataKey="label" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                          <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                          <Tooltip
                            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                            formatter={(v, name) => [name === 'Avg score' ? formatEstimatedScore(v) : v, name]}
                          />
                          <Bar dataKey="avgScore" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="Avg score" />
                          <Bar dataKey="events" fill="#f97316" radius={[4, 4, 0, 0]} name="Risk events" />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </DeferredRecharts>
                </div>

                <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
                  <h2 className="font-semibold mb-1">Day Pattern</h2>
                  <p className="text-xs text-muted-foreground mb-4">Risk events and score across the week</p>
                  <DeferredRecharts height={180}>
                    {({ ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip }) => (
                      <ResponsiveContainer width="100%" height={180}>
                        <BarChart data={dayOfWeek} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                          <XAxis dataKey="day" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                          <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                          <Tooltip
                            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                            formatter={(v, name) => [name === 'Avg score' ? formatEstimatedScore(v) : v, name]}
                          />
                          <Bar dataKey="events" fill="#ef4444" radius={[4, 4, 0, 0]} name="Risk events" />
                          <Bar dataKey="avgScore" fill="#22c55e" radius={[4, 4, 0, 0]} name="Avg score" />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </DeferredRecharts>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="profile" className="space-y-4">
              {driverSignature ? (
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
                  <DeferredRecharts height={220}>
                    {({ ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, Radar, Tooltip }) => (
                      <ResponsiveContainer width="100%" height={220}>
                        <RadarChart data={signatureChartData} outerRadius={76}>
                          <PolarGrid />
                          <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 10 }} />
                          <Radar dataKey="value" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.22} />
                          <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                        </RadarChart>
                      </ResponsiveContainer>
                    )}
                  </DeferredRecharts>
                  <div className="mb-3 rounded-xl bg-secondary/50 p-3 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">Braking signature: </span>
                    <span>{brakingStyle == null ? '-' : `${Math.round(brakingStyle * 100)}%`}</span>
                    <span className="ml-2">
                      {brakingConfidence < 1 ? 'Low confidence' : 'High confidence'} ({Math.round(brakingConfidence * 100)}% braking evidence)
                    </span>
                  </div>
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
              ) : (
                <div className="rounded-3xl border border-dashed border-border p-5 text-sm text-muted-foreground">
                  Complete at least five scored trips to unlock your driving style signature.
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
                    Anomaly score {formatEstimatedScore(latestAnomaly.anomaly_score)}/100
                    {latestAnomaly.reasons.length ? ` - unusual: ${latestAnomaly.reasons.join(', ').replace(/_/g, ' ')}` : ''}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    This compares the trip with your own history. A moderate flag means the trip was notably different, not necessarily unsafe.
                  </p>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
