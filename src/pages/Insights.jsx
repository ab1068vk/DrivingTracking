import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Award, CalendarDays, CheckCircle2, Clock, Flag, MapPinned, Route, ShieldAlert, Target, TrendingUp } from 'lucide-react';
import { tripService } from '@/api/trips';
import { localSettings } from '@/lib/trackingStore';
import { formatDistance, getScoreColor } from '@/lib/tripEngine';
import {
  buildCommuteDetections,
  buildGoalStatus,
  buildRoadTypeBreakdown,
  buildRouteComparisons,
  buildTripCalendarMonth,
  buildWeeklyDriverSummary,
} from '@/lib/mediumInsights';

const dayInitials = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export default function Insights() {
  const navigate = useNavigate();
  const settings = localSettings.get();
  const units = settings.units || 'metric';
  const [monthOffset, setMonthOffset] = useState(0);
  const monthDate = useMemo(() => {
    const date = new Date();
    date.setMonth(date.getMonth() + monthOffset);
    return date;
  }, [monthOffset]);

  const { data: trips = [], isLoading } = useQuery({
    queryKey: ['insight-trips'],
    queryFn: () => tripService.listAll({ sort: '-start_time' }),
  });

  const completed = trips.filter((trip) => trip.status === 'completed');
  const routes = buildRouteComparisons(completed);
  const commutes = buildCommuteDetections(completed);
  const calendar = buildTripCalendarMonth(completed, monthDate);
  const weekly = buildWeeklyDriverSummary(completed, settings);
  const roadTypes = buildRoadTypeBreakdown(completed);
  const goalStatus = buildGoalStatus(
    completed.filter((trip) => new Date(trip.start_time).getTime() >= (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - d.getDay());
      return d.getTime();
    })()),
    settings
  );

  return (
    <div className="space-y-6 pb-6">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-grotesk font-bold">Driving Insights</h1>
        <p className="mt-1 text-sm text-muted-foreground">Routes, calendar patterns, weekly summary, and custom goals</p>
      </motion.div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((item) => <div key={item} className="h-32 rounded-2xl bg-secondary/50 animate-pulse" />)}
        </div>
      ) : completed.length === 0 ? (
        <div className="flex flex-col items-center rounded-3xl border border-dashed border-border bg-card px-4 py-12 text-center">
          <TrendingUp className="mb-3 h-12 w-12 text-muted-foreground" />
          <div className="font-semibold">No insights yet</div>
          <div className="mt-1 max-w-xs text-sm text-muted-foreground">
            Complete a few trips to compare repeated routes, build a monthly calendar, and summarize weekly driving.
          </div>
          <div className="mt-6 grid w-full max-w-lg grid-cols-2 gap-2 text-left text-xs md:grid-cols-3">
            {['Weekly Driver Summary', 'Trip Calendar', 'Route Comparison', 'Commute Detection', 'Custom Goals', 'Road Type Breakdown'].map((label) => (
              <div key={label} className="rounded-xl bg-secondary/50 px-3 py-2 font-medium text-muted-foreground">
                {label}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
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
                    title={day.trip_count ? `${day.trip_count} trips, ${day.distance_km} km, avg score ${day.avg_score}` : 'No trips'}
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
                {calendar.best_day && <div className="rounded-xl bg-emerald-50 p-3 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">Best day: {calendar.best_day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} ({calendar.best_day.avg_score})</div>}
                {calendar.worst_day && <div className="rounded-xl bg-red-50 p-3 text-red-700 dark:bg-red-950/30 dark:text-red-300">Worst day: {calendar.worst_day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} ({calendar.worst_day.avg_score})</div>}
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
                        <div className={`font-grotesk text-2xl font-bold ${color}`}>{commute.avg_score}</div>
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
                            {route.safest_time_score != null ? ` (${route.safest_time_score})` : ''}.
                          </div>
                        </div>
                        <div className="text-right">
                          <div className={`font-grotesk text-3xl font-bold ${color}`}>{route.avg_score}</div>
                          <div className="text-xs text-muted-foreground">average score</div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

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
                          <span className={`font-bold ${color}`}>{road.avg_score}</span>
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
