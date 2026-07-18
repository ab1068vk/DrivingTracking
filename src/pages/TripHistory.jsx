// @ts-check
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { limitedTripSummaryQueryOptions, tripDetailQueryOptions, tripQueryKeys, tripService, tripSummaryQueryOptions } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { Search, Car, Tag, Star, CalendarDays, TrendingUp, X, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react';
import TripCard from '@/components/TripCard';
import {
  PremiumFilteredSnapshot,
  PremiumHistoryResultsPager,
  PremiumHistorySearch,
  getPremiumHistoryPageWindow,
} from '@/components/PremiumTripHistoryPanels';
import SpeedLimitConflictReview from '@/components/SpeedLimitConflictReview';
import { useLocalSettingSelector } from '@/hooks/useLocalSettings';
import { formatDistance, formatDuration, getTripComponentScore } from '@/lib/tripEngine';
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
  { id: 'favorites', label: 'Favorites' },
  { id: 'high_risk', label: 'Needs Attention' },
  { id: 'night', label: 'Night' },
  { id: 'best', label: 'Best Trips' },
  { id: 'worst', label: 'Low Score' },
];

const DATE_FILTERS = [
  { id: 'all', label: 'Any date' },
  { id: 'today', label: 'Today' },
  { id: 'last_7', label: 'Last 7 days' },
  { id: 'last_30', label: 'Last 30 days' },
  { id: 'this_month', label: 'This month' },
  { id: 'exact_day', label: 'Exact day' },
  { id: 'custom', label: 'Date range' },
];

export const TRIP_HISTORY_PAGE_SIZE = 30;
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

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const startOfMonth = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date.getTime();
};

const matchesQuickFilter = (trip, filter) => {
  if (filter === 'best') return (scoreValue(trip) ?? Number.NEGATIVE_INFINITY) >= 85;
  if (filter === 'worst') return (scoreValue(trip) ?? Number.POSITIVE_INFINITY) < 60;
  if (filter === 'night') return trip.night_driving || normalizeTripTags(trip).includes('night');
  if (filter === 'high_risk') return isHighRiskTrip(trip);
  if (filter === 'favorites') return trip.is_favorite === true;
  return true;
};

const parseLocalDate = (value) => {
  if (!value) return null;
  const date = new Date(value + 'T00:00:00');
  return Number.isFinite(date.getTime()) ? date : null;
};

export const matchesTripSearchText = (indexedText = '', query = '') => {
  const haystack = String(indexedText || '').toLowerCase();
  const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token));
};

export const matchesTripDateFilter = (trip, filter = 'all', dateFrom = '', dateTo = '') => {
  const start = new Date(trip?.start_time).getTime();
  if (!Number.isFinite(start)) return false;
  const today = startOfToday();
  const tomorrowDate = new Date(today);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = tomorrowDate.getTime();
  const daysAgo = (days) => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.getTime();
  };
  if (filter === 'today') return start >= today && start < tomorrow;
  if (filter === 'last_7') return start >= daysAgo(6) && start < tomorrow;
  if (filter === 'last_30') return start >= daysAgo(29) && start < tomorrow;
  if (filter === 'this_month') return start >= startOfMonth() && start < tomorrow;
  if (filter === 'exact_day') {
    const exactDate = parseLocalDate(dateFrom);
    if (!exactDate) return true;
    const exactStart = exactDate.getTime();
    exactDate.setDate(exactDate.getDate() + 1);
    return start >= exactStart && start < exactDate.getTime();
  }
  if (filter === 'custom') {
    const from = parseLocalDate(dateFrom)?.getTime();
    const toDate = parseLocalDate(dateTo);
    if (from != null && start < from) return false;
    if (toDate) {
      toDate.setDate(toDate.getDate() + 1);
      if (start >= toDate.getTime()) return false;
    }
  }
  return true;
};

export default function TripHistory() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [isFilterPending, startFilterTransition] = useTransition();
  const [sortBy, setSortBy] = useState('date_desc');
  const [filterBy, setFilterBy] = useState('all');
  const [dateFilter, setDateFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(0);
  const [selectedTag, setSelectedTag] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [savedFilters, setSavedFilters] = useState([]);
  const [savedFiltersLoaded, setSavedFiltersLoaded] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const tripListRef = useRef(null);
  const location = useLocation();
  const units = useLocalSettingSelector((settings) => settings.units || 'metric');
  const premiumVisuals = useLocalSettingSelector((settings) => settings.premium_visual_experience === true);
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


  const improvement = useMemo(() => calculateRecentBrakingImprovement(completed), [completed]);
  const tripsByRecentOrder = useMemo(
    () => [...completed].sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime()),
    [completed]
  );

  const normalizedSearch = search.trim().toLowerCase();
  const sorted = useMemo(() => {
    const filtered = completed.filter((trip) => {
      if (!matchesQuickFilter(trip, filterBy)) return false;
      if (!matchesTripDateFilter(trip, dateFilter, dateFrom, dateTo)) return false;
      if (selectedTag !== 'all' && !normalizeTripTags(trip).includes(selectedTag)) return false;
      if (normalizedSearch) {
        const indexedText = tripSearchIndex.get(String(trip.id)) || '';
        if (!matchesTripSearchText(indexedText, normalizedSearch)) return false;
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
  }, [completed, dateFilter, dateFrom, dateTo, filterBy, normalizedSearch, selectedTag, sortBy, tripSearchIndex]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / TRIP_HISTORY_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * TRIP_HISTORY_PAGE_SIZE;
  const pageTrips = sorted.slice(pageStart, pageStart + TRIP_HISTORY_PAGE_SIZE);
  const pageEnd = pageStart + pageTrips.length;
  const pageWindow = getPremiumHistoryPageWindow(sorted.length, premiumVisuals ? currentPage : 0);
  const premiumTrips = useMemo(
    () => sorted.slice(pageWindow.offset, pageWindow.end),
    [pageWindow.end, pageWindow.offset, sorted]
  );
  const tripVirtualizer = useVirtualizer({
    count: premiumVisuals ? premiumTrips.length : 0,
    getScrollElement: () => tripListRef.current,
    estimateSize: () => 190,
    overscan: 5,
  });
  const virtualTrips = tripVirtualizer.getVirtualItems();
  const historySummary = useMemo(() => buildTripHistorySummary(sorted, units), [sorted, units]);
  const activeFilterLabel = QUICK_FILTERS.find((option) => option.id === filterBy)?.label || 'Custom filter';
  const exactDateLabel = dateFrom
    ? parseLocalDate(dateFrom)?.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null;
  const activeDateLabel = dateFilter === 'exact_day'
    ? exactDateLabel || 'Choose a day'
    : dateFilter === 'custom'
      ? [dateFrom, dateTo].filter(Boolean).join(' – ') || 'Choose a date range'
      : DATE_FILTERS.find((option) => option.id === dateFilter)?.label || 'Any date';
  const activeTagLabel = selectedTag === 'all'
    ? 'All tags'
    : TRIP_TAG_OPTIONS.find((option) => option.id === selectedTag)?.label || 'Selected tag';
  const hasActiveFilters = Boolean(searchInput) || filterBy !== 'all' || dateFilter !== 'all' || selectedTag !== 'all' || sortBy !== 'date_desc';
  const setTripSearch = (value) => {
    setSearchInput(value);
    startFilterTransition(() => {
      setSearch(value);
    });
  };
  const setTripSort = (value) => startFilterTransition(() => setSortBy(value));
  const setTripFilter = (value) => startFilterTransition(() => setFilterBy(value));
  const setTripDateFilter = (value) => startFilterTransition(() => setDateFilter(value));
  const setTripTag = (value) => startFilterTransition(() => setSelectedTag(value));
  const handleTripIntent = useCallback((trip) => {
    if (!trip?.id) return;
    qc.prefetchQuery(tripDetailQueryOptions(trip.id)).catch(() => {});
  }, [qc]);
  const changePage = (nextPage) => {
    setPage(Math.max(0, Math.min(pageCount - 1, nextPage)));
    requestAnimationFrame(() => {
      tripListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const clearFilters = () => {
    setSearchInput('');
    startFilterTransition(() => {
      setSearch('');
      setFilterBy('all');
      setDateFilter('all');
      setDateFrom('');
      setDateTo('');
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
    setPage(0);
    setCurrentPage(0);
    if (premiumVisuals) tripVirtualizer.scrollToIndex(0, { align: 'start' });
  }, [dateFilter, dateFrom, dateTo, filterBy, premiumVisuals, search, selectedTag, sortBy, tripVirtualizer]);

  useEffect(() => {
    if (page > pageCount - 1) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);

  useEffect(() => {
    if (currentPage !== pageWindow.page) setCurrentPage(pageWindow.page);
  }, [currentPage, pageWindow.page]);

  useEffect(() => {
    if (!premiumVisuals) return;
    tripVirtualizer.scrollToIndex(0, { align: 'start' });
  }, [currentPage, premiumVisuals, tripVirtualizer]);

  const saveCurrentFilter = () => {
    const name = presetName.trim();
    if (!name) return;
    const preset = {
      id: `filter_${Date.now()}`,
      name,
      search: searchInput,
      sortBy,
      filterBy,
      dateFilter,
      dateFrom,
      dateTo,
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
      setDateFilter(preset.dateFilter || 'all');
      setDateFrom(preset.dateFrom || '');
      setDateTo(preset.dateTo || '');
      setSelectedTag(preset.selectedTag || 'all');
    });
  };

  const removeSavedFilter = (id) => {
    setSavedFilters((current) => current.filter((item) => item.id !== id));
  };

  if (isLoading && completed.length === 0) {
    return <PageLoadingSkeleton title="Loading trip history" />;
  }

  const premiumDateInputs = (
    <>
      {dateFilter === 'exact_day' && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
          <label className="text-xs font-semibold text-foreground">
            Choose one day
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground sm:max-w-xs"
            />
          </label>
        </div>
      )}
      {dateFilter === 'custom' && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground">
            <CalendarDays className="h-3.5 w-3.5" />
            Choose a date range
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] font-medium text-muted-foreground">
              From
              <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-border bg-background px-2 text-xs text-foreground" />
            </label>
            <label className="text-[11px] font-medium text-muted-foreground">
              To
              <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-border bg-background px-2 text-xs text-foreground" />
            </label>
          </div>
        </div>
      )}
    </>
  );

  const premiumFilterDetails = showFilters ? (
    <div className="premium-history-expanded-filters space-y-4 rounded-2xl border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <Tag className="h-3.5 w-3.5" /> Tags
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setTripTag('all')} aria-pressed={selectedTag === 'all'} className={`rounded-full border px-2.5 py-1 text-xs font-medium ${selectedTag === 'all' ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground'}`}>All tags</button>
        {TRIP_TAG_OPTIONS.map((option) => (
          <button type="button" key={option.id} onClick={() => setTripTag(option.id)} aria-pressed={selectedTag === option.id} className={`rounded-full border px-2.5 py-1 text-xs font-medium ${selectedTag === option.id ? 'border-primary bg-primary text-primary-foreground' : option.className}`}>{option.label}</button>
        ))}
      </div>
      <div className="border-t border-border pt-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Star className="h-3.5 w-3.5" /> Saved filters</div>
        <div className="flex gap-2">
          <input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="Name this filter" className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary" />
          <button type="button" onClick={saveCurrentFilter} disabled={!presetName.trim()} className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40">Save</button>
        </div>
        {savedFilters.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {savedFilters.map((preset) => (
              <span key={preset.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/50 px-2 py-1 text-xs">
                <button type="button" onClick={() => applySavedFilter(preset)} className="font-medium hover:text-primary">{preset.name}</button>
                <button type="button" onClick={() => removeSavedFilter(preset.id)} className="min-h-9 min-w-9 text-muted-foreground hover:text-red-500" aria-label={`Delete ${preset.name} filter`}>x</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className={`space-y-5 pb-4 ${premiumVisuals ? 'premium-trip-history-on' : ''}`}>
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
      {premiumVisuals ? (
        <>
          <PremiumHistorySearch
            value={searchInput}
            onChange={setTripSearch}
            sortBy={sortBy}
            onSortChange={setTripSort}
            filterBy={filterBy}
            onFilterChange={setTripFilter}
            dateFilter={dateFilter}
            onDateFilterChange={setTripDateFilter}
            dateOptions={DATE_FILTERS}
            sortOptions={SORT_OPTIONS}
            quickFilters={QUICK_FILTERS}
            showFilters={showFilters}
            onToggleFilters={() => setShowFilters((visible) => !visible)}
            expandedFilters={premiumFilterDetails}
          />
          {premiumDateInputs}
        </>
      ) : (
      <section aria-label="Find and filter trips" className="space-y-3 rounded-2xl border border-border bg-card p-3 shadow-sm sm:p-4">
        <div>
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              aria-label="Search trip history"
              placeholder="Search place, month, date, km, score, notes, events…"
              value={searchInput}
              onChange={(event) => setTripSearch(event.target.value)}
              className="h-11 w-full rounded-xl border border-border bg-background pl-10 pr-4 text-sm outline-none transition-colors focus:border-primary"
            />
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Combine terms in any order—for example “July 14”, “20 km”, “score 85”, “night Toronto”, or a vehicle name.
          </p>
        </div>

        <div role="toolbar" aria-label="Trip history filters" className="grid grid-cols-2 gap-2 lg:grid-cols-[1fr_1fr_1fr_auto]">
          <label className="min-w-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Date
            <select
              aria-label="Filter trips by date"
              value={dateFilter}
              onChange={(event) => setTripDateFilter(event.target.value)}
              className="mt-1 h-10 w-full rounded-xl border border-border bg-background px-3 text-xs font-medium text-foreground outline-none focus:border-primary"
            >
              {DATE_FILTERS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Trip type
            <select
              aria-label="Filter trips by type"
              value={filterBy}
              onChange={(event) => setTripFilter(event.target.value)}
              className="mt-1 h-10 w-full rounded-xl border border-border bg-background px-3 text-xs font-medium text-foreground outline-none focus:border-primary"
            >
              {QUICK_FILTERS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Sort
            <select
              aria-label="Sort trips"
              value={sortBy}
              onChange={(event) => setTripSort(event.target.value)}
              className="mt-1 h-10 w-full rounded-xl border border-border bg-background px-3 text-xs font-medium text-foreground outline-none focus:border-primary"
            >
              {SORT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setShowFilters((value) => !value)}
            aria-expanded={showFilters}
            className={`mt-4 inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-colors lg:mt-4 ${
              showFilters || selectedTag !== 'all'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:border-primary/50'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Tags & saved
          </button>
        </div>

        {dateFilter === 'exact_day' && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
            <label className="text-xs font-semibold text-foreground">
              Choose one day
              <input
                type="date"
                value={dateFrom}
                onChange={(event) => setDateFrom(event.target.value)}
                className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground sm:max-w-xs"
              />
            </label>
            <p className="mt-1.5 text-[11px] text-muted-foreground">Only trips recorded on this calendar day will be shown.</p>
          </div>
        )}

        {dateFilter === 'custom' && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              Choose a date range
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] font-medium text-muted-foreground">
                From
                <input
                  type="date"
                  value={dateFrom}
                  max={dateTo || undefined}
                  onChange={(event) => setDateFrom(event.target.value)}
                  className="mt-1 h-10 w-full rounded-xl border border-border bg-background px-2 text-xs text-foreground"
                />
              </label>
              <label className="text-[11px] font-medium text-muted-foreground">
                To
                <input
                  type="date"
                  value={dateTo}
                  min={dateFrom || undefined}
                  onChange={(event) => setDateTo(event.target.value)}
                  className="mt-1 h-10 w-full rounded-xl border border-border bg-background px-2 text-xs text-foreground"
                />
              </label>
            </div>
          </div>
        )}

        {showFilters && (
          <div className="space-y-4 rounded-xl border border-border bg-secondary/20 p-3">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <Tag className="h-3.5 w-3.5" />
                Trip tags
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setTripTag('all')}
                  aria-pressed={selectedTag === 'all'}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                    selectedTag === 'all' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground'
                  }`}
                >
                  All tags
                </button>
                {TRIP_TAG_OPTIONS.map((option) => (
                  <button
                    type="button"
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
                    <span key={preset.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-xs">
                      <button type="button" onClick={() => applySavedFilter(preset)} className="font-medium hover:text-primary">
                        {preset.name}
                      </button>
                      <button type="button" onClick={() => removeSavedFilter(preset.id)} className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-red-500" aria-label={`Delete ${preset.name} filter`}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
      )}

      {!premiumVisuals && improvement && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300">
          <TrendingUp className="h-4 w-4" />
          <span className="font-semibold">{improvement.message}</span>
        </div>
      )}

      {completed.length > 0 && (premiumVisuals ? (
        <PremiumFilteredSnapshot
          summary={historySummary}
          filterLabel={activeDateLabel === 'Any date' ? activeFilterLabel : activeDateLabel}
          tagLabel={activeTagLabel}
        />
      ) : (
        <section aria-label="Filtered trip history snapshot" className="rounded-2xl border border-border bg-card p-3 shadow-sm sm:p-4">
          <span className="sr-only">{historySummary.count} matching trips</span>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filtered snapshot</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">All completed trips matching the search and filters above.</div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <span className="rounded-full bg-secondary px-2 py-1 text-[11px] font-medium text-muted-foreground">{activeDateLabel}</span>
              {filterBy !== 'all' && <span className="rounded-full bg-secondary px-2 py-1 text-[11px] font-medium text-muted-foreground">{activeFilterLabel}</span>}
              {selectedTag !== 'all' && <span className="rounded-full bg-secondary px-2 py-1 text-[11px] font-medium text-muted-foreground">{activeTagLabel}</span>}
              {hasActiveFilters && (
                <button type="button" onClick={clearFilters} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-muted-foreground hover:bg-secondary" aria-label="Clear all trip filters">
                  <X className="h-3.5 w-3.5" />
                  Clear
                </button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-xl bg-secondary/50 px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">Matching trips</div>
              <div className="font-grotesk text-xl font-bold">{historySummary.count}</div>
            </div>
            <div className="rounded-xl bg-secondary/50 px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">Matching distance</div>
              <div className="font-grotesk text-xl font-bold">{historySummary.totalDistanceLabel}</div>
            </div>
            <div className="rounded-xl bg-secondary/50 px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">Drive time</div>
              <div className="font-grotesk text-xl font-bold">{historySummary.totalDurationLabel}</div>
            </div>
            <div className="rounded-xl bg-secondary/50 px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">Avg score</div>
              <div className="font-grotesk text-xl font-bold">{historySummary.averageScoreLabel}</div>
            </div>
          </div>
        </section>
      ))}
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
        premiumVisuals ? (
        <section className="space-y-3" aria-label="Paginated premium trip history">
          <PremiumHistoryResultsPager
            start={pageWindow.start}
            end={pageWindow.end}
            total={sorted.length}
            page={pageWindow.page}
            pageCount={pageWindow.pageCount}
            onPrevious={() => setCurrentPage((current) => Math.max(0, current - 1))}
            onNext={() => setCurrentPage((current) => Math.min(pageWindow.pageCount - 1, current + 1))}
          />
        <div ref={tripListRef} className="max-h-[72vh] overflow-y-auto pr-1 thin-scrollbar" aria-label="Virtualized trip history list">
          <div className="relative w-full" style={{ height: `${tripVirtualizer.getTotalSize()}px` }}>
            {virtualTrips.map((virtualItem) => {
              const trip = premiumTrips[virtualItem.index];
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
                    index={pageWindow.offset + virtualItem.index}
                    scoreDelta={scoreDeltaForTrip(trip, tripsByRecentOrder)}
                    onToggleFavorite={(target) => updateTripMut.mutate({ id: target.id, patch: { is_favorite: target.is_favorite !== true } })}
                    onIntent={handleTripIntent}
                  />
                </div>
              );
            })}
          </div>
        </div>
          <PremiumHistoryResultsPager
            start={pageWindow.start}
            end={pageWindow.end}
            total={sorted.length}
            page={pageWindow.page}
            pageCount={pageWindow.pageCount}
            onPrevious={() => setCurrentPage((current) => Math.max(0, current - 1))}
            onNext={() => setCurrentPage((current) => Math.min(pageWindow.pageCount - 1, current + 1))}
          />
        </section>
        ) : (
        <section ref={tripListRef} className="scroll-mt-24 space-y-2" aria-label="Paginated trip history">
          <TripPageControls
            page={safePage}
            pageCount={pageCount}
            start={pageStart + 1}
            end={pageEnd}
            total={sorted.length}
            onPageChange={changePage}
          />
          <div className="space-y-2">
            {pageTrips.map((trip, index) => (
              <TripCard
                key={trip.id}
                trip={trip}
                compact
                units={units}
                index={pageStart + index}
                scoreDelta={scoreDeltaForTrip(trip, tripsByRecentOrder)}
                onToggleFavorite={(target) => updateTripMut.mutate({
                  id: target.id,
                  patch: { is_favorite: target.is_favorite !== true },
                })}
                onIntent={handleTripIntent}
              />
            ))}
          </div>
          {pageCount > 1 && (
            <TripPageControls
              page={safePage}
              pageCount={pageCount}
              start={pageStart + 1}
              end={pageEnd}
              total={sorted.length}
              onPageChange={changePage}
              compact
            />
          )}
        </section>
        )
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
function TripPageControls({ page, pageCount, start, end, total, onPageChange, compact = false }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 ${compact ? 'py-2' : 'py-2.5'} text-xs`}>
      <span className="text-muted-foreground">
        Showing <b className="text-foreground">{start}–{end}</b> of <b className="text-foreground">{total}</b> matching trips
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page === 0}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Previous 30 trips"
          title="Previous 30 trips"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-16 text-center font-semibold text-foreground">{page + 1} / {pageCount}</span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount - 1}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Next 30 trips"
          title="Next 30 trips"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
