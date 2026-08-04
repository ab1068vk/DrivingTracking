// @ts-check
// The Dashboard summary panels, moved out of src/pages/Dashboard.jsx unchanged.
// Every block here renders a standard and a premium variant; both are asserted
// on exactly (Tailwind classes and premium asset filenames included) by
// src/pages/__tests__/corePages.render.test.jsx, which is the output-equivalence
// oracle for this file. Do not loosen those assertions to make an edit pass.
import { AlertTriangle, CalendarDays, Car, Clock, CornerUpRight, Flame, Gauge, Navigation, RefreshCw, Route, Target, TrafficCone, TrendingDown, Zap } from 'lucide-react';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import DeferredRecharts from '@/components/DeferredRecharts';
import PremiumDrivingExposureCard from '@/components/PremiumDrivingExposureCard';
import PremiumDrivingScoreCard from '@/components/PremiumDrivingScoreCard';
import PremiumEventSummary from '@/components/PremiumEventSummary';
import PremiumScoreTipsCard from '@/components/PremiumScoreTipsCard';
import PremiumTotalsCard, { PremiumBaselineCard } from '@/components/PremiumTotalsCard';
import { PremiumWeeklyGoalsCard, PremiumWeeklyInsightCards } from '@/components/PremiumWeeklyDriverGoals';
import ScoreRing from '@/components/ScoreRing';
import TripCard from '@/components/TripCard';
import { getPremiumTripScoreDelta } from '@/lib/premiumTripPresentation';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import { hasProvisionalCalibration } from '@/lib/scoringConstants';
import { formatDistance, formatDuration } from '@/lib/tripEngine';
import { convertPerDistanceRate, distanceUnitLabel } from '@/lib/unitFormatting';

const OVERALL_SCORE_IS_APPROXIMATE = hasProvisionalCalibration(['score_overall']);

/**
 * The Dashboard summary panels: totals, driver goals, streak and fatigue,
 * score and trend, coaching tips, quick event stats, and recent trips.
 * Props-threaded out of the page body; owns no state and runs no hooks.
 */
export default function DashboardSummaryPanels({
  activityPeriod,
  analyticsCompletedTrips,
  avgScore,
  avgScoreEvidence,
  baseline,
  baselineRangeLabel,
  baselineText,
  completedTrips,
  dailyFatigue,
  dashboardActivity,
  fatigueRisk,
  isAllTimeActivity,
  noHarshBrakeStreak,
  peakStress,
  recentTripError,
  recentTripsError,
  recentTripsLoaded,
  refetch,
  scoreTrend,
  setActivityPeriod,
  settings,
  tips,
  units,
  weeklyGoals,
}) {
  return (
    <>
      {/* Stats Grid */}
      {settings.premium_visual_experience === true ? (
        <PremiumTotalsCard trips={analyticsCompletedTrips} units={units} />
      ) : (
      <section className="rounded-3xl border border-border bg-card p-4 shadow-sm" aria-labelledby="dashboard-activity-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="dashboard-activity-heading" className="font-semibold">
              {isAllTimeActivity ? 'All-time totals' : 'Your last 7 days'}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isAllTimeActivity ? 'Everything recorded on this device' : 'Recent driving activity'}
            </p>
          </div>
          <div className="flex rounded-xl bg-secondary p-1" role="group" aria-label="Dashboard totals period">
            {[
              { id: 'all_time', label: 'All time' },
              { id: 'seven_days', label: '7 days' },
            ].map((period) => (
              <button
                key={period.id}
                type="button"
                onClick={() => setActivityPeriod(period.id)}
                aria-pressed={activityPeriod === period.id}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${activityPeriod === period.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {period.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: 'Distance', value: formatDistance(dashboardActivity.distanceKm, units), detail: 'completed trips', icon: Navigation },
            { label: 'Time driving', value: formatDuration(Math.round(dashboardActivity.drivingSeconds)), detail: 'recorded time', icon: Clock },
            { label: 'Trips', value: dashboardActivity.tripCount, detail: isAllTimeActivity ? 'all time' : 'last 7 days', icon: Car },
            {
              label: 'Active days',
              value: isAllTimeActivity ? dashboardActivity.activeDays : `${dashboardActivity.activeDays}/7`,
              detail: dashboardActivity.activeDays ? `${dashboardActivity.tripsPerActiveDay.toFixed(1)} trips / active day` : 'no driving days',
              icon: CalendarDays,
            },
            { label: 'Average trip', value: formatDistance(dashboardActivity.averageTripKm, units), detail: 'typical distance', icon: Route },
            { label: 'Longest trip', value: formatDistance(dashboardActivity.longestTripKm, units), detail: isAllTimeActivity ? 'all time' : 'last 7 days', icon: Gauge },
          ].map(({ label, value, detail, icon: Icon }) => (
            <div key={label} className="min-w-0 rounded-2xl bg-secondary/45 p-3">
              <Icon className="mb-2 h-4 w-4 text-primary" />
              <div className="truncate font-grotesk text-xl font-bold">{value}</div>
              <div className="mt-0.5 text-xs font-semibold">{label}</div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</div>
            </div>
          ))}
        </div>
      </section>
      )}

      {completedTrips.length > 0 && (
        settings.premium_visual_experience === true ? (
          <PremiumBaselineCard
            baseline={baseline}
            baselineRangeLabel={baselineRangeLabel}
            baselineText={baselineText}
            peakStress={peakStress}
          />
        ) : (
        <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="font-semibold text-base">Personal Baseline</h2>
              <p className="text-xs text-muted-foreground mt-1">
                {baselineText}
              </p>
            </div>
            <div className={`text-sm font-bold capitalize ${
              baseline.trend === 'improving' ? 'text-emerald-500' : baseline.trend === 'declining' ? 'text-red-500' : 'text-muted-foreground'
            }`}>
              {baseline.trend}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
            <div className="bg-secondary/50 rounded-xl p-3">
              <div className="font-grotesk font-bold text-xl">{baseline.this_week_avg ?? '-'}</div>
              <div className="text-xs text-muted-foreground">this week</div>
            </div>
            <div className="bg-secondary/50 rounded-xl p-3">
              <div className="font-grotesk font-bold text-xl">{baseline.baseline_avg == null ? '-' : baselineRangeLabel ? `${baseline.baseline_avg} (${baselineRangeLabel})` : baseline.baseline_avg}</div>
              <div className="text-xs text-muted-foreground">approx baseline (recent trips)</div>
            </div>
            <div className="bg-secondary/50 rounded-xl p-3">
              <div className="font-grotesk font-bold text-xl">{baseline.percentile == null ? '-' : `${baseline.percentile}%`}</div>
              <div className="text-xs text-muted-foreground">percentile among your recorded weeks</div>
              {baseline.percentile == null && (
                <div className="mt-1 text-[11px] text-muted-foreground">Needs {baseline.percentile_min_weeks} scored weeks</div>
              )}
            </div>
            <div className="bg-secondary/50 rounded-xl p-3">
              <div className="flex items-center gap-2">
                <TrafficCone className={`w-4 h-4 ${
                  peakStress.insufficient_data ? 'text-muted-foreground' :
                    peakStress.peak_stress_label === 'consistent' ? 'text-emerald-500' :
                    peakStress.peak_stress_label === 'slightly stressed' ? 'text-yellow-500' :
                      peakStress.peak_stress_label === 'traffic-affected' ? 'text-orange-500' : 'text-red-500'
                }`} />
                <div className="font-grotesk font-bold text-sm capitalize">{peakStress.peak_stress_label}</div>
              </div>
              <div className="text-xs text-muted-foreground mt-1">rush hour behaviour</div>
            </div>
          </div>
        </div>
        )
      )}

      {/* Driver goals */}
      {completedTrips.length > 0 && (
        settings.premium_visual_experience === true ? (
          <PremiumWeeklyGoalsCard goals={weeklyGoals} units={units} />
        ) : (
        <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-base">Weekly Driver Goals</h2>
            <Target className="w-4 h-4 text-primary" />
          </div>
          {weeklyGoals.some((goal) => goal.status === 'building_evidence') && (
            <div className="mb-3 rounded-xl bg-primary/5 px-3 py-2 text-[11px] font-medium text-muted-foreground">
              Goals activate after {weeklyGoals[0]?.evidence?.minimum_trips || 3} trips and {formatDistance(weeklyGoals[0]?.evidence?.minimum_distance_km || 25, units)}. Until then, Road Sage is building evidence—not awarding easy completions.
            </div>
          )}
          <div className="space-y-2">
            {weeklyGoals.map((goal) => {
              const evidencePct = goal.evidence
                ? Math.min(
                    100,
                    (goal.evidence.trips / goal.evidence.minimum_trips) * 100,
                    (goal.evidence.distance_km / goal.evidence.minimum_distance_km) * 100
                  )
                : 0;
              const pct = !goal.qualified
                ? evidencePct
                : goal.met
                  ? 100
                  : goal.direction === 'under'
                    ? (goal.target > 0 ? Math.min(99, (goal.target / Math.max(goal.target, goal.value)) * 100) : 0)
                    : Math.min(99, goal.target > 0 ? (goal.value / goal.target) * 100 : 0);
              const statusClass = !goal.qualified
                ? 'text-primary font-semibold'
                : goal.met ? 'text-emerald-500 font-semibold' : 'text-orange-500 font-semibold';
              const barClass = !goal.qualified ? 'bg-primary' : goal.met ? 'bg-emerald-500' : 'bg-orange-500';
              return (
                <div key={goal.id}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium">{goal.label}</span>
                    <span className={statusClass}>
                      {!goal.qualified
                        ? `${goal.evidence.trips}/${goal.evidence.minimum_trips} trips · ${formatDistance(goal.evidence.distance_km, units)}/${formatDistance(goal.evidence.minimum_distance_km, units)}`
                        : goal.unit === 'km'
                          ? `${formatDistance(goal.value, units)}/${formatDistance(goal.target, units)}`
                          : String(goal.unit).includes('100 km')
                            ? `${convertPerDistanceRate(goal.value, units)?.toFixed(1)}/${convertPerDistanceRate(goal.target, units)?.toFixed(1)} per 100 ${distanceUnitLabel(units)}`
                            : `${goal.value}/${goal.target}${goal.unit ? ` ${goal.unit}` : goal.direction === 'over' ? '+' : ''}`
                      }
                    </span>
                  </div>
                  <div className="h-2 bg-secondary rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${barClass}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        )
      )}

      {/* Driver streak and fatigue */}
      {completedTrips.length > 0 && (
        settings.premium_visual_experience === true ? (
          <PremiumWeeklyInsightCards
            fatigueRisk={fatigueRisk}
            noHarshBrakeStreak={noHarshBrakeStreak}
          />
        ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-card border border-border rounded-2xl p-4">
            <Flame className="w-5 h-5 text-orange-500 mb-2" />
            <div className="font-grotesk font-bold text-2xl">{noHarshBrakeStreak}</div>
            <div className="text-xs text-muted-foreground">days without harsh braking</div>
          </div>
          <div className="bg-card border border-border rounded-2xl p-4">
            <AlertTriangle className={`w-5 h-5 mb-2 ${fatigueRisk.level === 'high' ? 'text-red-500' : fatigueRisk.level === 'medium' ? 'text-orange-500' : 'text-emerald-500'}`} />
            <div className="font-grotesk font-bold text-2xl capitalize">{fatigueRisk.level}</div>
            <div className="text-xs text-muted-foreground">estimated fatigue risk (driving-time proxy) - {fatigueRisk.long_trip_count} long drives this week</div>
          </div>
        </div>
        )
      )}

      {dailyFatigue.tripCount >= 1 && (
        settings.premium_visual_experience === true ? (
          <PremiumDrivingExposureCard dailyFatigue={dailyFatigue} />
        ) : (
        <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-base capitalize">Driving-time exposure estimate · {dailyFatigue.fatigueLevel}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {dailyFatigue.totalDrivingMinutes} min driven today across {dailyFatigue.tripCount} trips
              </p>
              {dailyFatigue.minutesSinceLastTrip != null && (
                <p className="mt-1 text-xs text-muted-foreground">Resting {dailyFatigue.minutesSinceLastTrip} min</p>
              )}
            </div>
            <div className="font-grotesk text-2xl font-bold">~{dailyFatigue.cumulativeFatigueScore}/10</div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, dailyFatigue.cumulativeFatigueScore * 10)}%`,
                background: dailyFatigue.fatigueLevel === 'critical'
                  ? '#ef4444'
                  : dailyFatigue.fatigueLevel === 'high'
                    ? '#f97316'
                    : dailyFatigue.fatigueLevel === 'moderate'
                      ? '#eab308'
                      : '#22c55e',
              }}
            />
          </div>
          {dailyFatigue.recommendedBreakMinutes > 0 && (
            <div className="mt-3 text-xs font-semibold text-orange-500">
              Consider a {dailyFatigue.recommendedBreakMinutes}-min break before your next trip
            </div>
          )}
        </div>
        )
      )}

      {/* Score & Trend */}
      {settings.premium_visual_experience === true ? (
        <PremiumDrivingScoreCard
          avgScore={avgScore}
          evidence={avgScoreEvidence}
          scoreTrend={scoreTrend}
          tripCount={completedTrips.length}
          isLoading={recentTripsLoaded === false}
          showApproximateTag={OVERALL_SCORE_IS_APPROXIMATE}
        />
      ) : (
      <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-base">Driving Score</h2>
              {OVERALL_SCORE_IS_APPROXIMATE && <CalibrationStatusTag />}
            </div>
            <p className="text-muted-foreground text-xs mt-0.5">Last {Math.min(10, completedTrips.length)} trips</p>
          </div>
          {completedTrips.length > 0 && (
            <ScoreRing score={avgScore} evidence={avgScoreEvidence} size={72} strokeWidth={6} sublabel="avg" />
          )}
        </div>

        {scoreTrend.length > 2 ? (
          <DeferredRecharts height={60}>
            {({ ResponsiveContainer, LineChart, Line, Tooltip }) => (
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
                    formatter={(v) => [formatEstimatedScore(v), 'Score']}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </DeferredRecharts>
        ) : (
          <div className="h-12 flex items-center justify-center text-muted-foreground text-xs">
            Complete more trips to see trend
          </div>
        )}
      </div>
      )}

      {/* Coaching tips */}
      {settings.premium_visual_experience === true ? (
        (completedTrips.length > 0 || recentTripsLoaded === false) && (
          <PremiumScoreTipsCard tips={tips} isLoading={recentTripsLoaded === false} />
        )
      ) : completedTrips.length > 0 && (
        <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
          <h2 className="font-semibold text-base mb-3">Score Tips</h2>
          <div className="space-y-2">
            {tips.map((tip) => (
              <div key={tip} className="text-sm text-muted-foreground bg-secondary/50 rounded-xl p-3">
                {tip}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick event stats */}
      {completedTrips.length > 0 && (() => {
        if (settings.premium_visual_experience === true) {
          return <PremiumEventSummary trips={completedTrips} />;
        }
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

        {recentTripsError ? (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100" role="alert">
            <div className="font-semibold">Saved trips could not be opened</div>
            <div className="mt-1 text-sm">{recentTripError?.message || 'Your saved trips were not deleted. Retry the local storage read.'}</div>
            <button type="button" onClick={() => refetch()} className="mt-3 rounded-xl bg-amber-900 px-3 py-2 text-sm font-semibold text-white dark:bg-amber-200 dark:text-amber-950">Retry safely</button>
          </div>
        ) : completedTrips.length === 0 ? (
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
              <TripCard
                key={trip.id}
                trip={trip}
                units={units}
                index={i}
                premium={settings.premium_visual_experience === true}
                scoreDelta={settings.premium_visual_experience === true
                  ? getPremiumTripScoreDelta(trip, completedTrips)
                  : null}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
