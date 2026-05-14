import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { Search, Filter, Car, Tag } from 'lucide-react';
import TripCard from '@/components/TripCard';
import { localSettings } from '@/lib/trackingStore';

const SORT_OPTIONS = [
  { id: 'date_desc', label: 'Newest First' },
  { id: 'date_asc', label: 'Oldest First' },
  { id: 'score_desc', label: 'Best Score' },
  { id: 'score_asc', label: 'Worst Score' },
  { id: 'distance_desc', label: 'Longest' },
  { id: 'distance_asc', label: 'Shortest' },
];

const DATE_FILTERS = [
  { id: 'this_month', label: 'This Month' },
  { id: 'last_30', label: 'Last 30 Days' },
  { id: 'last_90', label: 'Last 90 Days' },
  { id: 'all_time', label: 'All Time' },
];

const FILTER_OPTIONS = [
  { id: 'all', label: 'All Trips' },
  { id: 'excellent', label: '85+' },
  { id: 'good', label: '70-84' },
  { id: 'fair', label: '55-69' },
  { id: 'poor', label: '<55' },
  { id: 'night', label: 'Night' },
  { id: 'harsh_braking', label: 'Harsh Braking' },
  { id: 'tag_work', label: 'Work' },
  { id: 'tag_personal', label: 'Personal' },
  { id: 'tag_errands', label: 'Errands' },
];

const TAG_OPTIONS = [
  { id: 'work', label: 'Work', color: 'bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/50' },
  { id: 'personal', label: 'Personal', color: 'bg-green-50 dark:bg-green-950/30 text-green-600 dark:text-green-400 border-green-200 dark:border-green-800/50' },
  { id: 'errands', label: 'Errands', color: 'bg-orange-50 dark:bg-orange-950/30 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800/50' },
];

const isSameMonth = (value, now = new Date()) => {
  const date = new Date(value);
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
};

const matchesDateFilter = (trip, dateFilter) => {
  const start = new Date(trip.start_time).getTime();
  if (!Number.isFinite(start)) return false;
  const now = Date.now();
  if (dateFilter === 'this_month') return isSameMonth(trip.start_time);
  if (dateFilter === 'last_30') return start >= now - 30 * 86400000;
  if (dateFilter === 'last_90') return start >= now - 90 * 86400000;
  return true;
};

export default function TripHistory() {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('date_desc');
  const [dateFilter, setDateFilter] = useState('this_month');
  const [filterBy, setFilterBy] = useState('all');
  const [taggingId, setTaggingId] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const settings = localSettings.get();
  const units = settings.units || 'metric';
  const qc = useQueryClient();

  const { data: trips = [], isLoading } = useQuery({
    queryKey: ['all-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 1000 }),
  });

  const tagMut = useMutation({
    mutationFn: ({ id, tag }) => tripService.update(id, { tag }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['all-trips'] }); setTaggingId(null); },
  });

  const completed = trips.filter(t => t.status === 'completed');
  const dateScoped = completed.filter(t => matchesDateFilter(t, dateFilter));

  const filtered = dateScoped.filter(t => {
    if (filterBy === 'excellent' && (t.score_overall ?? 0) < 85) return false;
    if (filterBy === 'good' && ((t.score_overall ?? 0) < 70 || (t.score_overall ?? 0) >= 85)) return false;
    if (filterBy === 'fair' && ((t.score_overall ?? 0) < 55 || (t.score_overall ?? 0) >= 70)) return false;
    if (filterBy === 'poor' && (t.score_overall ?? 0) >= 55) return false;
    if (filterBy === 'night' && !t.night_driving) return false;
    if (filterBy === 'harsh_braking' && !(t.harsh_brakes_count > 0)) return false;
    if (filterBy === 'tag_work' && t.tag !== 'work') return false;
    if (filterBy === 'tag_personal' && t.tag !== 'personal') return false;
    if (filterBy === 'tag_errands' && t.tag !== 'errands') return false;
    if (search) {
      const q = search.toLowerCase();
      const matchAddr = (t.start_address || '').toLowerCase().includes(q) || (t.end_address || '').toLowerCase().includes(q);
      const matchDate = new Date(t.start_time).toLocaleDateString().includes(q);
      if (!matchAddr && !matchDate) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case 'date_desc': return new Date(b.start_time) - new Date(a.start_time);
      case 'date_asc': return new Date(a.start_time) - new Date(b.start_time);
      case 'score_desc': return (b.score_overall ?? 0) - (a.score_overall ?? 0);
      case 'score_asc': return (a.score_overall ?? 0) - (b.score_overall ?? 0);
      case 'distance_desc': return (b.distance_km ?? 0) - (a.distance_km ?? 0);
      case 'distance_asc': return (a.distance_km ?? 0) - (b.distance_km ?? 0);
      default: return 0;
    }
  });

  return (
    <div className="space-y-5 pb-4">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-grotesk font-bold">Trip History</h1>
        <p className="text-muted-foreground text-sm mt-1">{dateScoped.length} of {completed.length} completed trips shown by date</p>
      </motion.div>

      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search trips..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary transition-colors"
        />
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 thin-scrollbar">
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
            showFilters ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:border-primary/50'
          }`}
        >
          <Filter className="w-3.5 h-3.5" />
          Filter
        </button>

        <select
          value={dateFilter}
          onChange={e => setDateFilter(e.target.value)}
          className="flex-shrink-0 bg-card border border-border rounded-xl text-xs font-medium px-3 py-2 text-muted-foreground outline-none"
        >
          {DATE_FILTERS.map(o => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>

        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          className="flex-shrink-0 bg-card border border-border rounded-xl text-xs font-medium px-3 py-2 text-muted-foreground outline-none"
        >
          {SORT_OPTIONS.map(o => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>

        {FILTER_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => setFilterBy(opt.id)}
            className={`flex-shrink-0 px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
              filterBy === opt.id
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-muted-foreground border-border hover:border-primary/50'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-28 bg-secondary/50 rounded-2xl animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && sorted.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 bg-secondary rounded-3xl flex items-center justify-center mb-4">
            <Car className="w-8 h-8 text-muted-foreground" />
          </div>
          <div className="font-semibold mb-1">No trips found</div>
          <div className="text-muted-foreground text-sm">Try adjusting your month, search, or filters</div>
        </div>
      )}

      {!isLoading && (
        <div className="space-y-3">
          {sorted.map((trip, i) => (
            <div key={trip.id}>
              <TripCard trip={trip} units={units} index={i} />
              <div className="flex items-center gap-2 mt-1.5 px-1">
                {trip.tag ? (
                  <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
                    TAG_OPTIONS.find(t => t.id === trip.tag)?.color || 'bg-secondary text-muted-foreground border-border'
                  }`}>
                    {TAG_OPTIONS.find(t => t.id === trip.tag)?.label}
                  </span>
                ) : null}
                {taggingId === trip.id ? (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {TAG_OPTIONS.map(opt => (
                      <button key={opt.id}
                        onClick={() => tagMut.mutate({ id: trip.id, tag: opt.id })}
                        className={`text-xs px-2 py-0.5 rounded-full border font-medium transition-all hover:opacity-80 ${opt.color}`}>
                        {opt.label}
                      </button>
                    ))}
                    {trip.tag && (
                      <button onClick={() => tagMut.mutate({ id: trip.id, tag: null })}
                        className="text-xs px-2 py-0.5 rounded-full border border-border text-muted-foreground hover:bg-secondary">
                        Remove tag
                      </button>
                    )}
                    <button onClick={() => setTaggingId(null)} className="text-xs text-muted-foreground hover:underline">cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setTaggingId(trip.id)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
                    <Tag className="w-3 h-3" />
                    {trip.tag ? 'Change tag' : 'Add tag'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
