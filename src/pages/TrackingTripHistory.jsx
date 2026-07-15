import { useDeferredValue, useEffect, useMemo, useState, useTransition } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, Clock, Database, Route, Search } from 'lucide-react';
import { tripSummaryQueryOptions } from '@/api/trips';
import useLocalSettings from '@/hooks/useLocalSettings';
import { formatDistance, formatDuration, formatSpeed } from '@/lib/tripEngine';
import {
  trackingTripDisplayName, trackingTripEventCount, trackingTripEvidenceStatus,
  trackingTripNumericValue, trackingTripRoutePointCount, trackingTripRouteStatus,
  trackingTripStartTime,
} from '@/lib/trackingTripPresentation';

const filters = [
  ['all', 'All trips'], ['events', 'With observations'], ['route', 'Route retained'],
  ['limited', 'Limited evidence'], ['private', 'Privacy protected'],
];
const sorts = [
  ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['distance', 'Longest distance'],
  ['duration', 'Longest duration'], ['events', 'Most observations'],
];
const PAGE_SIZE = 40;
const badge = {
  recorded: 'border-emerald-800/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  limited: 'border-amber-800/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  unavailable: 'border-border bg-secondary text-muted-foreground',
};
const dateTime = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Time unavailable';
};
const speed = (trip, key, units) => {
  const value = trackingTripNumericValue(trip, key);
  return value == null ? 'Unavailable' : formatSpeed(value, units);
};
const distance = (trip, units) => {
  const value = trackingTripNumericValue(trip, 'distance_km');
  return value == null ? 'Unavailable' : formatDistance(value, units);
};
const duration = (trip) => {
  const value = trackingTripNumericValue(trip, 'duration_seconds');
  return value == null ? 'Unavailable' : formatDuration(value);
};

export default function TrackingTripHistory() {
  const { units = 'metric' } = useLocalSettings();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(0);
  const [isFilterPending, startFilterTransition] = useTransition();
  const query = useQuery({
    ...tripSummaryQueryOptions(),
    select: (rows) => rows.filter((trip) => trip.status === 'completed'),
  });
  const trips = query.data || [];
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const visible = useMemo(() => trips.filter((trip) => {
    const route = trackingTripRouteStatus(trip);
    const evidence = trackingTripEvidenceStatus(trip);
    const text = `${trackingTripDisplayName(trip)} ${trip.id || ''} ${trip.tag || ''} ${trip.vehicle_name || ''}`.toLowerCase();
    if (deferredSearch && !text.includes(deferredSearch)) return false;
    if (filter === 'events' && trackingTripEventCount(trip) === 0) return false;
    if (filter === 'route' && route.key !== 'retained') return false;
    if (filter === 'limited' && evidence.key === 'recorded') return false;
    if (filter === 'private' && route.key !== 'privacy' && !trip.privacy_zone_touched) return false;
    return true;
  }).sort((a, b) => {
    if (sort === 'oldest') return trackingTripStartTime(a) - trackingTripStartTime(b);
    if (sort === 'distance') return (trackingTripNumericValue(b, 'distance_km') || 0) - (trackingTripNumericValue(a, 'distance_km') || 0);
    if (sort === 'duration') return (trackingTripNumericValue(b, 'duration_seconds') || 0) - (trackingTripNumericValue(a, 'duration_seconds') || 0);
    if (sort === 'events') return trackingTripEventCount(b) - trackingTripEventCount(a);
    return trackingTripStartTime(b) - trackingTripStartTime(a);
  }), [deferredSearch, filter, sort, trips]);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageTrips = useMemo(
    () => visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [page, visible]
  );
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);
  const totals = useMemo(() => ({
    distance: trips.reduce((sum, trip) => sum + (trackingTripNumericValue(trip, 'distance_km') || 0), 0),
    duration: trips.reduce((sum, trip) => sum + (trackingTripNumericValue(trip, 'duration_seconds') || 0), 0),
    events: trips.reduce((sum, trip) => sum + trackingTripEventCount(trip), 0),
    retained: trips.filter((trip) => trackingTripRouteStatus(trip).key === 'retained').length,
  }), [trips]);

  return <div className="min-w-0">
    <header className="border-b border-border pb-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div><div className="text-[11px] font-bold text-muted-foreground">Advanced trip tracking</div>
          <h1 className="font-grotesk text-2xl font-bold">My Tracked Trips</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Recorded measurements, observations, privacy state, and evidence availability. No driver grades or rankings are shown here.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Chip icon={Route} label="Distance" value={formatDistance(totals.distance, units)} />
          <Chip icon={Clock} label="Recorded time" value={formatDuration(totals.duration)} />
          <Chip icon={Activity} label="Observations" value={String(totals.events)} />
          <Chip icon={Database} label="Routes retained" value={`${totals.retained}/${trips.length}`} />
        </div>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-[minmax(15rem,1fr)_12rem_13rem]">
        <label className="relative"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search trip name, ID, tag, or vehicle" className="h-10 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm" />
        </label>
        <select aria-label="Filter trips" value={filter} onChange={(e) => startFilterTransition(() => { setFilter(e.target.value); setPage(0); })} className="h-10 rounded-md border border-border bg-card px-3 text-sm">{filters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="Sort trips" value={sort} onChange={(e) => startFilterTransition(() => { setSort(e.target.value); setPage(0); })} className="h-10 rounded-md border border-border bg-card px-3 text-sm">{sorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
    </header>
    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card/60">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
        <span>{query.isLoading ? 'Reading local trip summaries…' : `${visible.length} of ${trips.length} trips`}</span>
        <span>{isFilterPending ? 'Updating trip list…' : query.isFetching && !query.isLoading ? 'Refreshing local data…' : visible.length > PAGE_SIZE ? `Page ${page + 1} of ${pageCount}` : ''}</span>
      </div>
      <div className="overflow-x-auto"><table className="w-full min-w-[72rem] border-collapse text-left text-xs">
        <thead className="bg-secondary/50 text-[11px] uppercase text-muted-foreground"><tr><Th>Trip</Th><Th>Distance</Th><Th>Duration</Th><Th>Average / max speed</Th><Th>Observations</Th><Th>Route evidence</Th><Th>Acquisition status</Th></tr></thead>
        <tbody className={isFilterPending ? 'opacity-60' : ''}>{pageTrips.map((trip) => {
          const route = trackingTripRouteStatus(trip); const evidence = trackingTripEvidenceStatus(trip); const points = trackingTripRoutePointCount(trip);
          return <tr key={trip.id || trip.start_time} className="border-t border-border/70 align-top hover:bg-secondary/40">
            <Td><Link to={`/trips/${trip.id}`} className="font-semibold text-foreground hover:underline">{trackingTripDisplayName(trip)}</Link><div className="mt-1">{dateTime(trip.start_time)}</div><div className="mt-0.5 font-mono text-[10px]">{trip.id || 'ID unavailable'}</div></Td>
            <Td>{distance(trip, units)}</Td><Td>{duration(trip)}</Td>
            <Td>{speed(trip, 'avg_speed_kmh', units)} / {speed(trip, 'max_speed_kmh', units)}</Td>
            <Td><b className="text-foreground">{trackingTripEventCount(trip)}</b><div className="mt-1">threshold and diagnostic records</div></Td>
            <Td><b className="text-foreground">{route.label}</b><div className="mt-1">{points == null ? 'sample count unavailable' : `${points} retained samples`}</div></Td>
            <Td><span title={evidence.detail} className={`inline-flex rounded-sm border px-2 py-1 font-semibold ${badge[evidence.key] || badge.unavailable}`}>{evidence.label}</span></Td>
          </tr>;
        })}{!query.isLoading && !visible.length && <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-muted-foreground">No trips match the current telemetry filters.</td></tr>}</tbody>
      </table></div>
      {visible.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs">
          <span className="text-muted-foreground">Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, visible.length)}</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0 || isFilterPending} className="h-9 rounded-md border border-border bg-card px-3 font-semibold disabled:cursor-not-allowed disabled:opacity-40">Previous</button>
            <button type="button" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={page >= pageCount - 1 || isFilterPending} className="h-9 rounded-md border border-border bg-card px-3 font-semibold disabled:cursor-not-allowed disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  </div>;
}

function Chip({ icon: Icon, label, value }) { return <div className="min-w-[8rem] rounded-md border border-border bg-card px-3 py-2"><div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground"><Icon className="h-3.5 w-3.5" />{label}</div><div className="mt-1 font-grotesk text-base font-bold">{value}</div></div>; }
function Th({ children }) { return <th className="px-3 py-2 font-semibold">{children}</th>; }
function Td({ children }) { return <td className="px-3 py-3 text-muted-foreground">{children}</td>; }
