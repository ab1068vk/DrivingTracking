// @ts-check
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Award, CalendarDays, CheckCircle2, Clock, ExternalLink, Flag, ListChecks, MapPinned, Route, ShieldAlert, Smartphone, Target, TrendingUp } from 'lucide-react';
import { limitedTripSummaryQueryOptions, tripSummaryQueryOptions } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import useLocalSettings from '@/hooks/useLocalSettings';
import { formatDistance, getScoreColor } from '@/lib/tripEngine';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import { isDriverMetricEligible, summarizePhoneUseAcrossTrips } from '@/lib/phoneUseSummary';
import phoneUseRiskImage from '@/assets/phone-use-risk.jpg';
import {
  achievementNextStepLabel,
  achievementProgressLabel,
  achievementProgressValue,
  calculateAchievementBadges,
  summarizeAchievementBadges,
} from '@/lib/tripInsights';
import {
  buildCommuteDetections,
  buildDriverInsightBrief,
  buildGoalStatus,
  buildRoadTypeBreakdown,
  buildRouteComparisons,
  buildTripCalendarMonth,
  buildWeeklyDriverSummary,
} from '@/lib/mediumInsights';
import InlineRefreshBadge from '@/components/InlineRefreshBadge';
import { PageEmptyState, PageHeader } from '@/components/PageChrome';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const dayInitials = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const nhtsaDistractedDrivingFacts = [
  { value: '3,208', label: 'people killed in crashes involving distracted drivers in 2024' },
  { value: '315k+', label: 'people injured in crashes involving distracted drivers in 2024' },
  { value: '8%', label: 'of fatal crashes involved distracted drivers in 2024' },
];
const phoneUseHazards = [
  'Looking away from the road',
  'Taking a hand off the wheel',
  'Thinking about the phone instead of traffic',
  'Late braking or missed pedestrian/cyclist cues',
];

const formatPhoneDuration = (seconds = 0) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
};

const phoneUseRiskTone = (risk = 'none') => ({
  high: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-300',
  medium: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800/50 dark:bg-orange-950/30 dark:text-orange-300',
  low: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800/50 dark:bg-yellow-950/30 dark:text-yellow-300',
  none: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300',
}[risk] || 'border-border bg-secondary text-foreground');

export default function Insights() {
  const navigate = useNavigate();
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const [monthOffset, setMonthOffset] = useState(0);
  const monthDate = useMemo(() => {
    const date = new Date();
    date.setMonth(date.getMonth() + monthOffset);
    return date;
  }, [monthOffset]);

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
  const { data: vehicles = [] } = useQuery({
    queryKey: ['insights-achievement-vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 100 }),
  });

  const driverCompleted = completed.filter(isDriverMetricEligible);
  const routes = buildRouteComparisons(driverCompleted);
  const commutes = buildCommuteDetections(driverCompleted);
  const calendar = buildTripCalendarMonth(driverCompleted, monthDate);
  const weekly = buildWeeklyDriverSummary(driverCompleted, settings);
  const roadTypes = buildRoadTypeBreakdown(driverCompleted);
  const phoneUseSummary = useMemo(() => summarizePhoneUseAcrossTrips(completed), [completed]);
  const insightBrief = buildDriverInsightBrief(completed, settings, {
    driverTrips: driverCompleted,
    phoneUseSummary,
  });
  const achievementSummary = useMemo(
    () => summarizeAchievementBadges(calculateAchievementBadges(completed, settings, vehicles)),
    [completed, settings, vehicles]
  );
  const goalStatus = buildGoalStatus(
    driverCompleted.filter((trip) => new Date(trip.start_time).getTime() >= (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - d.getDay());
      return d.getTime();
    })()),
    settings
  );

  return (
    <div className="space-y-6 pb-6">
      <PageHeader
        title="Driving Insights"
        description="Routes, calendar patterns, weekly summary, and custom goals"
        icon={TrendingUp}
        status={<InlineRefreshBadge visible={isFetching && !isLoading} label="Refreshing insights" />}
      />

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((item) => <div key={item} className="h-32 rounded-2xl bg-secondary/50 animate-pulse" />)}
        </div>
      ) : completed.length === 0 ? (
        <PageEmptyState
          icon={TrendingUp}
          title="No insights yet"
          description="Complete a few trips to compare repeated routes, build a monthly calendar, and summarize weekly driving."
        >
          <div className="grid w-full max-w-lg grid-cols-2 gap-2 text-left text-xs md:grid-cols-3">
            {['Weekly Driver Summary', 'Trip Calendar', 'Route Comparison', 'Commute Detection', 'Custom Goals', 'Road Type Breakdown'].map((label) => (
              <div key={label} className="rounded-xl bg-secondary/50 px-3 py-2 font-medium text-muted-foreground">
                {label}
              </div>
            ))}
          </div>
        </PageEmptyState>
      ) : (
        <>
          <InsightBriefPanel insightBrief={insightBrief} navigate={navigate} units={units} />

          <section className="grid gap-3 md:grid-cols-4">
            {[
              { icon: Route, label: 'Repeated routes', value: routes.length },
              { icon: Clock, label: 'Detected commutes', value: commutes.length },
              { icon: CalendarDays, label: 'Drive days', value: calendar.drive_days },
              { icon: Target, label: 'Goals met', value: `${goalStatus.filter((goal) => goal.met).length}/${goalStatus.length}` },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="rounded-2xl border border-border bg-card p-4">
                <Icon className="mb-2 h-5 w-5 text-primary" />
                <div className="font-grotesk text-2xl font-bold">{value}</div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </div>
            ))}
          </section>

          <Tabs defaultValue="overview" className="space-y-5">
            <div className="overflow-x-auto pb-1">
              <TabsList className="min-w-max rounded-full border border-border bg-card p-1">
                <TabsTrigger value="overview" className="rounded-full px-4">Overview</TabsTrigger>
                <TabsTrigger value="safety" className="rounded-full px-4">Safety</TabsTrigger>
                <TabsTrigger value="patterns" className="rounded-full px-4">Patterns</TabsTrigger>
                <TabsTrigger value="goals" className="rounded-full px-4">Goals</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="overview" className="mt-0 grid gap-5 lg:grid-cols-[1fr_0.85fr]">
          <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-primary">
                  <Award className="h-4 w-4" />
                  Milestones
                </div>
                <h2 className="mt-2 font-semibold">
                  {achievementSummary.next ? `Next up: ${achievementSummary.next.label}` : 'All milestones unlocked'}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Progress belongs here with your trends, goals, and route patterns.
                </p>
              </div>
              <button
                type="button"
                onClick={() => navigate('/achievements')}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-secondary"
              >
                View all
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_170px]">
              <div>
                {achievementSummary.next ? (
                  <>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-medium">{achievementSummary.next.description}</span>
                      <span className="font-semibold text-primary">
                        {achievementProgressLabel(achievementSummary.next)}
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${achievementProgressValue(achievementSummary.next)}%` }}
                      />
                    </div>
                    <div className="mt-2 text-[11px] font-semibold text-muted-foreground">
                      {achievementNextStepLabel(achievementSummary.next)}
                    </div>
                  </>
                ) : (
                  <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">
                    Every current milestone is complete. New progress targets can live here without crowding Dashboard.
                  </div>
                )}
              </div>
              <div className="rounded-2xl bg-secondary/50 p-4">
                <div className="font-grotesk text-2xl font-bold">
                  {achievementSummary.unlockedCount}/{achievementSummary.totalCount}
                </div>
                <div className="text-xs text-muted-foreground">
                  unlocked - {achievementSummary.completionPercent}% complete
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">Weekly Driver Summary</h2>
                <p className="mt-1 text-xs text-muted-foreground">Digest for trips since Sunday</p>
              </div>
              <Award className="h-5 w-5 text-primary" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <SummaryLine label="Distance" value={formatDistance(weekly.distance_km, units)} />
              <SummaryLine label="Best day" value={weekly.best_day} />
              <SummaryLine label="Main issue" value={weekly.main_issue} />
              <SummaryLine label="Biggest improvement" value={weekly.biggest_improvement} />
            </div>
          </section>
            </TabsContent>

            <TabsContent value="safety" className="mt-0">
          <section className="overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
            <div className="grid gap-0 lg:grid-cols-[1.05fr_0.95fr]">
              <div className="p-5">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">Phone Use Focus</h2>
                    <p className="mt-1 text-xs text-muted-foreground">Confirmed Android Usage Access evidence, separate from GPS proxy diagnostics</p>
                  </div>
                  <Smartphone className="h-5 w-5 text-red-500" />
                </div>

                <div className="grid gap-3 sm:grid-cols-4">
                  <div className={`rounded-2xl border p-4 ${phoneUseRiskTone(phoneUseSummary.worstRisk)}`}>
                    <div className="text-xs font-medium opacity-80">Worst risk</div>
                    <div className="mt-1 font-grotesk text-2xl font-bold capitalize">{phoneUseSummary.worstRisk}</div>
                  </div>
                  <SummaryLine label="Measured trips" value={`${phoneUseSummary.measuredTrips}/${phoneUseSummary.driverTrips}`} />
                  <SummaryLine label="Phone windows" value={phoneUseSummary.totalWindows} />
                  <SummaryLine label="Total phone time" value={formatPhoneDuration(phoneUseSummary.totalSeconds)} />
                </div>
                {phoneUseSummary.excludedPassengerTrips > 0 && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    {phoneUseSummary.excludedPassengerTrips} passenger trip{phoneUseSummary.excludedPassengerTrips === 1 ? '' : 's'} excluded from driver trends.
                  </div>
                )}

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <button
                    type="button"
                    disabled={!phoneUseSummary.latestPhoneUseTrip?.tripId}
                    onClick={() => phoneUseSummary.latestPhoneUseTrip?.tripId && navigate(`/trips/${phoneUseSummary.latestPhoneUseTrip.tripId}`)}
                    className="rounded-2xl bg-secondary/50 p-4 text-left transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <div className="text-xs text-muted-foreground">Latest confirmed use</div>
                    <div className="mt-1 text-lg font-semibold">
                      {phoneUseSummary.latestPhoneUseTrip
                        ? formatPhoneDuration(phoneUseSummary.latestPhoneUseTrip.totalSeconds)
                        : 'None recorded'}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {phoneUseSummary.latestPhoneUseTrip?.startTime
                        ? new Date(phoneUseSummary.latestPhoneUseTrip.startTime).toLocaleDateString()
                        : phoneUseSummary.unmeasuredTrips > 0
                          ? `${phoneUseSummary.unmeasuredTrips} trip${phoneUseSummary.unmeasuredTrips === 1 ? '' : 's'} missing Usage Access evidence`
                          : 'Measured trips have no confirmed phone use'}
                    </div>
                  </button>

                  <button
                    type="button"
                    disabled={!phoneUseSummary.longestPhoneUseTrip?.tripId}
                    onClick={() => phoneUseSummary.longestPhoneUseTrip?.tripId && navigate(`/trips/${phoneUseSummary.longestPhoneUseTrip.tripId}`)}
                    className="rounded-2xl bg-secondary/50 p-4 text-left transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <div className="text-xs text-muted-foreground">Longest confirmed use</div>
                    <div className="mt-1 text-lg font-semibold">
                      {phoneUseSummary.longestPhoneUseTrip
                        ? formatPhoneDuration(phoneUseSummary.longestPhoneUseTrip.totalSeconds)
                        : 'None recorded'}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {phoneUseSummary.longestPhoneUseTrip
                        ? `${phoneUseSummary.longestPhoneUseTrip.windowCount} window${phoneUseSummary.longestPhoneUseTrip.windowCount === 1 ? '' : 's'}, ${phoneUseSummary.longestPhoneUseTrip.avgSpeedKmh || '-'} avg km/h`
                        : 'No trip has confirmed phone-use windows'}
                    </div>
                  </button>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-2xl border border-border p-4">
                    <div className="text-xs text-muted-foreground">7-day phone-use rate</div>
                    <div className="mt-1 text-lg font-semibold">
                      {formatPhoneDuration(phoneUseSummary.currentPeriod.secondsPerMeasuredTrip)} per measured trip
                    </div>
                    <div className={`mt-1 text-xs font-medium ${
                      phoneUseSummary.trendDirection === 'improving'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : phoneUseSummary.trendDirection === 'worsening'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-muted-foreground'
                    }`}>
                      {phoneUseSummary.previousPeriod.measuredTrips === 0
                        ? 'Previous-period comparison unavailable'
                        : `${Math.abs(phoneUseSummary.trendPct)}% ${phoneUseSummary.trendDirection === 'improving' ? 'lower' : phoneUseSummary.trendDirection === 'worsening' ? 'higher' : 'change'} than the prior 7 days`}
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={!phoneUseSummary.worstMoment?.tripId}
                    onClick={() => phoneUseSummary.worstMoment?.tripId && navigate(`/trips/${phoneUseSummary.worstMoment.tripId}`)}
                    className="rounded-2xl border border-border p-4 text-left transition hover:bg-secondary/50 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <div className="text-xs text-muted-foreground">Highest-risk moment</div>
                    <div className="mt-1 text-lg font-semibold">
                      {phoneUseSummary.worstMoment
                        ? `${formatPhoneDuration(phoneUseSummary.worstMoment.durationSeconds)} at ${Math.round(phoneUseSummary.worstMoment.speedKmh || 0)} km/h`
                        : 'Detailed event unavailable'}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {phoneUseSummary.worstMoment?.activityLabel || 'Newly recorded trips retain a compact worst-moment summary'}
                    </div>
                  </button>

                  <div className="rounded-2xl border border-border p-4">
                    <div className="text-xs text-muted-foreground">Usage Access coverage</div>
                    <div className="mt-1 text-lg font-semibold">{phoneUseSummary.coveragePct}%</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {phoneUseSummary.unmeasuredTrips > 0
                        ? `${phoneUseSummary.unmeasuredTrips} driver trip${phoneUseSummary.unmeasuredTrips === 1 ? '' : 's'} could not be evaluated`
                        : 'All driver trips were measurable'}
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">Four-week trend</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">Phone-use seconds per measured trip</div>
                    </div>
                    <TrendingUp className="h-4 w-4 text-primary" />
                  </div>
                  <div className="mt-4 grid grid-cols-4 gap-2">
                    {phoneUseSummary.weeklyTrend.map((week) => {
                      const maxRate = Math.max(1, ...phoneUseSummary.weeklyTrend.map((item) => item.secondsPerMeasuredTrip));
                      const heightPct = week.secondsPerMeasuredTrip > 0
                        ? Math.max(6, Math.round((week.secondsPerMeasuredTrip / maxRate) * 100))
                        : 0;
                      return (
                        <div key={week.label} className="text-center">
                          <div className="flex h-20 items-end justify-center rounded-lg bg-secondary/40 px-2">
                            <div
                              className="w-full rounded-t bg-red-500"
                              style={{ height: `${heightPct}%` }}
                              title={`${formatPhoneDuration(week.secondsPerMeasuredTrip)} per measured trip`}
                            />
                          </div>
                          <div className="mt-1 text-[11px] font-medium">{week.label}</div>
                          <div className="text-[10px] text-muted-foreground">{formatPhoneDuration(week.secondsPerMeasuredTrip)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-border p-4">
                  <div className="text-sm font-semibold">Recorded activity mix</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {phoneUseSummary.activityBreakdown.length > 0 ? phoneUseSummary.activityBreakdown.map((activity) => (
                      <div key={activity.key} className="rounded-xl bg-secondary/50 px-3 py-2">
                        <div className="text-sm font-medium">{activity.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {activity.windows} window{activity.windows === 1 ? '' : 's'} · {formatPhoneDuration(activity.seconds)}
                        </div>
                      </div>
                    )) : (
                      <div className="text-xs text-muted-foreground sm:col-span-2">
                        Activity categories require retained detailed events or the compact summary saved with newly recorded trips.
                      </div>
                    )}
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Unlock-only checks are shown separately only when Android explicitly identifies them; Usage Access alone cannot reliably infer every unlock.
                  </div>
                </div>
              </div>

              <div className="border-t border-border bg-secondary/25 lg:border-l lg:border-t-0">
                <img
                  src={phoneUseRiskImage}
                  alt="Driver reaching toward a phone while brake lights and a pedestrian crossing sign are visible ahead"
                  className="h-56 w-full object-cover lg:h-full"
                />
              </div>
            </div>

            <div className="border-t border-border p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">What can go wrong</h3>
                  <p className="mt-1 text-xs text-muted-foreground">NHTSA describes phone use as visual, manual, and cognitive distraction.</p>
                </div>
                <a
                  href="https://www.nhtsa.gov/campaign/distracted-driving"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
                >
                  NHTSA 2024 data
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>

              <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
                <div className="grid gap-2 sm:grid-cols-2">
                  {phoneUseHazards.map((hazard) => (
                    <div key={hazard} className="rounded-2xl bg-secondary/50 p-3 text-sm font-medium">
                      {hazard}
                    </div>
                  ))}
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {nhtsaDistractedDrivingFacts.map((fact) => (
                    <div key={fact.label} className="rounded-2xl border border-border bg-background/70 p-3">
                      <div className="font-grotesk text-2xl font-bold text-red-500">{fact.value}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{fact.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
            </TabsContent>

            <TabsContent value="patterns" className="mt-0 grid gap-5">
          <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-semibold">Trip Calendar</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {calendar.total_distance_km.toFixed(1)} km this month, best streak {calendar.best_streak_days} day{calendar.best_streak_days === 1 ? '' : 's'}
                </p>
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => setMonthOffset((value) => value - 1)} className="rounded-lg border border-border px-2 py-1 text-xs">Prev</button>
                <button onClick={() => setMonthOffset(0)} className="rounded-lg border border-border px-2 py-1 text-xs">Today</button>
                <button onClick={() => setMonthOffset((value) => value + 1)} className="rounded-lg border border-border px-2 py-1 text-xs">Next</button>
              </div>
            </div>
            <div className="mb-2 text-center text-sm font-semibold">{calendar.label}</div>
            <div className="grid grid-cols-7 gap-1 text-center text-xs">
              {dayInitials.map((day, index) => <div key={`${day}-${index}`} className="py-1 font-semibold text-muted-foreground">{day}</div>)}
              {calendar.days.map((day) => {
                const score = day.avg_score || 0;
                const scoreColor = score >= 85 ? 'bg-emerald-500' : score >= 70 ? 'bg-blue-500' : score >= 55 ? 'bg-yellow-500' : 'bg-red-500';
                return (
                  <div
                    key={day.key}
                    title={day.trip_count ? `${day.trip_count} trips, ${day.distance_km} km, avg score ${formatEstimatedScore(day.avg_score)}` : 'No trips'}
                    className={`min-h-16 rounded-xl border p-1.5 text-left ${day.inMonth ? 'border-border bg-secondary/40' : 'border-transparent bg-transparent opacity-40'}`}
                  >
                    <div className="text-[11px] font-semibold">{day.date.getDate()}</div>
                    {day.trip_count > 0 && (
                      <div className="mt-1 space-y-1">
                        <div className={`h-1.5 rounded-full ${scoreColor}`} />
                        <div className="text-[10px] text-muted-foreground">{day.trip_count} trip{day.trip_count === 1 ? '' : 's'}</div>
                        <div className="text-[10px] font-semibold">{day.distance_km} km</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {(calendar.best_day || calendar.worst_day) && (
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                {calendar.best_day && <div className="rounded-xl bg-emerald-50 p-3 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">Best day: {calendar.best_day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} ({formatEstimatedScore(calendar.best_day.avg_score)})</div>}
                {calendar.worst_day && <div className="rounded-xl bg-red-50 p-3 text-red-700 dark:bg-red-950/30 dark:text-red-300">Worst day: {calendar.worst_day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} ({formatEstimatedScore(calendar.worst_day.avg_score)})</div>}
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="font-semibold">Commute Detection</h2>
                <p className="mt-1 text-xs text-muted-foreground">Repeated home/work-style routes inferred from timing and route shape, without addresses</p>
              </div>
              <Clock className="h-5 w-5 text-primary" />
            </div>
            {commutes.length === 0 ? (
              <div className="rounded-2xl bg-secondary/50 p-4 text-sm text-muted-foreground">
                Repeat a weekday morning or evening route twice to detect a commute pattern.
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {commutes.slice(0, 4).map((commute) => {
                  const { color } = getScoreColor(commute.avg_score);
                  return (
                    <button
                      key={commute.id}
                      onClick={() => commute.last_trip_id && navigate(`/trips/${commute.last_trip_id}`)}
                      className="rounded-2xl bg-secondary/50 p-4 text-left hover:bg-secondary"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold">{commute.label}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{commute.explanation}</div>
                          <div className="mt-2 text-xs">
                            {commute.trip_count} trips, {formatDistance(commute.avg_distance_km, units)} average, safest near {commute.usual_time}
                          </div>
                        </div>
                        <div className={`font-grotesk text-2xl font-bold ${color}`}>{formatEstimatedScore(commute.avg_score)}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="font-semibold">Route Comparison</h2>
                <p className="mt-1 text-xs text-muted-foreground">Repeated routes grouped by similar start and end areas</p>
              </div>
              <MapPinned className="h-5 w-5 text-primary" />
            </div>
            {routes.length === 0 ? (
              <div className="rounded-2xl bg-secondary/50 p-4 text-sm text-muted-foreground">
                Drive the same route twice to unlock route comparison.
              </div>
            ) : (
              <div className="space-y-3">
                {routes.slice(0, 6).map((route) => {
                  const { color } = getScoreColor(route.avg_score);
                  return (
                    <button
                      key={route.route_key}
                      onClick={() => route.last_trip_id && navigate(`/trips/${route.last_trip_id}`)}
                      className="w-full rounded-2xl border border-border bg-secondary/30 p-4 text-left hover:border-primary/40"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold">{route.label}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {route.trip_count} trips, avg {formatDistance(route.avg_distance_km, units)}, {route.avg_duration_minutes} min
                          </div>
                          <div className="mt-2 text-sm">
                            This route is usually safest at <span className="font-semibold">{route.safest_time}</span>
                            {route.safest_time_score != null ? ` (${formatEstimatedScore(route.safest_time_score)})` : ''}.
                          </div>
                        </div>
                        <div className="text-right">
                          <div className={`font-grotesk text-3xl font-bold ${color}`}>{formatEstimatedScore(route.avg_score)}</div>
                          <div className="text-xs text-muted-foreground">average score</div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
            </TabsContent>

            <TabsContent value="goals" className="mt-0">
          <section className="grid gap-5 md:grid-cols-2">
            <div className="rounded-3xl border border-border bg-card p-5 shadow-sm">
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <h2 className="font-semibold">Custom Goals</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Editable in Settings</p>
                </div>
                <Flag className="h-5 w-5 text-primary" />
              </div>
              <div className="space-y-3">
                {goalStatus.map((goal) => (
                  <div key={goal.id} className="rounded-2xl bg-secondary/50 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium">{goal.label}</span>
                      <span className={goal.met ? 'text-emerald-500' : 'text-orange-500'}>{goal.display}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {goal.met ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <ShieldAlert className="h-3.5 w-3.5 text-orange-500" />}
                      {goal.met ? 'On track' : 'Needs attention'}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-border bg-card p-5 shadow-sm">
              <div className="mb-4">
                <h2 className="font-semibold">Road Type Breakdown</h2>
                <p className="mt-1 text-xs text-muted-foreground">Score by city, highway, residential, rural, and parking-style segments</p>
              </div>
              {roadTypes.length === 0 ? (
                <div className="rounded-2xl bg-secondary/50 p-4 text-sm text-muted-foreground">No scored road types yet.</div>
              ) : (
                <div className="space-y-3">
                  {roadTypes.map((road) => {
                    const { color } = getScoreColor(road.avg_score);
                    return (
                      <div key={road.id} className="rounded-2xl bg-secondary/50 p-3">
                        <div className="mb-1 flex items-center justify-between text-sm">
                          <span className="font-semibold">{road.label}</span>
                          <span className={`font-bold ${color}`}>{formatEstimatedScore(road.avg_score)}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {road.trip_count} trip{road.trip_count === 1 ? '' : 's'}, {formatDistance(road.distance_km, units)}, {road.risk_events} risk events
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function SummaryLine({ label, value }) {
  return (
    <div className="rounded-2xl bg-secondary/50 p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold capitalize">{value}</div>
    </div>
  );
}

function InsightBriefPanel({ insightBrief, navigate, units }) {
  const primaryAction = insightBrief.actions[0] || null;
  const supportingActions = insightBrief.actions.slice(1);

  return (
    <section className="overflow-hidden rounded-3xl border border-primary/20 bg-card shadow-sm">
      <div className="border-b border-border bg-primary/5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-primary">
              <ListChecks className="h-4 w-4" />
              Insight Brief
            </div>
            <h2 className="mt-2 text-2xl font-grotesk font-bold tracking-normal md:text-3xl">{insightBrief.headline}</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {insightBrief.evidence.map((item) => (
                <span key={item} className="rounded-full border border-border bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                  {item}
                </span>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-right sm:min-w-60">
            <div className="rounded-2xl border border-border bg-background/80 px-4 py-3">
              <div className="text-xs text-muted-foreground">Confidence</div>
              <div className="mt-1 font-semibold capitalize">{insightBrief.confidence}</div>
            </div>
            <div className="rounded-2xl border border-border bg-background/80 px-4 py-3">
              <div className="text-xs text-muted-foreground">Avg score</div>
              <div className="mt-1 font-grotesk text-2xl font-bold">{formatEstimatedScore(insightBrief.average_score)}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-4 p-5">
          <div className="grid gap-3 md:grid-cols-3">
            <BriefMetric
              icon={TrendingUp}
              label="Recent trend"
              value={insightBrief.score_trend.label}
              detail={`${insightBrief.current_period.trip_count} recent vs ${insightBrief.previous_period.trip_count} prior trip${insightBrief.previous_period.trip_count === 1 ? '' : 's'}`}
              tone={insightBrief.score_trend.direction === 'up' ? 'good' : insightBrief.score_trend.direction === 'down' ? 'warn' : 'neutral'}
            />
            <BriefMetric
              icon={AlertTriangle}
              label="Event density"
              value={insightBrief.risk_event_rate.per100km == null ? 'No distance' : `${insightBrief.risk_event_rate.per100km}/100 km`}
              detail={`${insightBrief.risk_event_rate.total_events} scored risk event${insightBrief.risk_event_rate.total_events === 1 ? '' : 's'}`}
              tone={insightBrief.risk_event_rate.total_events > 0 ? 'warn' : 'good'}
            />
            <BriefMetric
              icon={Target}
              label="Top risk"
              value={insightBrief.top_risk?.label || 'None flagged'}
              detail={insightBrief.top_risk ? `${insightBrief.top_risk.count} events total` : 'Keep collecting clean trips'}
              tone={insightBrief.top_risk ? 'warn' : 'good'}
            />
          </div>

          {primaryAction && (
            <button
              type="button"
              disabled={!primaryAction.tripId}
              onClick={() => primaryAction.tripId && navigate(`/trips/${primaryAction.tripId}`)}
              className="w-full rounded-2xl border border-primary/30 bg-primary/5 p-4 text-left transition hover:border-primary/60 disabled:cursor-default disabled:hover:border-primary/30"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold uppercase tracking-wide text-primary">Next best action</div>
                  <div className="mt-1 text-lg font-semibold">{primaryAction.title}</div>
                  <div className="mt-1 text-sm text-muted-foreground">{primaryAction.detail}</div>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${priorityTone(primaryAction.priority)}`}>
                  {primaryAction.priority}
                </span>
              </div>
              <div className="mt-3 inline-flex rounded-full bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {primaryAction.metric}
              </div>
            </button>
          )}

          {supportingActions.length > 0 && (
            <div className="grid gap-2 md:grid-cols-3">
              {supportingActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  disabled={!action.tripId}
                  onClick={() => action.tripId && navigate(`/trips/${action.tripId}`)}
                  className="rounded-2xl border border-border bg-secondary/30 p-3 text-left transition hover:border-primary/40 disabled:cursor-default disabled:hover:border-border"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold">{action.title}</div>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold capitalize ${priorityTone(action.priority)}`}>
                      {action.priority}
                    </span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{action.metric}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-2 border-t border-border bg-secondary/20 p-5 lg:border-l lg:border-t-0">
          <ContextSnapshot
            label="Strongest context"
            value={insightBrief.strongest_context?.label || 'More trips needed'}
            detail={insightBrief.strongest_context
              ? `${formatEstimatedScore(insightBrief.strongest_context.avg_score)} avg, ${formatDistance(insightBrief.strongest_context.distance_km, units)}`
              : 'Drive a few more scored trips to compare road types.'}
            tone="good"
          />
          <ContextSnapshot
            label="Needs review"
            value={insightBrief.weakest_context?.label || 'No weak context yet'}
            detail={insightBrief.weakest_context
              ? `${formatEstimatedScore(insightBrief.weakest_context.avg_score)} avg, ${insightBrief.weakest_context.risk_events} events`
              : 'No repeated context is standing out as weaker.'}
            tone={insightBrief.weakest_context ? 'warn' : 'good'}
          />
          <ContextSnapshot
            label="Route opportunity"
            value={insightBrief.route_opportunity?.label || 'No route drift'}
            detail={insightBrief.route_opportunity
              ? `${insightBrief.route_opportunity.trend} trend, strongest near ${insightBrief.route_opportunity.safest_time}`
              : 'Repeated routes look stable so far.'}
            tone={insightBrief.route_opportunity ? 'warn' : 'good'}
          />
        </div>
      </div>
    </section>
  );
}

const metricTone = (tone = 'neutral') => ({
  good: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300',
  warn: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800/50 dark:bg-orange-950/30 dark:text-orange-300',
  neutral: 'border-border bg-secondary/40 text-foreground',
}[tone] || 'border-border bg-secondary/40 text-foreground');

const priorityTone = (priority = 'low') => ({
  high: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  medium: 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
  low: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
}[priority] || 'bg-secondary text-muted-foreground');

function BriefMetric({ icon: Icon, label, value, detail, tone = 'neutral' }) {
  return (
    <div className={`rounded-2xl border p-4 ${metricTone(tone)}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium opacity-80">{label}</div>
        <Icon className="h-4 w-4 opacity-80" />
      </div>
      <div className="mt-2 font-grotesk text-2xl font-bold">{value}</div>
      <div className="mt-1 text-xs opacity-80">{detail}</div>
    </div>
  );
}

function ContextSnapshot({ label, value, detail, tone = 'neutral' }) {
  return (
    <div className={`rounded-2xl border p-4 ${metricTone(tone)}`}>
      <div className="text-xs font-medium opacity-80">{label}</div>
      <div className="mt-1 font-semibold">{value}</div>
      <div className="mt-1 text-xs opacity-80">{detail}</div>
    </div>
  );
}
