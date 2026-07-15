// @ts-check
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { limitedTripSummaryQueryOptions, tripDetailQueryOptions, tripQueryKeys, tripService, tripSummaryQueryOptions } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { Search, Filter, Car, Tag, Star, CalendarDays, TrendingUp } from 'lucide-react';
import TripCard from '@/components/TripCard';
import SpeedLimitConflictReview from '@/components/SpeedLimitConflictReview';
import { useLocalSettingSelector } from '@/hooks/useLocalSettings';
import { formatDistance, formatDuration, getScoreColor, getTripComponentScore } from '@/lib/tripEngine';
import { getJson, setJson } from '@/lib/mobileStorage';
import { SAVED_FILTERS_KEY } from '@/lib/appConstants';
import {
  TRIP_TAG_OPTIONS,
  buildTripSearchText,
  calculateRecentBrakingImprovement,
  isHighRiskTrip,
  normalizeTripTags,
} from '@/lib/tripMetadata';
import InlineRefreshBadge from '@/components/InlineRefreshBadge';
import DeferredRecharts from '@/components/DeferredRecharts';
import PageLoadingSkeleton from '@/components/PageLoadingSkeleton';
import { PageHeader } from '@/components/PageChrome';

const SORT_OPTIONS = [
  { id: 'date_desc', label: 'Newest First' },
  { id: 'date_asc', label: 'Oldest First' },
  { id: 'score_desc', label: 'Best Score' },
  { id: 'score_asc', label: 'Worst Score' },
  { id: 'distance_desc', label: 'Longest' },
  { id: 'distance_asc', label: 'Shortest' },
];

const QUICK_FILTERS = [
  { id: 'all', label: 'All Trips' },
  { id: 'this_week', label: 'This Week' },
  { id: 'this_month', label: 'This Month' },
  { id: 'best', label: 'Best Trips' },
  { id: 'worst', label: 'Worst Trips' },
  { id: 'night', label: 'Night Drives' },
  { id: 'high_risk', label: 'High Risk' },
  { id: 'favorites', label: 'Favorites' },
];

const SCORE_SPARKLINES = [
  { key: 'score_overall', label: 'Overall' },
  { key: 'score_safety', label: 'Safety' },
  { key: 'score_smoothness', label: 'Smooth' },
  { key: 'score_eco', label: 'Eco' },
];

export const SCORE_DELTA_MIN_PREVIOUS_TRIPS = 3;

const scoreValue = (trip, key = 'overall') => getTripComponentScore(trip, key).value;
const sortableScore = (trip, direction = 'desc') => {
  const value = scoreValue(trip);
  if (value == null) return direction === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return value;
};

export function scoreDeltaForTrip(trip, tripsByRecentOrder = []) {
  const index = tripsByRecentOrder.findIndex((item) => String(item.id) === String(trip?.id));
  const currentScore = scoreValue(trip);
  if (index < 0 || !Number.isFinite(currentScore)) return null;

  const previousFive = tripsByRecentOrder
    .slice(index + 1, index + 6)
    .map((item) => scoreValue(item))
    .filter(Number.isFinite);

  if (previousFive.length < SCORE_DELTA_MIN_PREVIOUS_TRIPS) {
    return {
      delta: null,
      direction: 'flat',
      insufficientBaseline: true,
      sampleCount: previousFive.length,
    };
  }

  const avg = previousFive.reduce((sum, score) => sum + score, 0) / previousFive.length;
  const delta = currentScore - avg;
  return {
    delta,
    direction: delta >= 3 ? 'up' : delta <= -3 ? 'down' : 'flat',
    insufficientBaseline: false,
    sampleCount: previousFive.length,
  };
}

export function buildTripHistorySummary(trips = [], units = 'metric') {
  const safeTrips = Array.isArray(trips) ? trips : [];
  const totalDistanceKm = safeTrips.reduce((sum, trip) => sum + (Number(trip?.distance_km) || 0), 0);
  const totalDurationSeconds = safeTrips.reduce((sum, trip) => sum + (Number(trip?.duration_seconds) || 0), 0);
  const scores = safeTrips.map((trip) => scoreValue(trip)).filter(Number.isFinite);
  const averageScore = scores.length
    ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    : null;

  return {
    count: safeTrips.length,
    totalDistanceKm,
    totalDurationSeconds,
    averageScore,
    totalDistanceLabel: formatDistance(totalDistanceKm, units),
    totalDurationLabel: formatDuration(totalDurationSeconds),
    averageScoreLabel: averageScore == null ? 'No score yet' : `${averageScore}`,
    favoriteCount: safeTrips.filter((trip) => trip?.is_favorite === true).length,
    nightCount: safeTrips.filter((trip) => trip?.night_driving || normalizeTripTags(trip).includes('night')).length,
  };
}

const startOfWeek = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());
  return date.getTime();
};

const startOfMonth = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date.getTime();
};

const matchesQuickFilter = (trip, filter) => {
  const start = new Date(trip.start_time).getTime();
  if (!Number.isFinite(start)) return false;
  if (filter === 'this_week') return start >= startOfWeek();
  if (filter === 'this_month') return start >= startOfMonth();
  if (filter === 'best') return (scoreValue(trip) ?? Number.NEGATIVE_INFINITY) >= 85;
  if (filter === 'worst') return (scoreValue(trip) ?? Number.POSITIVE_INFINITY) < 60;
  if (filter === 'night') return trip.night_driving || normalizeTripTags(trip).includes('night');
  if (filter === 'high_risk') return isHighRiskTrip(trip);
  if (filter === 'favorites') return trip.is_favorite === true;
  return true;
};

export default function TripHistory() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [isFilterPending, startFilterTransition] = useTransition();
  const [sortBy, setSortBy] = useState('date_desc');
  const [filterBy, setFilterBy] = useState('all');
  const [selectedTag, setSelectedTag] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [savedFilters, setSavedFilters] = useState([]);
  const [savedFiltersLoaded, setSavedFiltersLoaded] = useState(false);
  const tripListRef = useRef(null);
  const location = useLocation();
  const units = useLocalSettingSelector((settings) => settings.units || 'metric');
  const qc = useQueryClient();
  const reviewSpeedLimitConflicts = new URLSearchParams(location.search || '').get('review') === 'speed-limit-conflicts';

  const {
    data: recentCompleted = [],
    isLoading,
    isFetching: recentFetching,
    isSuccess: recentTripsLoaded,
  } = useQuery({
    ...limitedTripSummaryQueryOptions(100),
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const {
    data: fullHistoryCompleted = [],
    isFetching: fullHistoryFetching,
  } = useQuery({
    ...tripSummaryQueryOptions(),
    enabled: recentTripsLoaded && recentCompleted.length >= 100,
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const completed = fullHistoryCompleted.length > 0 ? fullHistoryCompleted : recentCompleted;
  const isFetching = recentFetching || fullHistoryFetching;

  const { data: vehicles = [] } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 100 }),
  });

  const vehicleById = useMemo(
    () => new Map(vehicles.map((vehicle) => [String(vehicle.id), vehicle])),
    [vehicles]
  );
  const tripSearchIndex = useMemo(() => {
    const index = new Map();
    completed.forEach((trip) => {
      index.set(
        String(trip.id),
        buildTripSearchText(trip, vehicleById.get(String(trip.vehicle_id)))
      );
    });
    return index;
  }, [completed, vehicleById]);
  const invalidateTrips = () => {
    qc.invalidateQueries({ queryKey: tripQueryKeys.summaries });
  };

  const updateTripMut = useMutation({
    mutationFn: (/** @type {{id:any,patch:any}} */ vars) => tripService.update(vars.id, vars.patch),
    onSuccess: invalidateTrips,
  });

  const recentChronological = useMemo(
    () => [...completed]
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
      .slice(-5),
    [completed]
  );
  const sparklineData = useMemo(() => recentChronological.map((trip, index) => ({
    index,
    score_overall: getTripComponentScore(trip, 'overall').value,
    score_safety: getTripComponentScore(trip, 'safety').value,
    score_smoothness: getTripComponentScore(trip, 'smoothness').value,
    score_eco: getTripComponentScore(trip, 'eco').value,
  })), [recentChronological]);
  const improvement = useMemo(() => calculateRecentBrakingImprovement(completed), [completed]);
  const tripsByRecentOrder = useMemo(
    () => [...completed].sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime()),
    [completed]
  );

  const normalizedSearch = search.trim().toLowerCase();
  const sorted = useMemo(() => {
    const filtered = completed.filter((trip) => {
      if (!matchesQuickFilter(trip, filterBy)) return false;
      if (selectedTag !== 'all' && !normalizeTripTags(trip).includes(selectedTag)) return false;
      if (normalizedSearch) {
        if (!tripSearchIndex.get(String(trip.id))?.includes(normalizedSearch)) return false;
      }
      return true;
    });

    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'date_desc': return new Date(b.start_time).getTime() - new Date(a.start_time).getTime();
        case 'date_asc': return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
        case 'score_desc': return sortableScore(b, 'desc') - sortableScore(a, 'desc');
        case 'score_asc': return sortableScore(a, 'asc') - sortableScore(b, 'asc');
        case 'distance_desc': return (b.distance_km ?? 0) - (a.distance_km ?? 0);
        case 'distance_asc': return (a.distance_km ?? 0) - (b.distance_km ?? 0);
        default: return 0;
      }
    });
  }, [completed, filterBy, normalizedSearch, selectedTag, sortBy, tripSearchIndex]);
  const tripVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => tripListRef.current,
    estimateSize: () => 190,
    overscan: 5,
  });
  const virtualTrips = tripVirtualizer.getVirtualItems();
  const historySummary = useMemo(() => buildTripHistorySummary(sorted, units), [sorted, units]);
  const activeFilterLabel = QUICK_FILTERS.find((option) => option.id === filterBy)?.label || 'Custom filter';
  const activeTagLabel = selectedTag === 'all'
    ? 'All tags'
    : TRIP_TAG_OPTIONS.find((option) => option.id === selectedTag)?.label || 'Selected tag';
  const setTripSearch = (value) => {
    setSearchInput(value);
    startFilterTransition(() => {
      setSearch(value);
    });
  };
  const setTripSort = (value) => startFilterTransition(() => setSortBy(value));
  const setTripFilter = (value) => startFilterTransition(() => setFilterBy(value));
  const setTripTag = (value) => startFilterTransition(() => setSelectedTag(value));
  const handleTripIntent = useCallback((trip) => {
    if (!trip?.id) return;
    qc.prefetchQuery(tripDetailQueryOptions(trip.id)).catch(() => {});
  }, [qc]);

  const clearFilters = () => {
    setSearchInput('');
    startFilterTransition(() => {
      setSearch('');
      setFilterBy('all');
      setSelectedTag('all');
      setSortBy('date_desc');
    });
  };

  useEffect(() => {
    let cancelled = false;
    getJson(SAVED_FILTERS_KEY, []).then((storedFilters) => {
      if (cancelled) return;
      setSavedFilters(Array.isArray(storedFilters) ? storedFilters : []);
      setSavedFiltersLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!savedFiltersLoaded) return;
    setJson(SAVED_FILTERS_KEY, savedFilters).catch(() => {});
  }, [savedFilters, savedFiltersLoaded]);

  useEffect(() => {
    tripVirtualizer.scrollToIndex(0, { align: 'start' });
  }, [filterBy, search, selectedTag, sortBy, tripVirtualizer]);

  const saveCurrentFilter = () => {
    const name = presetName.trim();
    if (!name) return;
    const preset = {
      id: `filter_${Date.now()}`,
      name,
      search: searchInput,
      sortBy,
      filterBy,
      selectedTag,
    };
    setSavedFilters((current) => [preset, ...current.filter((item) => item.name.toLowerCase() !== name.toLowerCase())].slice(0, 8));
    setPresetName('');
  };

  const applySavedFilter = (preset) => {
    setSearchInput(preset.search || '');
    startFilterTransition(() => {
      setSearch(preset.search || '');
      setSortBy(preset.sortBy || 'date_desc');
      setFilterBy(preset.filterBy || 'all');
      setSelectedTag(preset.selectedTag || 'all');
    });
  };

  const removeSavedFilter = (id) => {
    setSavedFilters((current) => current.filter((item) => item.id !== id));
  };

  if (isLoading && completed.length === 0) {
    return <PageLoadingSkeleton title="Loading trip history" />;
  }

  return (
    <div className="space-y-5 pb-4">
      <PageHeader
        title="Trip History"
        description={`${sorted.length} of ${completed.length} completed trips`}
        status={(
          <>
          <InlineRefreshBadge visible={isFetching && !isLoading} label="Refreshing trip history" />
          <InlineRefreshBadge visible={isFilterPending} label="Updating filters" />
          </>
        )}
      />

      {reviewSpeedLimitConflicts && (
        <SpeedLimitConflictReview reviewMode />
      )}

      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          aria-label="Search trip history"
          placeholder="Search location, vehicle, tag, note, score, or date"
          value={searchInput}
          onChange={event => setTripSearch(event.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary transition-colors"
        />
      </div>

      {improvement && (
        <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300">
          <TrendingUp className="h-4 w-4" />
          <span className="font-semibold">{improvement.message}</span>
        </div>
      )}

      {completed.length > 0 && (
        <section aria-label="Filtered trip history snapshot" className="rounded-2xl border border-border bg-card p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filtered snapshot</div>
              <div className="text-sm font-semibold">{historySummary.count} matching trips</div>
            </div>
            <div className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-muted-foreground">
              {activeFilterLabel} / {activeTagLabel}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-secondary/50 px-2 py-3">
              <div className="text-xs text-muted-foreground">Distance</div>
              <div className="font-grotesk text-lg font-bold">{historySummary.totalDistanceLabel}</div>
            </div>
            <div className="rounded-xl bg-secondary/50 px-2 py-3">
              <div className="text-xs text-muted-foreground">Duration</div>
              <div className="font-grotesk text-lg font-bold">{historySummary.totalDurationLabel}</div>
            </div>
            <div className="rounded-xl bg-secondary/50 px-2 py-3">
              <div className="text-xs text-muted-foreground">Avg score</div>
              <div className="font-grotesk text-lg font-bold">{historySummary.averageScoreLabel}</div>
            </div>
          </div>
          {(historySummary.favoriteCount > 0 || historySummary.nightCount > 0) && (
            <div className="mt-3 text-xs text-muted-foreground">
              Includes {historySummary.favoriteCount} favorites and {historySummary.nightCount} night drives in the current view.
            </div>
          )}
        </section>
      )}

      {sparklineData.length > 1 && (
        <div className="grid grid-cols-2 gap-2">
          {SCORE_SPARKLINES.map((score) => {
            const latest = sparklineData[sparklineData.length - 1]?.[score.key];
            const scoreColor = latest == null ? 'text-muted-foreground' : getScoreColor(latest).color;
            const color = scoreColor.includes('green')
              ? '#22c55e'
              : scoreColor.includes('blue')
                ? '#3b82f6'
                : scoreColor.includes('yellow')
                  ? '#eab308'
                  : scoreColor.includes('orange')
                    ? '#f97316'
                    : '#ef4444';
            return (
              <div
                key={score.key}
                className="flex items-center justify-between rounded-xl border border-border bg-card px-3 py-2"
              >
                <div>
                  <div className="text-xs font-semibold">{score.label}</div>
                  <div className="text-[10px] text-muted-foreground">last 5 trips</div>
                </div>
                <div className="h-8 w-20">
                  <DeferredRecharts height={32}>
                    {({ ResponsiveContainer, LineChart, Line }) => (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={sparklineData}>
                          <Line type="monotone" dataKey={score.key} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </DeferredRecharts>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div role="toolbar" aria-label="Trip history filters" className="flex gap-2 overflow-x-auto pb-1 thin-scrollbar">
          <button
            onClick={() => setShowFilters(!showFilters)}
            aria-expanded={showFilters}
            className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
            showFilters ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:border-primary/50'
          }`}
        >
          <Filter className="w-3.5 h-3.5" />
          Filter
        </button>

        <select
          aria-label="Sort trips"
          value={sortBy}
          onChange={event => setTripSort(event.target.value)}
          className="flex-shrink-0 bg-card border border-border rounded-xl text-xs font-medium px-3 py-2 text-muted-foreground outline-none"
        >
          {SORT_OPTIONS.map(option => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>

        {QUICK_FILTERS.map(option => (
          <button
            key={option.id}
            onClick={() => setTripFilter(option.id)}
            aria-pressed={filterBy === option.id}
            className={`flex-shrink-0 px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
              filterBy === option.id
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-muted-foreground border-border hover:border-primary/50'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {showFilters && (
        <div className="space-y-4 rounded-2xl border border-border bg-card p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <Tag className="h-3.5 w-3.5" />
            Tags
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setTripTag('all')}
              aria-pressed={selectedTag === 'all'}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                selectedTag === 'all' ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground'
              }`}
            >
              All tags
            </button>
            {TRIP_TAG_OPTIONS.map(option => (
              <button
                key={option.id}
                onClick={() => setTripTag(option.id)}
                aria-pressed={selectedTag === option.id}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                  selectedTag === option.id ? 'border-primary bg-primary text-primary-foreground' : option.className
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="border-t border-border pt-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <Star className="h-3.5 w-3.5" />
              Saved filters
            </div>
            <div className="flex gap-2">
              <input
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
                placeholder="Name this filter"
                className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={saveCurrentFilter}
                disabled={!presetName.trim()}
                className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
              >
                Save
              </button>
            </div>
            {savedFilters.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {savedFilters.map((preset) => (
                  <span key={preset.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/50 px-2 py-1 text-xs">
                    <button type="button" onClick={() => applySavedFilter(preset)} className="font-medium hover:text-primary">
                      {preset.name}
                    </button>
                    <button type="button" onClick={() => removeSavedFilter(preset.id)} className="min-h-9 min-w-9 text-muted-foreground hover:text-red-500" aria-label={`Delete ${preset.name} filter`}>
                      x
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-28 bg-secondary/50 rounded-2xl animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && completed.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-card py-16 text-center">
          <div className="w-16 h-16 bg-secondary rounded-3xl flex items-center justify-center mb-4">
            <Car className="w-8 h-8 text-muted-foreground" />
          </div>
          <div className="font-semibold mb-1">No trips yet</div>
          <div className="max-w-xs text-muted-foreground text-sm">Start tracking a drive from the Dashboard. Your saved routes, notes, tags, and favorites will appear here.</div>
        </div>
      )}

      {!isLoading && completed.length > 0 && sorted.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-card py-16 text-center">
          <CalendarDays className="w-10 h-10 text-muted-foreground mb-3" />
          <div className="font-semibold mb-1">No matching trips</div>
          <div className="max-w-xs text-muted-foreground text-sm">Try a different search, score range, tag, or quick filter.</div>
          <button onClick={clearFilters} className="mt-4 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">
            Clear filters
          </button>
        </div>
      )}

      <div className="sr-only" aria-live="polite">
        {isLoading ? 'Loading trip history' : `${sorted.length} trips shown`}
      </div>

      {!isLoading && sorted.length > 0 && (
        <div
          ref={tripListRef}
          className="max-h-[72vh] overflow-y-auto pr-1 thin-scrollbar"
          aria-label="Virtualized trip history list"
        >
          <div
            className="relative w-full"
            style={{ height: `${tripVirtualizer.getTotalSize()}px` }}
          >
            {virtualTrips.map((virtualItem) => {
              const trip = sorted[virtualItem.index];
              if (!trip) return null;
              return (
                <div
                  key={trip.id}
                  ref={tripVirtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="absolute left-0 top-0 w-full pb-3"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <TripCard
                    trip={trip}
                    units={units}
                    index={virtualItem.index}
                    scoreDelta={scoreDeltaForTrip(trip, tripsByRecentOrder)}
                    onToggleFavorite={(target) => updateTripMut.mutate({
                      id: target.id,
                      patch: { is_favorite: target.is_favorite !== true },
                    })}
                    onIntent={handleTripIntent}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {completed.some((trip) => trip.is_favorite) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Star className="h-3.5 w-3.5 text-amber-500" />
          Favorited trips stay searchable and can be filtered for repeat-route comparisons.
        </div>
      )}
    </div>
  );
}
