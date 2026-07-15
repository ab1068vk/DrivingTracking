import { useMemo, useState } from 'react';
import { CalendarDays, CheckCircle2, Clock3, Flag, MapPinned, Route, ShieldAlert, Smartphone } from 'lucide-react';
import { isDriverMetricEligible, summarizePhoneUseAcrossTrips } from '@/lib/phoneUseSummary';
import { buildCommuteDetections, buildGoalStatus, buildRoadTypeBreakdown, buildRouteComparisons, buildTripCalendarMonth } from '@/lib/mediumInsights';
import { formatDistance, getScoreColor } from '@/lib/tripEngine';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import { MiniMetric, Notice, PanelHeader } from '@/components/insights/InsightPrimitives';

const dayInitials = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const formatDuration = (seconds = 0) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${total % 60 ? ` ${total % 60}s` : ''}`;
};
const weekTripsFor = (trips) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return trips.filter((trip) => new Date(trip.start_time).getTime() >= start.getTime());
};

export function InsightHistoryPanels({ trips = [], settings = {}, units = 'metric', onOpenTrip }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const monthDate = useMemo(() => {
    const date = new Date();
    date.setMonth(date.getMonth() + monthOffset);
    return date;
  }, [monthOffset]);
  const drivers = useMemo(() => trips.filter(isDriverMetricEligible), [trips]);
  const routes = useMemo(() => buildRouteComparisons(drivers), [drivers]);
  const commutes = useMemo(() => buildCommuteDetections(drivers), [drivers]);
  const calendar = useMemo(() => buildTripCalendarMonth(drivers, monthDate), [drivers, monthDate]);
  const roads = useMemo(() => buildRoadTypeBreakdown(drivers), [drivers]);
  const goals = useMemo(() => buildGoalStatus(weekTripsFor(drivers), settings), [drivers, settings]);
  const phone = useMemo(() => summarizePhoneUseAcrossTrips(trips), [trips]);
  return <div className='space-y-5'>
    <HistorySummary calendar={calendar} routes={routes} commutes={commutes} goals={goals} />
    <CalendarPanel calendar={calendar} units={units} setMonthOffset={setMonthOffset} />
    <RoutePanels routes={routes} commutes={commutes} units={units} onOpenTrip={onOpenTrip} />
    <SafetyAndGoals phone={phone} goals={goals} roads={roads} units={units} onOpenTrip={onOpenTrip} />
  </div>;
}

function HistorySummary({ calendar, routes, commutes, goals }) {
  return <section className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
    <MiniMetric label='Drive days this month' value={calendar.drive_days} />
    <MiniMetric label='Repeated routes' value={routes.length} />
    <MiniMetric label='Detected commutes' value={commutes.length} />
    <MiniMetric label='Weekly goals met' value={`${goals.filter((goal) => goal.met).length}/${goals.length}`} />
  </section>;
}

function CalendarPanel({ calendar, units, setMonthOffset }) {
  return <section className='rounded-3xl border border-border bg-card p-5 shadow-sm'>
    <PanelHeader eyebrow='History' title='Trip calendar' description='Drive days, distance, and scores. Privacy-touched days remain excluded.' icon={CalendarDays} action={
      <div className='flex gap-1' aria-label='Calendar month controls'>
        <MonthButton onClick={() => setMonthOffset((value) => value - 1)}>Previous</MonthButton>
        <MonthButton onClick={() => setMonthOffset(0)}>Today</MonthButton>
        <MonthButton onClick={() => setMonthOffset((value) => value + 1)}>Next</MonthButton>
      </div>
    } />
    <div className='mt-5 flex justify-between gap-2 text-sm'><strong>{calendar.label}</strong><span className='text-muted-foreground'>{calendar.drive_days} days / {formatDistance(calendar.total_distance_km, units)}</span></div>
    <div className='mt-3 grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-muted-foreground'>{dayInitials.map((day, index) => <div key={`${day}-${index}`}>{day}</div>)}</div>
    <div className='mt-1 grid grid-cols-7 gap-1'>{calendar.days.map((day) => <CalendarDay key={day.key} day={day} />)}</div>
  </section>;
}

function MonthButton({ onClick, children }) {
  return <button type='button' onClick={onClick} className='rounded-full border border-border px-3 py-1.5 text-xs font-semibold hover:bg-secondary'>{children}</button>;
}

function CalendarDay({ day }) {
  const tone = getScoreColor(day.avg_score);
  const title = day.trip_count ? `${day.trip_count} trips, ${day.distance_km} km, average score ${formatEstimatedScore(day.avg_score)}` : 'No trips';
  return <div title={title} className={`min-h-16 rounded-xl border border-border p-2 ${day.inMonth ? 'bg-background' : 'bg-secondary/20 opacity-40'}`}>
    <div className='text-[11px] font-semibold'>{day.date.getDate()}</div>
    {day.trip_count > 0 && <div className='mt-1'><div className={`h-1.5 rounded-full ${tone.bg}`} /><div className='mt-1 text-[10px] text-muted-foreground'>{day.trip_count} trip{day.trip_count === 1 ? '' : 's'}</div><div className='text-[10px] font-semibold'>{formatEstimatedScore(day.avg_score)}</div></div>}
  </div>;
}

function RoutePanels({ routes, commutes, units, onOpenTrip }) {
  return <section className='grid gap-5 xl:grid-cols-2'>
    <HistoryList icon={Clock3} eyebrow='Routine' title='Commute detection' description='Repeated routes inferred from timing and route shape, without addresses.' rows={commutes.slice(0, 4)} empty='Repeat a weekday morning or evening route twice to detect a commute pattern.' units={units} onOpenTrip={onOpenTrip} />
    <HistoryList icon={Route} eyebrow='Routes' title='Repeated route comparison' description='Repeated routes grouped by similar start and end areas.' rows={routes.slice(0, 6)} empty='Drive the same route twice to unlock route comparison.' units={units} onOpenTrip={onOpenTrip} />
  </section>;
}

function HistoryList({ icon, eyebrow, title, description, rows, empty, units, onOpenTrip }) {
  return <section className='rounded-3xl border border-border bg-card p-5 shadow-sm'>
    <PanelHeader eyebrow={eyebrow} title={title} description={description} icon={icon} />
    {rows.length === 0 ? <Notice text={empty} /> : <div className='mt-5 space-y-2'>{rows.map((row) => <button
      key={row.id || row.route_key}
      type='button'
      disabled={!row.last_trip_id}
      onClick={() => row.last_trip_id && onOpenTrip(row.last_trip_id)}
      className='flex w-full items-center justify-between gap-3 rounded-2xl border border-border p-3 text-left hover:border-primary/40 disabled:cursor-default'
    >
      <div className='min-w-0'><div className='truncate text-sm font-semibold'>{row.label}</div><div className='text-xs text-muted-foreground'>{row.trip_count} trips / {formatDistance(row.avg_distance_km, units)} / safest near {row.safest_time || row.usual_time}</div></div>
      <div className={`font-grotesk text-2xl font-bold ${getScoreColor(row.avg_score).color}`}>{formatEstimatedScore(row.avg_score)}</div>
    </button>)}</div>}
  </section>;
}

function SafetyAndGoals({ phone, goals, roads, units, onOpenTrip }) {
  return <section className='grid gap-5 xl:grid-cols-[1.05fr_0.95fr]'>
    <PhoneUsePanel phone={phone} onOpenTrip={onOpenTrip} />
    <HistoryTargets goals={goals} roads={roads} units={units} />
  </section>;
}

function PhoneUsePanel({ phone, onOpenTrip }) {
  return <section className='rounded-3xl border border-border bg-card p-5 shadow-sm'>
    <PanelHeader eyebrow='Safety' title='Phone use focus' description='Confirmed Usage Access evidence, separate from GPS proxy diagnostics.' icon={Smartphone} />
    <div className='mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4'>
      <MiniMetric label='Worst risk' value={phone.worstRisk || 'none'} />
      <MiniMetric label='Measured trips' value={`${phone.measuredTrips || 0}/${phone.driverTrips || 0}`} />
      <MiniMetric label='Phone windows' value={phone.totalWindows || 0} />
      <MiniMetric label='Total phone time' value={formatDuration(phone.totalSeconds)} />
    </div>
    <div className='mt-4 grid gap-2 sm:grid-cols-2'>
      <button type='button' disabled={!phone.latestPhoneUseTrip?.tripId} onClick={() => phone.latestPhoneUseTrip?.tripId && onOpenTrip(phone.latestPhoneUseTrip.tripId)} className='rounded-2xl border border-border p-4 text-left hover:border-primary/40 disabled:cursor-default'>
        <div className='text-xs text-muted-foreground'>Latest confirmed use</div>
        <div className='mt-1 text-lg font-semibold'>{phone.latestPhoneUseTrip ? formatDuration(phone.latestPhoneUseTrip.totalSeconds) : 'None recorded'}</div>
      </button>
      <div className='rounded-2xl border border-border p-4'><div className='text-xs text-muted-foreground'>Usage Access coverage</div><div className='mt-1 text-lg font-semibold'>{phone.coveragePct || 0}%</div><div className='text-xs text-muted-foreground'>Trend: {phone.trendDirection || 'unavailable'}</div></div>
    </div>
    <div className='mt-4 rounded-2xl bg-orange-50 p-4 text-sm text-orange-900 dark:bg-orange-950/25 dark:text-orange-200'>Set navigation and audio before moving. If something needs attention, pull over before using the phone.</div>
  </section>;
}

function HistoryTargets({ goals, roads, units }) {
  return <div className='space-y-5'>
    <section className='rounded-3xl border border-border bg-card p-5 shadow-sm'>
      <PanelHeader eyebrow='Targets' title='Weekly goals' description='Goal thresholds remain editable in Settings.' icon={Flag} />
      <div className='mt-5 space-y-2'>{goals.map((goal) => <div key={goal.id} className='flex items-center gap-3 rounded-2xl bg-secondary/35 p-3'>
        {goal.met ? <CheckCircle2 className='h-5 w-5 shrink-0 text-emerald-500' /> : <ShieldAlert className='h-5 w-5 shrink-0 text-orange-500' />}
        <div className='min-w-0 flex-1'><div className='text-sm font-semibold'>{goal.label}</div><div className='text-xs text-muted-foreground'>{goal.qualified ? goal.display : `Building evidence: ${goal.display}`}</div></div>
        <span className='text-xs font-bold capitalize'>{String(goal.status).replace(/_/g, ' ')}</span>
      </div>)}</div>
    </section>
    <RoadTypePanel roads={roads} units={units} />
  </div>;
}

function RoadTypePanel({ roads, units }) {
  return <section className='rounded-3xl border border-border bg-card p-5 shadow-sm'>
    <PanelHeader eyebrow='Conditions' title='Road type breakdown' description='Score and risk evidence by dominant road context.' icon={MapPinned} />
    {roads.length === 0 ? <Notice text='No scored road types are available yet.' /> : <div className='mt-5 space-y-2'>{roads.map((road) => <div key={road.id} className='flex items-center justify-between gap-3 rounded-2xl bg-secondary/35 p-3'>
      <div><div className='text-sm font-semibold'>{road.label}</div><div className='text-xs text-muted-foreground'>{road.trip_count} trips / {formatDistance(road.distance_km, units)} / {road.risk_events} events</div></div>
      <div className={`font-grotesk text-2xl font-bold ${getScoreColor(road.avg_score).color}`}>{formatEstimatedScore(road.avg_score)}</div>
    </div>)}</div>}
  </section>;
}
