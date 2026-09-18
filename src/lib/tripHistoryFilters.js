/**
 * The named, budgeted Q1 filters the history pages already expose (P7 Stage 4).
 *
 * `status` and the `start_time` **range** are served by the existing
 * `by_start_time_id` / `by_status_start_time_id` indexes. Everything else is a
 * **named budgeted bounded scan** (Annex A §A2.7): the filter is registered
 * here by name, evaluated on the rows one Q1 page delivers, and a page that
 * cannot fill `k` matches inside that budget comes back `PARTIAL` with a real
 * continuation — never a short page presented as complete.
 *
 * The registry is deliberately populated by the stage that migrates a page, so
 * the vocabulary is exactly what a page's existing UI already filters on and
 * nothing is invented ahead of a product need. Q1 accepts **no** caller-supplied
 * callback: a name, and only a name.
 */

import { P7_NAMED_FILTERS, registerP7NamedFilter } from '@/lib/localTripRepository';
import { getTripComponentScore } from '@/lib/tripEngine';
import { isHighRiskTrip, normalizeTripTags } from '@/lib/tripMetadata';

const scoreValue = (trip) => getTripComponentScore(trip, 'overall').value;

/**
 * The quick-filter predicate, byte-for-byte the page's existing semantics:
 * best >= 85, worst < 60, night by flag or tag, high risk, favourites.
 */
export const matchesQuickFilterValue = (row, filter) => {
  if (filter === 'best') return (scoreValue(row) ?? Number.NEGATIVE_INFINITY) >= 85;
  if (filter === 'worst') return (scoreValue(row) ?? Number.POSITIVE_INFINITY) < 60;
  if (filter === 'night') return row.night_driving || normalizeTripTags(row).includes('night');
  if (filter === 'high_risk') return isHighRiskTrip(row);
  if (filter === 'favorites') return row.is_favorite === true;
  return true;
};

/** The tag predicate, with the page's existing `all` / `any` modes. */
export const matchesTagFilterValue = (row, value) => {
  const selected = Array.isArray(value?.tags) ? value.tags.filter(Boolean) : [];
  if (!selected.length) return true;
  const rowTags = new Set(normalizeTripTags(row));
  return value?.mode === 'any'
    ? selected.some((tag) => rowTags.has(tag))
    : selected.every((tag) => rowTags.has(tag));
};

/** Registered names. A key outside this set is `FILTER_UNSUPPORTED`, by design. */
export const TRIP_HISTORY_FILTER_NAMES = Object.freeze(['quickFilter', 'tripTags']);

const PREDICATES = Object.freeze({
  quickFilter: matchesQuickFilterValue,
  tripTags: matchesTagFilterValue,
});

/**
 * Register the history filter vocabulary.
 *
 * Idempotence is decided by **the registry itself**, not by a module flag that
 * merely remembers having registered once. A flag would go on claiming the
 * names are present after something emptied the registry, and the next query
 * would be refused `FILTER_UNSUPPORTED` for a filter this module owns.
 */
export function registerTripHistoryFilters() {
  for (const [name, predicate] of Object.entries(PREDICATES)) {
    if (P7_NAMED_FILTERS.has(name)) continue;
    registerP7NamedFilter(name, predicate);
  }
  return TRIP_HISTORY_FILTER_NAMES;
}

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

const parseLocalDate = (value) => {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date : null;
};

/**
 * Translate the page's date filter into an **index-served** `[from, to)` range.
 *
 * The boundaries are the page's existing local-day boundaries, so the rows a
 * window contains do not change: this moves the same predicate from a post-fetch
 * filter onto the index, it does not redefine the window.
 *
 * `null` means "no range" — the whole history in cursor order.
 *
 * @param {string} filter @param {string} dateFrom @param {string} dateTo
 * @returns {{fromMs: number|null, toMs: number|null} | null}
 */
export function tripHistoryDateRange(filter = 'all', dateFrom = '', dateTo = '') {
  const today = startOfToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const daysAgo = (days) => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.getTime();
  };

  if (filter === 'today') return { fromMs: today.getTime(), toMs: tomorrow.getTime() };
  if (filter === 'last_7') return { fromMs: daysAgo(6), toMs: tomorrow.getTime() };
  if (filter === 'last_30') return { fromMs: daysAgo(29), toMs: tomorrow.getTime() };
  if (filter === 'this_month') {
    const month = startOfToday();
    month.setDate(1);
    return { fromMs: month.getTime(), toMs: tomorrow.getTime() };
  }
  if (filter === 'exact_day') {
    const exact = parseLocalDate(dateFrom);
    if (!exact) return null;
    const from = exact.getTime();
    exact.setDate(exact.getDate() + 1);
    return { fromMs: from, toMs: exact.getTime() };
  }
  if (filter === 'custom') {
    const from = parseLocalDate(dateFrom)?.getTime() ?? null;
    const toDate = parseLocalDate(dateTo);
    let toMs = null;
    if (toDate) {
      toDate.setDate(toDate.getDate() + 1);
      toMs = toDate.getTime();
    }
    if (from == null && toMs == null) return null;
    return { fromMs: from, toMs };
  }
  return null;
}

/**
 * Build the Q1 filter object from the page's controls.
 *
 * Only names in the registry are emitted, and an inactive control emits nothing
 * so it never enters the cursor's filter identity.
 */
export function tripHistoryFilterObject({ quickFilter = 'all', selectedTags = [], tagMatchMode = 'all' } = {}) {
  const filter = {};
  if (quickFilter && quickFilter !== 'all') filter.quickFilter = quickFilter;
  const tags = Array.isArray(selectedTags) ? selectedTags.filter(Boolean) : [];
  if (tags.length) filter.tripTags = { tags: [...tags].sort(), mode: tagMatchMode === 'any' ? 'any' : 'all' };
  return filter;
}

/** Chronological sorts Q1 serves from the index. Anything else is a page-local ordering. */
export const CHRONOLOGICAL_SORTS = Object.freeze({
  date_desc: '-start_time',
  date_asc: 'start_time',
});

/**
 * The Q1 sort for a page sort control.
 *
 * A score or distance ordering is **not** index-served. The page keeps scanning
 * in cursor order and orders what it has accumulated, which is why such a view
 * stays `PARTIAL` until the scan reaches the end of the range — ordering a
 * partial scan and calling it "the best trips" is the false-total this phase
 * exists to remove.
 */
export const q1SortFor = (sortBy) => CHRONOLOGICAL_SORTS[sortBy] ?? '-start_time';

export const isChronologicalSort = (sortBy) => Object.hasOwn(CHRONOLOGICAL_SORTS, sortBy ?? '');
