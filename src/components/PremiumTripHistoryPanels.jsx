// @ts-check
import {
  Activity,
  ArrowDownUp,
  BrainCircuit,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Route,
  Search,
  Tag,
} from 'lucide-react';
import premiumHistoryDate from '@/assets/premium-history-date-v2.jpg';
import premiumHistoryResults from '@/assets/premium-history-results.webp';
import premiumHistorySearchBmw from '@/assets/premium-history-search-bmw-v2.jpg';
import premiumHistorySnapshotDistance from '@/assets/premium-history-snapshot-distance-v3.webp';
import premiumHistorySnapshotHero from '@/assets/premium-history-snapshot-hero-v3.webp';
import premiumHistorySnapshotScore from '@/assets/premium-history-snapshot-score-v3.webp';
import premiumHistorySnapshotTime from '@/assets/premium-history-snapshot-time-v3.webp';
import premiumHistorySnapshotTrips from '@/assets/premium-history-snapshot-trips-v3.webp';
import premiumHistorySort from '@/assets/premium-history-sort-v2.jpg';
import premiumHistoryTags from '@/assets/premium-history-tags-v2.jpg';
import premiumHistoryTripType from '@/assets/premium-history-trip-type-v2.jpg';

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

export function getPremiumHistoryValueSize(value) {
  const length = String(value ?? '').trim().length;
  if (length >= 14) return 'long';
  if (length >= 9) return 'medium';
  return 'short';
}

export function buildPremiumHistorySparkline(values = [], width = 240, height = 96, padding = 8) {
  const scores = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .map((value) => Math.max(0, Math.min(100, value)));
  const drawableWidth = Math.max(1, width - (padding * 2));
  const drawableHeight = Math.max(1, height - (padding * 2));
  const points = scores.map((score, index) => {
    const x = scores.length <= 1
      ? width / 2
      : padding + ((index / (scores.length - 1)) * drawableWidth);
    const y = padding + (((100 - score) / 100) * drawableHeight);
    return { score, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
  });
  const path = points.length === 0
    ? ''
    : points.length === 1
      ? `M ${points[0].x} ${points[0].y}`
      : points.slice(0, -1).reduce((commands, point, index) => {
        const previousPoint = points[index - 1] ?? point;
        const nextPoint = points[index + 1];
        const followingPoint = points[index + 2] ?? nextPoint;
        const controlOneX = Number((point.x + ((nextPoint.x - previousPoint.x) / 6)).toFixed(2));
        const controlOneY = Number(Math.max(padding, Math.min(height - padding, point.y + ((nextPoint.y - previousPoint.y) / 6))).toFixed(2));
        const controlTwoX = Number((nextPoint.x - ((followingPoint.x - point.x) / 6)).toFixed(2));
        const controlTwoY = Number(Math.max(padding, Math.min(height - padding, nextPoint.y - ((followingPoint.y - point.y) / 6))).toFixed(2));
        return `${commands} C ${controlOneX} ${controlOneY} ${controlTwoX} ${controlTwoY} ${nextPoint.x} ${nextPoint.y}`;
      }, `M ${points[0].x} ${points[0].y}`);
  const start = points[0]?.score ?? null;
  const end = points.at(-1)?.score ?? null;
  const direction = start == null || end == null || Math.abs(end - start) < 1
    ? 'flat'
    : end > start ? 'up' : 'down';

  return { direction, end, path, points, start };
}

const HOUR_SECONDS = 60 * 60;

const formatTimeScaleMarker = (hours) => {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours >= 1000) return `${Number((hours / 1000).toFixed(hours % 1000 === 0 ? 0 : 1))}k h`;
  return `${Math.round(hours)}h`;
};

const getAdaptiveTimeScaleMaximum = (hours) => {
  if (hours <= 1) return 1;
  const targetHalfRange = (hours * 1.1) / 2;
  const exponent = Math.floor(Math.log10(targetHalfRange));
  const magnitude = 10 ** exponent;
  const normalized = targetHalfRange / magnitude;
  const steps = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
  const step = steps.find((candidate) => candidate >= normalized) ?? 10;
  return step * magnitude * 2;
};

export function getPremiumHistoryTimePresentation(totalDurationSeconds) {
  const seconds = Math.max(0, Number(totalDurationSeconds) || 0);
  const hours = seconds / HOUR_SECONDS;
  const band = hours > 100
    ? 'high-volume'
    : hours > 24
      ? 'multi-day'
      : hours > 5
        ? 'extended'
        : hours > 1
          ? 'hours'
          : 'minutes';
  const maximumHours = getAdaptiveTimeScaleMaximum(hours);
  const midpointHours = maximumHours / 2;
  const progress = Math.max(0, Math.min(1, hours / maximumHours));
  const maximumMarker = `${formatTimeScaleMarker(maximumHours)}+`;

  return {
    band,
    label: 'Adaptive drive-time scale',
    markers: [
      hours >= 1 ? '0h' : '0m',
      formatTimeScaleMarker(midpointHours),
      maximumMarker,
    ],
    progress,
    progressPercent: Number((progress * 100).toFixed(2)),
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
      <div className="premium-history-search-field">
        <img loading="lazy"
          className="premium-history-search-art"
          src={premiumHistorySearchBmw}
          alt=""
          aria-hidden="true"
          data-visual="bmw-mountain-road"
        />
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label="Search trip history"
          placeholder="Search place, month, date, distance, score…"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>

      <div className="premium-history-search-guidance">
        <BrainCircuit aria-hidden="true" />
        <p>Combine terms in any order—for example “July 14”, “20 km”, “score 85”, “night Toronto”, or a vehicle name.</p>
      </div>

      <div className="premium-history-control-grid" role="group" aria-label="Premium trip history filters">
        <label className="premium-history-control" data-control="date">
          <img loading="lazy" className="premium-history-control-art" src={premiumHistoryDate} alt="" aria-hidden="true" />
          <span className="premium-history-control-label"><CalendarDays aria-hidden="true" /> Date</span>
          <span className="premium-history-control-field">
            <select aria-label="Filter trips by date" value={dateValue} onChange={(event) => (dateOptions.length > 0 ? onDateFilterChange(event.target.value) : onFilterChange(event.target.value))}>
              {!effectiveDateOptions.some((option) => option.id === 'all') && <option value="all">Any date</option>}
              {effectiveDateOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            <ChevronDown aria-hidden="true" />
          </span>
        </label>

        <label className="premium-history-control" data-control="trip-type">
          <img loading="lazy" className="premium-history-control-art" src={premiumHistoryTripType} alt="" aria-hidden="true" />
          <span className="premium-history-control-label"><Route aria-hidden="true" /> Trip type</span>
          <span className="premium-history-control-field">
            <select aria-label="Filter trips by type" value={tripValue} onChange={(event) => onFilterChange(event.target.value)}>
              {tripOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            <ChevronDown aria-hidden="true" />
          </span>
        </label>

        <label className="premium-history-control" data-control="sort">
          <img loading="lazy" className="premium-history-control-art" src={premiumHistorySort} alt="" aria-hidden="true" />
          <span className="premium-history-control-label"><ArrowDownUp aria-hidden="true" /> Sort</span>
          <span className="premium-history-control-field">
            <select aria-label="Sort trips" value={sortBy} onChange={(event) => onSortChange(event.target.value)}>
              {sortOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            <ChevronDown aria-hidden="true" />
          </span>
        </label>

        <div className="premium-history-control premium-history-tags-control" data-control="tags">
          <img loading="lazy" className="premium-history-control-art" src={premiumHistoryTags} alt="" aria-hidden="true" />
          <span className="premium-history-control-label"><Tag aria-hidden="true" /> Tags &amp; saved</span>
          <button type="button" onClick={onToggleFilters} aria-expanded={showFilters}>
            <span>{showFilters ? 'Hide filters' : 'Tags & saved'}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        </div>
      </div>

      {showFilters && expandedFilters}
    </section>
  );
}

export function PremiumFilteredSnapshot({ summary, filterLabel, tagLabel }) {
  const scoreBand = summary.averageScore == null
    ? 'neutral'
    : summary.averageScore >= 80 ? 'strong'
      : summary.averageScore >= 60 ? 'steady'
        : 'attention';
  const scoreSparkline = buildPremiumHistorySparkline(summary.scoreTrend);
  const timePresentation = getPremiumHistoryTimePresentation(summary.totalDurationSeconds);
  const metrics = [
    {
      art: premiumHistorySnapshotTrips,
      key: 'trips',
      label: 'Matching trips',
      value: String(summary.count),
      tone: 'route',
    },
    {
      art: premiumHistorySnapshotDistance,
      key: 'distance',
      label: 'Matching distance',
      value: summary.totalDistanceLabel,
      tone: 'distance',
    },
    {
      art: premiumHistorySnapshotTime,
      key: 'duration',
      label: 'Drive time',
      value: summary.totalDurationLabel,
      tone: 'time',
    },
    {
      art: premiumHistorySnapshotScore,
      key: 'score',
      label: 'Avg score',
      value: summary.averageScoreLabel,
      tone: 'score',
    },
  ];

  return (
    <section
      aria-label="Filtered trip history snapshot"
      className="premium-history-snapshot premium-history-snapshot-v3"
    >
      <div className="premium-history-snapshot-hero">
        <img loading="lazy"
          className="premium-history-snapshot-hero-art"
          src={premiumHistorySnapshotHero}
          alt=""
          aria-hidden="true"
        />
        <div className="premium-history-snapshot-head">
          <h2>
            <span className="premium-history-snapshot-emblem"><Activity aria-hidden="true" /></span>
            Filtered snapshot
          </h2>
          <p>All completed trips matching your current search and filters.</p>
          <div className="premium-history-filter-tags" aria-label="Active filters">
            <span><CalendarDays aria-hidden="true" /> {filterLabel === 'All Trips' ? 'Any date' : filterLabel}</span>
            {tagLabel !== 'All tags' && <span><Tag aria-hidden="true" /> {tagLabel}</span>}
          </div>
        </div>
      </div>

      <div className="premium-history-metric-grid">
        {metrics.map(({ art, key, label, value, tone }) => (
          <article
            key={key}
            className="premium-history-metric"
            data-score-band={key === 'score' ? scoreBand : undefined}
            data-time-band={key === 'duration' ? timePresentation.band : undefined}
            data-tone={tone}
          >
            <img loading="lazy"
              className="premium-history-metric-art"
              src={art}
              alt=""
              aria-hidden="true"
              decoding="async"
            />
            <div className="premium-history-metric-shade" aria-hidden="true" />
            <div className="premium-history-metric-copy">
              <span>{label}</span>
              <strong data-value-size={getPremiumHistoryValueSize(value)} title={value}>{value}</strong>
            </div>
            {key === 'duration' && (
              <div
                className="premium-history-time-scale"
                role="img"
                aria-label={`${timePresentation.label}: ${timePresentation.markers.join(', ')}`}
              >
                <span className="premium-history-time-scale-label">{timePresentation.label}</span>
                <span className="premium-history-time-scale-track" aria-hidden="true">
                  <span style={{ width: `${timePresentation.progressPercent}%` }} />
                  <i style={{ left: `${timePresentation.progressPercent}%` }} />
                </span>
                <span className="premium-history-time-scale-markers" aria-hidden="true">
                  {timePresentation.markers.map((marker) => <small key={marker}>{marker}</small>)}
                </span>
              </div>
            )}
            {key === 'score' && scoreSparkline.points.length > 0 && (
              <svg
                className="premium-history-score-trend"
                data-direction={scoreSparkline.direction}
                viewBox="0 0 240 96"
                role="img"
                aria-label={`Average score trend from ${scoreSparkline.start} to ${scoreSparkline.end} across ${scoreSparkline.points.length} scored ${scoreSparkline.points.length === 1 ? 'trip' : 'trips'}`}
                preserveAspectRatio="none"
              >
                <title>Filtered trip score trend</title>
                <defs>
                  <linearGradient id="premium-history-score-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {scoreSparkline.points.length > 1 && (
                  <>
                    <path
                      className="premium-history-score-area"
                      d={`${scoreSparkline.path} L ${scoreSparkline.points.at(-1).x} 96 L ${scoreSparkline.points[0].x} 96 Z`}
                    />
                    <path className="premium-history-score-glow" d={scoreSparkline.path} />
                    <path className="premium-history-score-line" d={scoreSparkline.path} />
                  </>
                )}
                {scoreSparkline.points.map((point, index) => (
                  <g key={`${point.x}-${point.y}-${index}`}>
                    <circle
                      className="premium-history-score-point-glow"
                      cx={point.x}
                      cy={point.y}
                      r={index === scoreSparkline.points.length - 1 ? 11 : 9}
                    />
                    <circle
                      className="premium-history-score-point"
                      cx={point.x}
                      cy={point.y}
                      r={index === scoreSparkline.points.length - 1 ? 6.5 : 5}
                    />
                  </g>
                ))}
              </svg>
            )}
          </article>
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
      <img loading="lazy" src={premiumHistoryResults} alt="" aria-hidden="true" />
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
