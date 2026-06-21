import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Gauge, MapPin, RefreshCw, ShieldCheck } from 'lucide-react';
import RoadSectionPreview from '@/components/RoadSectionPreview';
import { LocalSpeedKnowledge, geohashCenter, geohashEncode } from '@/lib/localSpeedKnowledge';
import { buildTripSpeedLimitReviewCells } from '@/lib/speedLimitReview';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { getPrivacyZones } from '@/lib/privacyZones';
import { refreshTripsCrossingLocalSpeedCell } from '@/lib/localSpeedScoreRefresh';
import { speedLimitScorePreview, speedLimitSourceBadgeClass, speedLimitSourceLabel } from '@/lib/speedLimitDisplay';
import { assessSpeedLimitEvidence, speedLimitConfidenceLabel } from '@/lib/speedLimitConfidence';
import {
  buildSpeedLimitRecommendation,
  sortSpeedLimitReviewItems,
  speedLimitReviewPriority,
} from '@/lib/speedLimitIntelligence';
import useLocalSettings from '@/hooks/useLocalSettings';

const sourceLabel = (source) => speedLimitSourceLabel(source);
const COMMON_SPEED_LIMITS_KMH = [30, 40, 50, 60, 70, 80, 100];
const REVIEW_FILTERS = [
  ['all', 'All'],
  ['conflicts', 'Conflicts'],
  ['missing', 'Missing posted data'],
  ['estimated', 'Estimated'],
  ['saved', 'Already saved'],
];

function SpeedLimitQuickPicks({ value, onPick }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {COMMON_SPEED_LIMITS_KMH.map((limit) => (
        <button
          key={limit}
          type="button"
          onClick={() => onPick(String(limit))}
          className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${
            Number(value) === limit
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-secondary/80 text-foreground hover:bg-secondary'
          }`}
        >
          {limit}
        </button>
      ))}
    </div>
  );
}

const formatLimit = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? `${Math.round(number)} km/h` : 'Unknown';
};

const formatDate = (value) => {
  if (value == null || value === '') return 'Unknown time';
  const date = new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) && time > 0 ? date.toLocaleString() : 'Unknown time';
};

const sortedNumbers = (values = []) => [...new Set(values
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value) && value > 0)
  .map((value) => Math.round(value)))]
  .sort((a, b) => a - b);

const sortedStrings = (values = []) => [...new Set(values
  .map((value) => String(value || '').trim())
  .filter(Boolean))]
  .sort((a, b) => a.localeCompare(b));

const mostCommonNumber = (values = []) => {
  const counts = new Map();
  for (const value of values) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) continue;
    const rounded = Math.round(number);
    counts.set(rounded, (counts.get(rounded) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? '';
};

const formatLimitList = (values = []) => {
  const limits = sortedNumbers(values);
  return limits.length ? `${limits.join(', ')} km/h` : 'Unknown';
};

const formatSourceList = (values = []) => {
  const sources = sortedStrings(values);
  return sources.length ? sources.map(sourceLabel).join(', ') : 'Unknown source';
};

const primaryRoadLabel = (roads = [], geohash = '') => {
  const [road] = sortedStrings(roads);
  return road || `Unlabeled driven segment ${String(geohash || '').slice(0, 6)}`;
};

const reviewGroupKey = (cell = {}) => {
  const roads = sortedStrings(cell.roads);
  if (roads.length) return `road:${roads.join('|').toLowerCase()}`;
  return `area:${String(cell.geohash || '').slice(0, 5)}`;
};

function isPublicReviewPoint(point = {}) {
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  return Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    point.privacy_export_placeholder !== true &&
    point.masked_for_privacy !== true &&
    point.privacy_gap !== true &&
    point.privacy_live_redacted !== true;
}

const buildReviewGroups = (items = []) => {
  const groups = new Map();
  for (const cell of items.filter((item) => item?.tripReview && !item?.existingLocalCorrection)) {
    const key = reviewGroupKey(cell);
    const existing = groups.get(key) || {
      key,
      label: primaryRoadLabel(cell.roads, cell.geohash),
      cells: [],
      sampleCount: 0,
      limits: [],
      sources: [],
      roads: new Set(),
    };
    existing.cells.push(cell);
    existing.sampleCount += Number(cell.sampleCount) || 0;
    existing.limits.push(...(cell.limits || []), cell.limitKmh, cell.suggestedLimitKmh);
    existing.sources.push(...(cell.sources || []), cell.source);
    for (const road of cell.roads || []) existing.roads.add(road);
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      roads: [...group.roads],
      limits: sortedNumbers(group.limits),
      sources: sortedStrings(group.sources),
      suggestedLimitKmh: mostCommonNumber(group.limits),
    }))
    .sort((a, b) => b.sampleCount - a.sampleCount || a.label.localeCompare(b.label));
};

function pointSource(point = {}) {
  return point.speed_limit_source ?? point.limitSource ?? point.speedLimitSource ?? point.source ?? null;
}

function pointLimit(point = {}) {
  const limit = Number(point.speed_limit_kmh ?? point.limitKmh ?? point.speedLimitKmh);
  return Number.isFinite(limit) && limit > 0 ? Math.round(limit) : null;
}

function buildTripRoadStatusRows(trip = null, reviewCells = []) {
  const points = Array.isArray(trip?.route_points) ? trip.route_points.filter(isPublicReviewPoint) : [];
  if (!points.length) return [];

  const reviewGeohashes = new Set(reviewCells
    .filter((cell) => cell?.tripReview && !cell?.existingLocalCorrection)
    .map((cell) => cell.geohash));
  const savedByGeohash = new Map(reviewCells
    .filter((cell) => cell?.existingLocalCorrection)
    .map((cell) => [cell.geohash, cell]));
  const groups = new Map();
  for (const point of points) {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const geohash = geohashEncode(lat, lng);
    const road = String(point.speed_limit_road_name || '').trim();
    const key = road ? `road:${road.toLowerCase()}` : `area:${geohash.slice(0, 5)}`;
    const group = groups.get(key) || {
      key,
      label: road || `Unlabeled driven segment ${geohash.slice(0, 6)}`,
      sampleCount: 0,
      geohashes: new Set(),
      limits: [],
      sources: [],
      reviewCount: 0,
    };
    group.sampleCount += 1;
    group.geohashes.add(geohash);
    const limit = pointLimit(point);
    if (limit != null) group.limits.push(limit);
    const source = pointSource(point);
    if (source) group.sources.push(source);
    const saved = savedByGeohash.get(geohash);
    if (saved) {
      const savedLimit = Number(saved.limitKmh ?? saved.suggestedLimitKmh);
      if (Number.isFinite(savedLimit) && savedLimit > 0) group.limits.push(savedLimit);
      if (saved.source) group.sources.push(saved.source);
    }
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const sources = sortedStrings(group.sources);
      const limits = sortedNumbers(group.limits);
      const reviewCount = [...group.geohashes].filter((geohash) => reviewGeohashes.has(geohash)).length;
      const hasPosted = sources.some((source) => source === 'openstreetmap' || source === 'user_confirmed_posted_sign');
      const hasEstimated = sources.some((source) => !['openstreetmap', 'user_confirmed_posted_sign'].includes(source));
      const status = reviewCount > 0
        ? 'Needs parked review'
        : hasPosted
          ? 'Posted data'
          : hasEstimated
            ? 'Estimated only'
            : 'No speed data';
      return {
        ...group,
        geohashes: [...group.geohashes],
        limits,
        sources,
        reviewCount,
        status,
      };
    })
    .sort((a, b) => {
      if (a.reviewCount && !b.reviewCount) return -1;
      if (!a.reviewCount && b.reviewCount) return 1;
      return b.sampleCount - a.sampleCount || a.label.localeCompare(b.label);
    });
}

function routeEvidenceForCell(trip, geohash) {
  const points = Array.isArray(trip?.route_points) ? trip.route_points.filter(isPublicReviewPoint) : [];
  const matches = points.filter((point) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && geohashEncode(lat, lng) === geohash;
  });
  if (!matches.length) return null;

  const limits = [...new Set(matches
    .map((point) => Number(point.speed_limit_kmh))
    .filter((value) => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
  const sources = [...new Set(matches.map((point) => point.speed_limit_source).filter(Boolean))];
  const roads = [...new Set(matches.map((point) => point.speed_limit_road_name).filter(Boolean))].slice(0, 3);

  return {
    sampleCount: matches.length,
    limits,
    sources,
    roads,
  };
}

function buildRouteEvidenceByGeohash(trip = null) {
  const points = Array.isArray(trip?.route_points) ? trip.route_points.filter(isPublicReviewPoint) : [];
  const groups = new Map();
  for (const point of points) {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const geohash = geohashEncode(lat, lng);
    const group = groups.get(geohash) || {
      sampleCount: 0,
      limits: new Set(),
      sources: new Set(),
      roads: new Set(),
    };
    group.sampleCount += 1;
    const limit = Number(point.speed_limit_kmh);
    if (Number.isFinite(limit) && limit > 0) group.limits.add(limit);
    if (point.speed_limit_source) group.sources.add(point.speed_limit_source);
    if (point.speed_limit_road_name) group.roads.add(point.speed_limit_road_name);
    groups.set(geohash, group);
  }

  return new Map([...groups.entries()].map(([geohash, group]) => [
    geohash,
    {
      sampleCount: group.sampleCount,
      limits: [...group.limits].sort((a, b) => a - b),
      sources: [...group.sources],
      roads: [...group.roads].slice(0, 3),
    },
  ]));
}

function reviewCellCategory(cell = {}) {
  if (!cell.tripReview) return 'conflicts';
  if (cell.existingLocalCorrection) return 'saved';
  if (cell.source === 'missing_posted_review' || !cell.limits?.length) return 'missing';
  return 'estimated';
}

function summarizeReviewCells(items = []) {
  return (items || []).reduce((summary, cell) => {
    const category = reviewCellCategory(cell);
    summary.total += 1;
    summary[category] += 1;
    if (!cell.existingLocalCorrection) summary.blocking += 1;
    return summary;
  }, {
    total: 0,
    conflicts: 0,
    missing: 0,
    estimated: 0,
    saved: 0,
    blocking: 0,
  });
}

function filterReviewCells(items = [], filter = 'all') {
  if (filter === 'all') return items;
  return items.filter((cell) => reviewCellCategory(cell) === filter);
}

function sortReviewCells(items = []) {
  return sortSpeedLimitReviewItems(items, (item) => ({
    affectedTripCount: item.tripReview ? 1 : 0,
  }));
}

function countBlockingReviewCells(items = []) {
  return items.filter((cell) => !cell?.existingLocalCorrection).length;
}

function captureScrollRestorer() {
  if (typeof window === 'undefined') return () => {};
  const top = window.scrollY;
  const left = window.scrollX;
  return () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.scrollTo({ top, left, behavior: 'auto' });
      });
    });
  };
}

export default function SpeedLimitConflictReview({ trip = null, reviewMode = false, onResolved = null }) {
  const [cells, setCells] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyGeohash, setBusyGeohash] = useState(null);
  const [status, setStatus] = useState('');
  const cellsRef = useRef([]);
  const onResolvedRef = useRef(onResolved);
  const reportedCompleteKeyRef = useRef(null);
  const [expandedPreviewKeys, setExpandedPreviewKeys] = useState(() => new Set());
  const [reviewFilter, setReviewFilter] = useState('all');
  const settings = useLocalSettings();

  const knowledge = useMemo(() => new LocalSpeedKnowledge(speedKnowledgeStore), []);
  const privacyZones = useMemo(() => getPrivacyZones(settings), [settings]);
  const routeEvidenceByGeohash = useMemo(() => buildRouteEvidenceByGeohash(trip), [trip]);

  useEffect(() => {
    onResolvedRef.current = onResolved;
  }, [onResolved]);

  const loadConflicts = useCallback(async ({ notifyComplete = false, preserveContent = false } = {}) => {
    const showBlockingLoading = !preserveContent || cellsRef.current.length === 0;
    if (showBlockingLoading) setLoading(true);
    const conflicted = await knowledge.getConflictedCells().catch(() => []);
    const conflictedGeohashes = new Set(conflicted.map((cell) => cell.geohash));
    let tripReviewCells = [];
    if (reviewMode && trip) {
      const reviewCells = buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity })
        .filter((cell) => !conflictedGeohashes.has(cell.geohash));
      const existingCorrections = await knowledge.getForPoints(reviewCells).catch(() => (
        Promise.all(reviewCells.map((cell) => knowledge.getForPoint(cell.lat, cell.lng).catch(() => null)))
      ));
      tripReviewCells = reviewCells.map((cell, index) => {
        const existing = existingCorrections[index];
        return existing?.source
          ? {
            ...cell,
            limitKmh: Number(existing.limitKmh) || cell.limitKmh,
            suggestedLimitKmh: Number(existing.limitKmh) || cell.suggestedLimitKmh,
            source: existing.source,
            sources: [...new Set([...(cell.sources || []), existing.source])],
            existingLocalCorrection: true,
            reviewReason: 'A saved local speed exists here. Update it only if the posted speed changed.',
          }
          : cell;
      });
    }
    const nextCells = [
      ...conflicted.map((cell) => ({ ...cell, tripReview: false })),
      ...tripReviewCells.filter(Boolean),
    ];
    cellsRef.current = nextCells;
    setCells(nextCells);
    setDrafts((current) => {
      const next = { ...current };
      for (const cell of nextCells) {
        const suggested = cell.conflictDetails?.newLimitKmh ?? cell.suggestedLimitKmh ?? cell.limitKmh ?? cell.conflictDetails?.existingLimitKmh ?? '';
        if (next[cell.geohash] == null) next[cell.geohash] = String(suggested || '');
      }
      for (const group of buildReviewGroups(nextCells)) {
        if (next[group.key] == null) next[group.key] = String(group.suggestedLimitKmh || '');
      }
      return next;
    });
    setLoading(false);
    const remainingCount = countBlockingReviewCells(nextCells);
    if (remainingCount > 0) {
      reportedCompleteKeyRef.current = null;
    }
    if (notifyComplete && reviewMode && trip?.id && trip.speed_limit_review_required === true && remainingCount === 0) {
      const completeKey = String(trip.id);
      if (reportedCompleteKeyRef.current !== completeKey) {
        reportedCompleteKeyRef.current = completeKey;
        onResolvedRef.current?.({
          remainingCount: 0,
          tripReviewComplete: true,
        });
      }
    }
    return nextCells;
  }, [knowledge, reviewMode, trip]);

  useEffect(() => {
    loadConflicts({ notifyComplete: true, preserveContent: true });
  }, [loadConflicts]);

  useEffect(() => {
    cellsRef.current = cells;
  }, [cells]);

  const reviewGroups = useMemo(() => buildReviewGroups(cells), [cells]);
  const roadStatusRows = useMemo(() => buildTripRoadStatusRows(trip, cells), [trip, cells]);
  const reviewStats = useMemo(() => summarizeReviewCells(cells), [cells]);
  const visibleCells = useMemo(() => sortReviewCells(filterReviewCells(cells, reviewFilter)), [cells, reviewFilter]);

  const togglePreview = (key) => {
    setExpandedPreviewKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!reviewMode && !loading && cells.length === 0) return null;

  const saveCellLimit = async (cell, source, limitKmh, historyGroup) => {
    const note = source === 'user_confirmed_posted_sign'
      ? 'Resolved from parked posted-sign review'
      : 'Resolved from parked user estimate review';
    const center = geohashCenter(cell.geohash);
    return cell.tripReview
      ? knowledge.saveUserCorrection(
        cell.lat ?? center.lat,
        cell.lng ?? center.lng,
        Math.round(limitKmh),
        note,
        null,
        privacyZones,
        source,
        {
          roadName: cell.roadName || cell.roads?.[0] || '',
          contextLabel: cell.contextLabel || '',
          directionLabel: cell.directionLabel || '',
          timeLabel: cell.timeLabel || '',
          distanceM: cell.distanceM || 0,
          sectionPoints: cell.sectionPoints || [],
          historyGroup,
        }
      ).catch(() => false)
      : knowledge.resolveConflict(
        cell.geohash,
        Math.round(limitKmh),
        source,
        note,
        { historyGroup }
      ).catch(() => false);
  };

  const resolveCells = async (targetCells, source, draftKey) => {
    const limitKmh = Number(drafts[draftKey]);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0) {
      setStatus('Enter a valid speed limit before saving.');
      return;
    }
    const restoreScroll = captureScrollRestorer();
    setBusyGeohash(draftKey);
    const uniqueCells = [...new Map(targetCells.map((cell) => [cell.geohash, cell])).values()];
    const historyGroup = `review-${draftKey}-${Date.now()}`;
    const results = await Promise.all(uniqueCells.map((cell) => saveCellLimit(cell, source, limitKmh, historyGroup)));
    const savedCount = results.filter(Boolean).length;
    if (savedCount) {
      const savedGeohashes = new Set(uniqueCells
        .filter((_, index) => results[index])
        .map((cell) => cell.geohash));
      setCells((current) => current.filter((cell) => !savedGeohashes.has(cell.geohash)));
      const label = savedCount === 1 ? 'road area' : 'road areas';
      setStatus(source === 'user_confirmed_posted_sign'
        ? `Saved as a posted-sign confirmation for future speed checks. Updated ${savedCount} ${label}; matching trip scores are updating in the background.`
        : `Saved as a local estimate. Updated ${savedCount} ${label}; matching trip scores are updating in the background.`);
      setBusyGeohash(null);
      const remainingCount = countBlockingReviewCells(
        cells.filter((cell) => !savedGeohashes.has(cell.geohash))
      );
      onResolvedRef.current?.({
        geohash: uniqueCells[0]?.geohash,
        source,
        remainingCount,
        tripReviewComplete: Boolean(trip?.id) && remainingCount === 0,
      });
      restoreScroll();
      void (async () => {
        if (!trip?.id) {
          await Promise.all(uniqueCells
            .filter((_, index) => results[index])
            .map((cell) => refreshTripsCrossingLocalSpeedCell(cell.geohash).catch(() => null)));
        }
        await loadConflicts({ preserveContent: true });
      })();
    } else {
      setStatus('Could not save that speed-limit review.');
      setBusyGeohash(null);
    }
  };

  return (
    <section id="speed-limit-conflicts" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div>
            <h2 className="text-sm font-semibold">Speed-limit conflict review</h2>
            <p className="mt-1 text-xs opacity-85">
              Review every trip road area that lacks posted-speed evidence. Save a posted sign only when you saw one while parked or after the trip. Saved values stay local and are used for future trips near the same road area.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => loadConflicts()}
          disabled={loading}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-amber-300 bg-background/70 px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-background disabled:opacity-60 dark:border-amber-800 dark:text-amber-100"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {status && (
        <div className="mt-3 rounded-xl bg-background/70 px-3 py-2 text-xs font-medium">
          {status}
        </div>
      )}

      {cells.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-amber-200 bg-background/70 px-3 py-2 dark:border-amber-900/60">
              <div className="text-[11px] font-semibold uppercase text-muted-foreground">Open items</div>
              <div className="mt-1 text-xl font-bold">{reviewStats.blocking}</div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-background/70 px-3 py-2 dark:border-amber-900/60">
              <div className="text-[11px] font-semibold uppercase text-muted-foreground">Conflicts</div>
              <div className="mt-1 text-xl font-bold text-red-600">{reviewStats.conflicts}</div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-background/70 px-3 py-2 dark:border-amber-900/60">
              <div className="text-[11px] font-semibold uppercase text-muted-foreground">Missing posted</div>
              <div className="mt-1 text-xl font-bold">{reviewStats.missing}</div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-background/70 px-3 py-2 dark:border-amber-900/60">
              <div className="text-[11px] font-semibold uppercase text-muted-foreground">Estimated</div>
              <div className="mt-1 text-xl font-bold">{reviewStats.estimated}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {REVIEW_FILTERS.map(([value, label]) => {
              const count = value === 'all' ? reviewStats.total : reviewStats[value];
              const active = reviewFilter === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setReviewFilter(value)}
                  className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                    active
                      ? 'border-amber-500 bg-amber-100 text-amber-950 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-100'
                      : 'border-amber-200 bg-background/70 text-amber-900 hover:bg-background dark:border-amber-900/60 dark:text-amber-100'
                  }`}
                >
                  {label} {count}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="mt-3 rounded-xl bg-background/60 p-3 text-xs">Loading conflicted cells...</div>
      ) : cells.length === 0 ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          <CheckCircle2 className="h-4 w-4" />
          All local speed-limit conflicts are resolved.
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {roadStatusRows.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-background/80 p-3 shadow-sm dark:border-amber-900/60 dark:bg-background/70">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold">Road speed coverage</h3>
                  <p className="text-xs text-muted-foreground">
                    This shows which roads already have posted data and which still need parked confirmation.
                  </p>
                </div>
                <span className="text-xs font-semibold text-amber-900 dark:text-amber-100">
                  {roadStatusRows.filter((row) => row.reviewCount > 0).length} road{roadStatusRows.filter((row) => row.reviewCount > 0).length === 1 ? '' : 's'} need review
                </span>
              </div>
              <div className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-background/60">
                {roadStatusRows.map((row) => (
                  <div key={row.key} className="grid gap-2 px-3 py-2 text-xs sm:grid-cols-[1.2fr_0.8fr_0.8fr] sm:items-center">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-foreground">{row.label}</div>
                      <div className="text-muted-foreground">{row.sampleCount} route sample{row.sampleCount === 1 ? '' : 's'}</div>
                    </div>
                    <div className="text-muted-foreground">
                      <span className={`inline-flex rounded-full px-2 py-0.5 font-semibold ${
                        row.reviewCount > 0
                          ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100'
                          : row.status === 'Posted data'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                            : 'bg-secondary text-muted-foreground'
                      }`}>
                        {row.status}
                      </span>
                    </div>
                    <div className="min-w-0 text-muted-foreground sm:text-right">
                      <div>{formatLimitList(row.limits)}</div>
                      <div className="truncate">{formatSourceList(row.sources)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {reviewGroups.length > 1 && (
            <div className="rounded-xl border border-amber-200 bg-background/80 p-3 shadow-sm dark:border-amber-900/60 dark:bg-background/70">
              <h3 className="text-sm font-semibold">Save by road</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                This applies one value to every listed area on that road. Inspect the highlighted sections below before using a bulk save.
              </p>
              <div className="mt-3 space-y-2">
                {reviewGroups.map((group) => {
                  const disabled = busyGeohash === group.key;
                  return (
                    <div key={group.key} className="grid gap-2 rounded-lg border border-border bg-secondary/30 p-2 text-xs lg:grid-cols-[1fr_13rem_15rem] lg:items-center">
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-foreground">{group.label}</div>
                        <div className="text-muted-foreground">
                          Applies to {group.cells.length} highlighted area{group.cells.length === 1 ? '' : 's'}; {group.sampleCount} route sample{group.sampleCount === 1 ? '' : 's'}; sources {formatSourceList(group.sources)}
                        </div>
                        <div className="mt-1 text-[11px] font-medium text-amber-800 dark:text-amber-100">
                          {speedLimitScorePreview(group.suggestedLimitKmh, drafts[group.key])}
                        </div>
                      </div>
                      <div className="grid gap-1.5">
                        <label className="flex items-center gap-2 font-semibold text-foreground">
                          <Gauge className="h-4 w-4 text-muted-foreground" />
                          <input
                            type="number"
                            min="5"
                            step="5"
                            value={drafts[group.key] ?? ''}
                            onChange={(event) => setDrafts((current) => ({ ...current, [group.key]: event.target.value }))}
                            className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                          />
                          <span className="text-xs text-muted-foreground">km/h</span>
                        </label>
                        <SpeedLimitQuickPicks
                          value={drafts[group.key]}
                          onPick={(limit) => setDrafts((current) => ({ ...current, [group.key]: limit }))}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => resolveCells(group.cells, 'user_confirmed_posted_sign', group.key)}
                          disabled={disabled}
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                        >
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Save sign
                        </button>
                        <button
                          type="button"
                          onClick={() => resolveCells(group.cells, 'user_entered_estimate', group.key)}
                          disabled={disabled}
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
                        >
                          <Gauge className="h-3.5 w-3.5" />
                          Estimate
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {visibleCells.length === 0 ? (
            <div className="rounded-xl border border-amber-200 bg-background/80 p-3 text-xs font-semibold text-muted-foreground dark:border-amber-900/60 dark:bg-background/70">
              No review items match this filter.
            </div>
          ) : visibleCells.map((cell) => {
            const center = geohashCenter(cell.geohash);
            const evidence = cell.tripReview ? cell : (routeEvidenceByGeohash.get(cell.geohash) || routeEvidenceForCell(trip, cell.geohash));
            const evidenceLimits = Array.isArray(evidence?.limits) ? evidence.limits : [];
            const evidenceSources = Array.isArray(evidence?.sources) ? evidence.sources : [];
            const evidenceRoads = Array.isArray(evidence?.roads) ? evidence.roads : [];
            const displayLat = Number(cell.lat);
            const displayLng = Number(cell.lng);
            const displayCoordinateText = Number.isFinite(displayLat) && Number.isFinite(displayLng)
              ? `${displayLat.toFixed(5)}, ${displayLng.toFixed(5)}`
              : `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
            const disabled = busyGeohash === cell.geohash;
            const previewExpanded = expandedPreviewKeys.has(cell.geohash);
            const category = reviewCellCategory(cell);
            const categoryLabel = {
              conflicts: 'Saved conflict',
              missing: 'Missing posted data',
              estimated: 'Estimated source',
              saved: 'Saved local rule',
            }[category];
            const ruleEvidence = assessSpeedLimitEvidence(cell);
            const priority = speedLimitReviewPriority(cell, {
              affectedTripCount: cell.tripReview ? 1 : 0,
            });
            const recommendation = buildSpeedLimitRecommendation(cell);
            return (
              <article key={cell.geohash} className="rounded-xl border border-amber-200 bg-background/80 p-3 text-sm shadow-sm dark:border-amber-900/60 dark:bg-background/70">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:bg-amber-900/50 dark:text-amber-100">
                        <MapPin className="h-3.5 w-3.5" />
                        {cell.geohash}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Driven section
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        category === 'conflicts'
                          ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                          : category === 'saved'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                            : 'bg-secondary text-muted-foreground'
                      }`}>
                        {categoryLabel}
                      </span>
                      <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white dark:bg-slate-100 dark:text-slate-900">
                        {priority.label}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        ruleEvidence.level === 'high'
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                          : ruleEvidence.level === 'medium'
                            ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                            : 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                      }`}>
                        {speedLimitConfidenceLabel(ruleEvidence)}
                      </span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">Stored limit</div>
                        <div className="font-semibold">{formatLimit(cell.conflictDetails?.existingLimitKmh ?? cell.limitKmh)}</div>
                      </div>
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">New report</div>
                        <div className="font-semibold">{formatLimit(cell.conflictDetails?.newLimitKmh)}</div>
                      </div>
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">Detected</div>
                        <div className="font-semibold">{formatDate(cell.conflictDetails?.detectedAt || cell.lastUpdatedAt || cell.sampleTimestamp)}</div>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {cell.tripReview
                        ? cell.reviewReason
                        : `Current source: ${sourceLabel(cell.source)}; confidence ${Math.round((Number(cell.confidence) || 0) * 100)}%; ${Number(cell.tripCount) || 0} matching trip${Number(cell.tripCount) === 1 ? '' : 's'}.`}
                    </div>
                    <div className="rounded-lg border border-border bg-background/70 px-3 py-2 text-xs">
                      <div className="font-semibold text-foreground">{recommendation.action}</div>
                      <div className="mt-1 text-muted-foreground">{recommendation.text}</div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px] font-semibold">
                      {(cell.sources?.length ? cell.sources : [cell.source]).filter(Boolean).map((source) => (
                        <span key={source} className={`rounded-full px-2 py-0.5 ${speedLimitSourceBadgeClass(source)}`}>
                          {speedLimitSourceLabel(source, { short: true })}
                        </span>
                      ))}
                    </div>
                    {evidence && (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => togglePreview(cell.geohash)}
                          className="inline-flex items-center justify-center rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary"
                        >
                          {previewExpanded ? 'Hide section' : 'Show section'}
                        </button>
                        {previewExpanded && (
                          <RoadSectionPreview
                            defaultOpen
                            identity={{
                              title: cell.title || primaryRoadLabel(cell.roads, cell.geohash),
                              roadName: cell.roadName || cell.roads?.[0] || '',
                              contextLabel: cell.contextLabel || 'from this recorded trip',
                              directionLabel: cell.directionLabel || 'along the route',
                              timeLabel: cell.timeLabel || '',
                              distanceM: cell.distanceM || 0,
                              sampleLat: displayLat,
                              sampleLng: displayLng,
                              sectionPoints: cell.sectionPoints?.length
                                ? cell.sectionPoints
                                : evidence.sectionPoints || [],
                            }}
                            routePoints={trip?.route_points || []}
                          />
                        )}
                      </div>
                    )}
                    {evidence && (
                      <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                        <div className="font-semibold text-foreground">{cell.tripReview ? 'Trip review evidence' : 'Opened trip evidence'}</div>
                        <div className="mt-1">
                          {evidence.sampleCount} route point{evidence.sampleCount === 1 ? '' : 's'} in this cell
                          {evidenceLimits.length ? `; trip limits ${evidenceLimits.join(', ')} km/h` : ''}
                          {evidenceSources.length ? `; sources ${evidenceSources.map(sourceLabel).join(', ')}` : ''}.
                        </div>
                        {evidenceRoads.length > 0 ? (
                          <div className="mt-1">Road labels: {evidenceRoads.join(', ')}</div>
                        ) : (
                          <div className="mt-1 font-medium text-amber-800 dark:text-amber-100">
                            Road name unavailable. Use Show section to inspect the highlighted driven portion before saving.
                          </div>
                        )}
                      </div>
                    )}
                    {!cell.tripReview && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer font-medium">Technical location details</summary>
                        <div className="mt-1">{displayCoordinateText}</div>
                      </details>
                    )}
                  </div>
                  <div className="w-full shrink-0 space-y-2 lg:w-64">
                    <label className="block text-xs font-semibold" htmlFor={`limit-${cell.geohash}`}>
                      Resolved limit
                    </label>
                    <div className="flex items-center gap-2">
                      <Gauge className="h-4 w-4 text-muted-foreground" />
                      <input
                        id={`limit-${cell.geohash}`}
                        type="number"
                        min="5"
                        step="5"
                        value={drafts[cell.geohash] ?? ''}
                        onChange={(event) => setDrafts((current) => ({ ...current, [cell.geohash]: event.target.value }))}
                        className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <span className="text-xs text-muted-foreground">km/h</span>
                    </div>
                    <SpeedLimitQuickPicks
                      value={drafts[cell.geohash]}
                      onPick={(limit) => setDrafts((current) => ({ ...current, [cell.geohash]: limit }))}
                    />
                    <div className="rounded-lg bg-secondary/50 px-3 py-2 text-[11px] text-muted-foreground">
                      {speedLimitScorePreview(cell.conflictDetails?.existingLimitKmh ?? cell.limitKmh ?? cell.suggestedLimitKmh, drafts[cell.geohash])}
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      <button
                        type="button"
                        onClick={() => resolveCells([cell], 'user_confirmed_posted_sign', cell.geohash)}
                        disabled={disabled}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {cell.existingLocalCorrection ? 'Update posted sign' : 'Save posted sign'}
                      </button>
                      <button
                        type="button"
                        onClick={() => resolveCells([cell], 'user_entered_estimate', cell.geohash)}
                        disabled={disabled}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
                      >
                        <Gauge className="h-3.5 w-3.5" />
                        {cell.existingLocalCorrection ? 'Update estimate' : 'Save estimate'}
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
