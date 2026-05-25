import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { Search, Filter, Car, Tag, Star, CalendarDays, TrendingUp } from 'lucide-react';
import TripCard from '@/components/TripCard';
import { localSettings } from '@/lib/trackingStore';
import { getScoreColor, getTripComponentScore } from '@/lib/tripEngine';
import { getJson, setJson } from '@/lib/mobileStorage';
import { SAVED_FILTERS_KEY } from '@/lib/appConstants';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import {
  TRIP_TAG_OPTIONS,
  buildTripSearchText,
  calculateRecentBrakingImprovement,
  isHighRiskTrip,
  normalizeTripTags,
} from '@/lib/tripMetadata';

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
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('date_desc');
  const [filterBy, setFilterBy] = useState('all');
  const [selectedTag, setSelectedTag] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [savedFilters, setSavedFilters] = useState([]);
  const [savedFiltersLoaded, setSavedFiltersLoaded] = useState(false);
  const settings = localSettings.get();
  const units = settings.units || 'metric';
  const qc = useQueryClient();

  const { data: trips = [], isLoading } = useQuery({
    queryKey: ['all-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 1000 }),
  });

  const { data: vehicles = [] } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 100 }),
  });

  const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle.id), vehicle]));
  const invalidateTrips = () => {
    qc.invalidateQueries({ queryKey: ['all-trips'] });
    qc.invalidateQueries({ queryKey: ['recent-trips'] });
  };

  const updateTripMut = useMutation({
    mutationFn: (/** @type {{id:any,patch:any}} */ vars) => tripService.update(vars.id, vars.patch),
    onSuccess: invalidateTrips,
  });

  const completed = trips.filter((trip) => trip.status === 'completed');
  const recentChronological = [...completed]
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
    .slice(-5);
  const sparklineData = recentChronological.map((trip, index) => ({
    index,
    score_overall: getTripComponentScore(trip, 'overall').value,
    score_safety: getTripComponentScore(trip, 'safety').value,
    score_smoothness: getTripComponentScore(trip, 'smoothness').value,
    score_eco: getTripComponentScore(trip, 'eco').value,
  }));
  const improvement = calculateRecentBrakingImprovement(completed);
  const tripsByRecentOrder = [...completed].sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());

  const filtered = completed.filter((trip) => {
    if (!matchesQuickFilter(trip, filterBy)) return false;
    if (selectedTag !== 'all' && !normalizeTripTags(trip).includes(selectedTag)) return false;
    if (search) {
      const vehicle = vehicleById.get(String(trip.vehicle_id));
      if (!buildTripSearchText(trip, vehicle).includes(search.toLowerCase())) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
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

  const clearFilters = () => {
    setSearch('');
    setFilterBy('all');
    setSelectedTag('all');
    setSortBy('date_desc');
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

  const saveCurrentFilter = () => {
    const name = presetName.trim();
    if (!name) return;
    const preset = {
      id: `filter_${Date.now()}`,
      name,
      search,
      sortBy,
      filterBy,
      selectedTag,
    };
    setSavedFilters((current) => [preset, ...current.filter((item) => item.name.toLowerCase() !== name.toLowerCase())].slice(0, 8));
    setPresetName('');
  };

  const applySavedFilter = (preset) => {
    setSearch(preset.search || '');
    setSortBy(preset.sortBy || 'date_desc');
    setFilterBy(preset.filterBy || 'all');
    setSelectedTag(preset.selectedTag || 'all');
  };

  const removeSavedFilter = (id) => {
    setSavedFilters((current) => current.filter((item) => item.id !== id));
  };

  return (
    <div className="space-y-5 pb-4">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-grotesk font-bold">Trip History</h1>
        <p className="text-muted-foreground text-sm mt-1">{sorted.length} of {completed.length} completed trips</p>
      </motion.div>

      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search location, vehicle, tag, note, score, or date"
          value={search}
          onChange={event => setSearch(event.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary transition-colors"
        />
      </div>

      {improvement && (
        <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300">
          <TrendingUp className="h-4 w-4" />
          <span className="font-semibold">{improvement.message}</span>
        </div>
      )}

      {sparklineData.length > 1 && (
        <div className="grid grid-cols-2 gap-2">
          {SCORE_SPARKLINES.map((score, index) => {
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
              <motion.div
                key={score.key}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.1 * index }}
                className="flex items-center justify-between rounded-xl border border-border bg-card px-3 py-2"
              >
                <div>
                  <div className="text-xs font-semibold">{score.label}</div>
                  <div className="text-[10px] text-muted-foreground">last 5 trips</div>
                </div>
                <div className="h-8 w-20">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={sparklineData}>
                      <Line type="monotone" dataKey={score.key} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto pb-1 thin-scrollbar">
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
          value={sortBy}
          onChange={event => setSortBy(event.target.value)}
          className="flex-shrink-0 bg-card border border-border rounded-xl text-xs font-medium px-3 py-2 text-muted-foreground outline-none"
        >
          {SORT_OPTIONS.map(option => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>

        {QUICK_FILTERS.map(option => (
          <button
            key={option.id}
            onClick={() => setFilterBy(option.id)}
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
              onClick={() => setSelectedTag('all')}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                selectedTag === 'all' ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground'
              }`}
            >
              All tags
            </button>
            {TRIP_TAG_OPTIONS.map(option => (
              <button
                key={option.id}
                onClick={() => setSelectedTag(option.id)}
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
                    <button type="button" onClick={() => removeSavedFilter(preset.id)} className="text-muted-foreground hover:text-red-500" aria-label={`Delete ${preset.name} filter`}>
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

      {!isLoading && sorted.length > 0 && (
        <div className="space-y-3">
          {sorted.map((trip, index) => (
            <TripCard
              key={trip.id}
              trip={trip}
              units={units}
              index={index}
              scoreDelta={scoreDeltaForTrip(trip, tripsByRecentOrder)}
              onToggleFavorite={(target) => updateTripMut.mutate({
                id: target.id,
                patch: { is_favorite: target.is_favorite !== true },
              })}
            />
          ))}
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
