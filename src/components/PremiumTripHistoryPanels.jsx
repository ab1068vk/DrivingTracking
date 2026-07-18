// @ts-check
import {
  Activity,
  ArrowDownUp,
  BrainCircuit,
  CalendarDays,
  CarFront,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Search,
  Tag,
} from 'lucide-react';
import premiumHistoryMap from '@/assets/premium-history-map.png';
import premiumHistoryMetrics from '@/assets/premium-history-metrics.png';
import premiumHistoryResults from '@/assets/premium-history-results.png';

export const PREMIUM_HISTORY_PAGE_SIZE = 30;

export function getPremiumHistoryPageWindow(total, requestedPage, pageSize = PREMIUM_HISTORY_PAGE_SIZE) {
  const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
  const safePageSize = Math.max(1, Math.floor(Number(pageSize) || PREMIUM_HISTORY_PAGE_SIZE));
  const pageCount = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const page = Math.min(Math.max(0, Math.floor(Number(requestedPage) || 0)), pageCount - 1);
  const offset = page * safePageSize;

  return {
    page,
    pageCount,
    offset,
    start: safeTotal === 0 ? 0 : offset + 1,
    end: Math.min(safeTotal, offset + safePageSize),
  };
}

const DATE_FILTER_IDS = new Set(['this_week', 'this_month']);
const TRIP_FILTER_IDS = new Set(['all', 'best', 'worst', 'night', 'high_risk', 'favorites']);

export function PremiumHistorySearch({
  value,
  onChange,
  sortBy = 'date_desc',
  onSortChange = (_value) => {},
  filterBy = 'all',
  onFilterChange = (_value) => {},
  dateFilter = 'all',
  onDateFilterChange = (_value) => {},
  dateOptions = [],
  sortOptions = [],
  quickFilters = [],
  showFilters = false,
  onToggleFilters = () => {},
  expandedFilters = null,
}) {
  const legacyDateOptions = quickFilters.filter((option) => DATE_FILTER_IDS.has(option.id));
  const tripOptions = quickFilters.filter((option) => TRIP_FILTER_IDS.has(option.id));
  const effectiveDateOptions = dateOptions.length > 0 ? dateOptions : legacyDateOptions;
  const dateValue = dateOptions.length > 0 ? dateFilter : (DATE_FILTER_IDS.has(filterBy) ? filterBy : 'all');
  const tripValue = TRIP_FILTER_IDS.has(filterBy) ? filterBy : 'all';

  return (
    <section className="premium-history-filter" aria-label="Premium trip history search">
      <div className="premium-history-search-row">
        <span className="premium-history-search-emblem"><Search aria-hidden="true" /></span>
        <div className="premium-history-search-field">
          <Search aria-hidden="true" />
          <input
            type="text"
            aria-label="Search trip history"
            placeholder="Search place, month, date, distance, score…"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      </div>

      <div className="premium-history-filter-art" aria-hidden="true">
        <span className="premium-history-filter-gauge" style={{ backgroundImage: `url(${premiumHistoryMetrics})` }} />
        <span className="premium-history-filter-road" style={{ backgroundImage: `url(${premiumHistoryMetrics})` }} />
      </div>

      <div className="premium-history-search-guidance">
        <BrainCircuit aria-hidden="true" />
        <p>Combine terms in any order — for example a date, distance, score, place, tag, or vehicle name.</p>
      </div>

      <div className="premium-history-control-grid" role="group" aria-label="Premium trip history filters">
        <label className="premium-history-control">
          <span><CalendarDays aria-hidden="true" /> Date</span>
          <select aria-label="Filter trips by date" value={dateValue} onChange={(event) => (dateOptions.length > 0 ? onDateFilterChange(event.target.value) : onFilterChange(event.target.value))}>
            {!effectiveDateOptions.some((option) => option.id === 'all') && <option value="all">Any date</option>}
            {effectiveDateOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>

        <label className="premium-history-control">
          <span><CarFront aria-hidden="true" /> Trip type</span>
          <select aria-label="Filter trips by type" value={tripValue} onChange={(event) => onFilterChange(event.target.value)}>
            {tripOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>

        <label className="premium-history-control">
          <span><ArrowDownUp aria-hidden="true" /> Sort</span>
          <select aria-label="Sort trips" value={sortBy} onChange={(event) => onSortChange(event.target.value)}>
            {sortOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>

        <div className="premium-history-control premium-history-tags-control">
          <span><Tag aria-hidden="true" /> Tags &amp; saved</span>
          <button type="button" onClick={onToggleFilters} aria-expanded={showFilters}>
            <span>{showFilters ? 'Hide filters' : 'Open filters'}</span>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </div>

      {showFilters && expandedFilters}
    </section>
  );
}

export function PremiumFilteredSnapshot({ summary, filterLabel, tagLabel }) {
  const metrics = [
    { key: 'trips', label: 'Matching trips', value: String(summary.count), tone: 'route' },
    { key: 'distance', label: 'Matching distance', value: summary.totalDistanceLabel, tone: 'distance' },
    { key: 'duration', label: 'Drive time', value: summary.totalDurationLabel, tone: 'time' },
    { key: 'score', label: 'Avg score', value: summary.averageScoreLabel, tone: 'score' },
  ];

  return (
    <section aria-label="Filtered trip history snapshot" className="premium-history-snapshot">
      <img className="premium-history-map-art" src={premiumHistoryMap} alt="" aria-hidden="true" />
      <div className="premium-history-snapshot-head">
        <div>
          <h2><Activity aria-hidden="true" /> Filtered snapshot</h2>
          <p>All completed trips matching your current search and filters.</p>
        </div>
        <div className="premium-history-filter-tags" aria-label="Active filters">
          <span>{filterLabel === 'All Trips' ? 'Any date' : filterLabel}</span>
          {tagLabel !== 'All tags' && <span>{tagLabel}</span>}
        </div>
      </div>

      <div className="premium-history-metric-grid">
        {metrics.map(({ key, label, value, tone }) => (
          <div key={key} className="premium-history-metric" data-tone={tone}>
            <span
              className="premium-history-metric-icon"
              style={{ backgroundImage: `url(${premiumHistoryMetrics})` }}
              aria-hidden="true"
            />
            <div>
              <span>{label}</span>
              <strong title={value}>{value}</strong>
            </div>
          </div>
        ))}
      </div>

      {(summary.favoriteCount > 0 || summary.nightCount > 0) && (
        <p className="premium-history-snapshot-note">
          Includes {summary.favoriteCount} favorites and {summary.nightCount} night drives in the current view.
        </p>
      )}
    </section>
  );
}

export function PremiumHistoryResultsPager({ start, end, total, page, pageCount, onPrevious, onNext }) {
  return (
    <section className="premium-history-results" aria-label="Matching trip result pages">
      <img src={premiumHistoryResults} alt="" aria-hidden="true" />
      <div className="premium-history-results-copy">
        <span className="premium-history-results-icon"><Gauge aria-hidden="true" /></span>
        <p>
          Showing <strong>{start}–{end}</strong> of <strong>{total}</strong> matching {total === 1 ? 'trip' : 'trips'}
        </p>
      </div>
      <div className="premium-history-page-controls">
        <button type="button" onClick={onPrevious} disabled={page <= 0} aria-label="Show previous matching trips">
          <ChevronLeft aria-hidden="true" />
        </button>
        <span aria-label={`Page ${page + 1} of ${pageCount}`}>{page + 1} / {pageCount}</span>
        <button type="button" onClick={onNext} disabled={page >= pageCount - 1} aria-label="Show next matching trips">
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
