import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckSquare2, ChevronLeft, ChevronRight, Download, Gauge, GitMerge, HeartPulse, Info, Layers, Magnet, Map as MapIcon, MapPin, Pencil, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Trash2, Undo2, Upload, X } from 'lucide-react';
import { geohashEncode, LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import { refreshTripsCrossingLocalSpeedCorrection, refreshTripsForLocalSpeedKnowledgeChanges, tripCrossesCorrection } from '@/lib/localSpeedScoreRefresh';
import { correctionSectionIdentity } from '@/lib/roadSectionIdentity';
import RoadSectionPreview from '@/components/RoadSectionPreview';
import SpeedLimitEditorMap from '@/components/SpeedLimitEditorMap';
import {
  SPEED_MAP_LAYER_DEFAULTS,
  buildSpeedMapSections,
  buildSplitCorrections,
  findMergeableSpeedSection,
  mergeSpeedSections,
  snapSectionPointsToTripRoutes,
  speedLimitColor,
  summarizeSpeedMapSections,
} from '@/lib/speedLimitMapSections';
import {
  speedLimitScorePreview,
  speedLimitSourceBadgeClass,
  speedLimitSourceLabel,
  summarizeTripScoreDeltas,
} from '@/lib/speedLimitDisplay';
import { tripService } from '@/api/trips';
import { getPrivacyZones } from '@/lib/privacyZones';
import useLocalSettings from '@/hooks/useLocalSettings';
import { assessSpeedLimitEvidence, speedLimitConfidenceLabel } from '@/lib/speedLimitConfidence';
import {
  buildCorrectionImpactPreview,
  buildSpeedLimitRecommendation,
} from '@/lib/speedLimitIntelligence';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { inspectSpeedKnowledgeHealth } from '@/lib/speedKnowledgeHealth';

const sourceLabel = (source) => speedLimitSourceLabel(source, { short: true });
const correctionKey = (correction = {}) => correction.id || correction.ruleId || correction.sectionKey || correction.geohash;

const formatSpeedLimit = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? `${Math.round(number)} km/h` : 'Unknown';
};

const formatSourceList = (sources = []) => {
  const labels = [...new Set((sources || []).filter(Boolean).map(sourceLabel))];
  return labels.length ? labels.join(', ') : 'Unknown source';
};

const scheduleIdleWork = (callback) => {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const idleId = window.requestIdleCallback(callback, { timeout: 1200 });
    return () => window.cancelIdleCallback?.(idleId);
  }
  const timer = window.setTimeout(callback, 120);
  return () => window.clearTimeout(timer);
};

const mapDraftLimitForSection = (section = {}) => {
  const limit = section.saved
    ? Number(section.limitKmh)
    : Number(section.observedLimitKmh ?? section.effectiveLimitKmh);
  return Number.isFinite(limit) && limit > 0 ? String(Math.round(limit)) : '';
};

const mapDraftSourceForSection = (section = {}) => {
  if (section.saved) return section.source || 'user_entered_estimate';
  return (section.observedSources || []).includes('user_confirmed_posted_sign')
    ? 'user_confirmed_posted_sign'
    : 'user_entered_estimate';
};

const formatDate = (value) => {
  if (value == null || value === '') return 'Unknown time';
  const date = new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) && time > 0 ? date.toLocaleString() : 'Unknown time';
};

const formatCoordinate = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(5) : '0.00000';
};

const coordinateLabel = (source) => (
  source === 'geohash_cell_center_legacy'
    ? 'Approx cell center'
    : 'Driven route point'
);

const directionLabel = (mode) => ({
  forward: 'Drawn direction only',
  reverse: 'Opposite direction only',
  both: 'Both directions',
}[mode] || 'Both directions');

const timeRuleModeForRow = (row = {}) => {
  const rule = row.timeRule;
  if (rule?.enabled !== true) return 'always';
  const days = [...(rule.days || [])].sort((a, b) => a - b).join(',');
  if (days === '1,2,3,4,5') return 'weekdays';
  if (days === '0,6') return 'weekends';
  return 'daily';
};

const timeString = (minutes, fallback = '07:00') => {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.max(0, Math.min(1439, Math.round(value)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
};

const timeRuleLabel = (rule = null) => {
  if (rule?.enabled !== true) return 'Always active';
  const mode = timeRuleModeForRow({ timeRule: rule });
  const dayLabel = mode === 'weekdays' ? 'Weekdays' : mode === 'weekends' ? 'Weekends' : 'Every day';
  return `${dayLabel} ${timeString(rule.startMinutes)}-${timeString(rule.endMinutes)}`;
};

const dateInputValue = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
};

const expiresAtFromDate = (value) => (
  value ? new Date(`${value}T23:59:59`).toISOString() : null
);

const expiryLabel = (value) => (
  value ? `Expires ${new Date(value).toLocaleDateString()}` : 'No expiry'
);

const timeRuleFromDraft = (draft = {}) => {
  const mode = draft.timeRuleMode || 'always';
  if (mode === 'always') return { enabled: false };
  const days = mode === 'weekdays'
    ? [1, 2, 3, 4, 5]
    : mode === 'weekends'
      ? [0, 6]
      : [0, 1, 2, 3, 4, 5, 6];
  return {
    enabled: true,
    days,
    startTime: draft.startTime || '07:00',
    endTime: draft.endTime || '17:00',
  };
};

const SPEEDS_PER_PAGE = 10;
const COMMON_SPEED_LIMITS_KMH = [30, 40, 50, 60, 70, 80, 100];
const ROW_FILTERS = [
  ['all', 'All'],
  ['conflicts', 'Conflicts'],
  ['posted', 'Posted'],
  ['estimates', 'Estimates'],
  ['timeRules', 'Timed'],
  ['expiring', 'Expiring'],
];
const ROW_SORTS = [
  ['updated', 'Recently updated'],
  ['impact', 'Conflict impact'],
  ['road', 'Road name'],
  ['limit', 'Speed limit'],
];

const distanceMeters = (a, b) => {
  const lat1 = Number(a?.lat) * Math.PI / 180;
  const lat2 = Number(b?.lat) * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLng = (Number(b?.lng) - Number(a?.lng)) * Math.PI / 180;
  if (![lat1, lat2, dLat, dLng].every(Number.isFinite)) return Infinity;
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const sectionLengthMeters = (points = []) => points.reduce((sum, point, index) => (
  index === 0 ? 0 : sum + distanceMeters(points[index - 1], point)
), 0);

const rowSearchText = (row = {}, conflict = null) => [
  row.geohash,
  row.roadName,
  row.contextLabel,
  row.note,
  row.source,
  row.limitKmh,
  conflict?.observedLimitKmh,
].filter((value) => value != null && value !== '').join(' ').toLowerCase();

const matchesRowFilter = (row = {}, conflict = null, filter = 'all') => {
  if (filter === 'conflicts') return Boolean(conflict);
  if (filter === 'posted') return row.source === 'user_confirmed_posted_sign';
  if (filter === 'estimates') return row.source !== 'user_confirmed_posted_sign';
  if (filter === 'timeRules') return row.timeRule?.enabled === true || row.directionMode === 'forward' || row.directionMode === 'reverse';
  if (filter === 'expiring') return Boolean(row.expiresAt);
  return true;
};

const sortRows = (items = [], sortMode = 'updated') => [...items].sort((a, b) => {
  if (sortMode === 'impact') {
    return (Number(b.conflict?.deltaKmh) || 0) - (Number(a.conflict?.deltaKmh) || 0);
  }
  if (sortMode === 'road') {
    return String(a.row.roadName || a.row.contextLabel || a.row.geohash)
      .localeCompare(String(b.row.roadName || b.row.contextLabel || b.row.geohash));
  }
  if (sortMode === 'limit') {
    return (Number(a.row.limitKmh) || 0) - (Number(b.row.limitKmh) || 0);
  }
  return new Date(b.row.appliedAt || 0).getTime() - new Date(a.row.appliedAt || 0).getTime();
});

const tripLabel = (trip = {}) => {
  const title = trip.name || trip.title || trip.label;
  if (title) return title;
  const started = new Date(trip.start_time || trip.started_at || trip.created_at || 0);
  return Number.isFinite(started.getTime())
    ? started.toLocaleDateString()
    : `Trip ${String(trip.id || '').slice(0, 8)}`;
};

const undoActionText = (action = '') => ({
  save_correction: 'add',
  update_correction: 'change',
  remove_correction: 'delete',
  resolve_conflict: 'conflict decision',
  restore_speed_backup: 'restore',
  restore_backup: 'restore',
  prune: 'cleanup',
}[action] || 'change');

export default function SpeedLimits() {
  const [searchParams] = useSearchParams();
  const tripId = searchParams.get('tripId');
  const knowledge = useMemo(() => new LocalSpeedKnowledge(speedKnowledgeStore), []);
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyGeohash, setBusyGeohash] = useState(null);
  const [status, setStatus] = useState(/** @type {string | { message: string, scoreDeltas?: any[], canUndo?: boolean }} */ (''));
  const [linkedTrip, setLinkedTrip] = useState(null);
  const [mapTrips, setMapTrips] = useState([]);
  const [selectedSection, setSelectedSection] = useState(null);
  const [addMode, setAddMode] = useState(false);
  const [addPath, setAddPath] = useState([]);
  const [mapQuery, setMapQuery] = useState('');
  const [mapLayers, setMapLayers] = useState(SPEED_MAP_LAYER_DEFAULTS);
  const [mapMode, setMapMode] = useState('review');
  const [autoSnapTrace, setAutoSnapTrace] = useState(true);
  const [rowQuery, setRowQuery] = useState('');
  const [rowFilter, setRowFilter] = useState('all');
  const [rowSort, setRowSort] = useState('updated');
  const [selectedRows, setSelectedRows] = useState(() => new Set());
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' });
  const [health, setHealth] = useState(null);
  const restoreInputRef = useRef(null);
  const knowledgeReloadTimerRef = useRef(null);
  const mapTripsLoadRef = useRef(0);
  const [mapDraft, setMapDraft] = useState({
    limitKmh: '',
    source: 'user_confirmed_posted_sign',
    note: '',
    roadName: '',
    directionMode: 'both',
    timeRuleMode: 'always',
    startTime: '07:00',
    endTime: '17:00',
    expiresAtDate: '',
  });
  const [page, setPage] = useState(1);
  const settings = useLocalSettings();
  const privacyZones = useMemo(() => getPrivacyZones(settings), [settings]);
  const mapSections = useMemo(() => buildSpeedMapSections(mapTrips, rows), [mapTrips, rows]);
  const mapStats = useMemo(() => summarizeSpeedMapSections(mapSections), [mapSections]);
  const conflictsByGeohash = useMemo(() => new Map(
    mapSections
      .filter((section) => section.conflict)
      .map((section) => [correctionKey(section), section.conflict])
  ), [mapSections]);
  const filteredRows = useMemo(() => {
    const query = rowQuery.trim().toLowerCase();
    const items = rows
      .map((row) => ({ row, conflict: conflictsByGeohash.get(correctionKey(row)) || null }))
      .filter(({ row, conflict }) => matchesRowFilter(row, conflict, rowFilter))
      .filter(({ row, conflict }) => !query || rowSearchText(row, conflict).includes(query));
    return sortRows(items, rowSort).map(({ row }) => row);
  }, [conflictsByGeohash, rowFilter, rowQuery, rowSort, rows]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / SPEEDS_PER_PAGE));
  const visibleRows = filteredRows.slice(
    (page - 1) * SPEEDS_PER_PAGE,
    page * SPEEDS_PER_PAGE
  );
  const firstConflictSection = useMemo(() => mapSections.find((section) => section.conflict), [mapSections]);
  const attentionItems = useMemo(() => {
    const conflicts = mapSections
      .filter((section) => section.conflict)
      .map((section) => ({
        key: `conflict-${correctionKey(section)}`,
        kind: 'conflict',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: `Saved ${section.conflict.savedLimitKmh} km/h, observed ${section.conflict.observedLimitKmh} km/h`,
        section,
      }));
    const unset = mapSections
      .filter((section) => !section.saved && !Number(section.effectiveLimitKmh))
      .slice(0, 4)
      .map((section) => ({
        key: `unset-${section.geohash}`,
        kind: 'unset',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: `${section.sampleCount || section.sectionPoints?.length || 1} trip sample${(section.sampleCount || section.sectionPoints?.length || 1) === 1 ? '' : 's'} without a saved speed`,
        section,
      }));
    const observed = mapSections
      .filter((section) => !section.saved && Number(section.effectiveLimitKmh) > 0)
      .slice(0, 4)
      .map((section) => ({
        key: `observed-${section.geohash}`,
        kind: 'observed',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: `Observed ${Math.round(Number(section.effectiveLimitKmh))} km/h from ${formatSourceList(section.observedSources)}`,
        section,
      }));
    return [...conflicts, ...unset, ...observed].slice(0, 8);
  }, [mapSections]);
  const selectedSectionPointCount = selectedSection?.sectionPoints?.length || 0;
  const traceLengthM = useMemo(() => sectionLengthMeters(addPath), [addPath]);
  const traceQuality = useMemo(() => {
    if (!addMode) return null;
    if (addPath.length < 2) return { level: 'warn', text: 'Tap at least two points along the road.' };
    if (traceLengthM < 25) return { level: 'warn', text: 'Trace a longer section so the saved rule matches real driving.' };
    if (!mapTrips.some((trip) => Array.isArray(trip?.route_points) && trip.route_points.length > 0)) {
      return { level: 'info', text: 'No recorded trip route is available for snapping; review the line carefully.' };
    }
    return { level: 'good', text: `Ready to save. The trace is about ${Math.round(traceLengthM)} m long.` };
  }, [addMode, addPath.length, mapTrips, traceLengthM]);
  const canSaveSelectedMapSection = Boolean(selectedSection) && (
    selectedSection.saved || selectedSectionPointCount >= 2
  );
  const selectedCorrectionDraft = useMemo(() => selectedSection ? ({
    ...selectedSection,
    limitKmh: Number(mapDraft.limitKmh),
    source: mapDraft.source,
    directionMode: mapDraft.directionMode || 'both',
    timeRule: timeRuleFromDraft(mapDraft),
    expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
    sectionPoints: selectedSection.sectionPoints || addPath,
  }) : null, [addPath, mapDraft, selectedSection]);
  const selectedImpactPreview = useMemo(() => (
    selectedCorrectionDraft
      ? buildCorrectionImpactPreview(mapTrips, selectedCorrectionDraft, mapDraft.limitKmh)
      : null
  ), [mapDraft.limitKmh, mapTrips, selectedCorrectionDraft]);
  const selectedEvidence = useMemo(() => (
    selectedCorrectionDraft ? assessSpeedLimitEvidence(selectedCorrectionDraft) : null
  ), [selectedCorrectionDraft]);
  const selectedRecommendation = useMemo(() => (
    selectedCorrectionDraft
      ? buildSpeedLimitRecommendation(selectedCorrectionDraft, {
        observedLimitKmh: selectedSection?.observedLimitKmh,
      })
      : null
  ), [selectedCorrectionDraft, selectedSection?.observedLimitKmh]);
  const mergeCandidate = useMemo(() => (
    selectedSection?.saved
      ? findMergeableSpeedSection(selectedSection, mapSections)
      : null
  ), [mapSections, selectedSection]);
  const editorWarnings = useMemo(() => {
    if (!selectedSection) return [];
    const warnings = [];
    if ((selectedSection.sectionPoints || []).length < 2) warnings.push('Trace at least two points to define a road section.');
    if (addMode && traceLengthM > 0 && traceLengthM < 25) warnings.push('Trace a longer section before saving; very short rules are easy to match to the wrong road.');
    if (!String(mapDraft.roadName || selectedSection.roadName || '').trim()) warnings.push('Add a road name to make future review and merging more reliable.');
    if (mapDraft.source === 'user_confirmed_posted_sign' && !String(mapDraft.note || '').trim()) {
      warnings.push('Add a short confirmation note for the audit history.');
    }
    if (selectedImpactPreview?.affectedTripCount === 0) warnings.push('No stored completed trips currently cross this rule.');
    return warnings;
  }, [addMode, mapDraft.note, mapDraft.roadName, mapDraft.source, selectedImpactPreview?.affectedTripCount, selectedSection, traceLengthM]);
  const matchingTripsForCorrection = useCallback((correction) => (
    mapTrips.filter((trip) => trip?.status === 'completed' && tripCrossesCorrection(trip, correction))
  ), [mapTrips]);

  const buildRecalculationStatus = useCallback((message, beforeTrips = [], updatedTrips = null) => {
    if (!Array.isArray(updatedTrips)) return message;
    return {
      message,
      scoreDeltas: summarizeTripScoreDeltas(beforeTrips, updatedTrips),
      trips: updatedTrips,
    };
  }, []);

  const withUndo = useCallback((nextStatus) => (
    typeof nextStatus === 'string'
      ? { message: nextStatus, canUndo: true }
      : { ...nextStatus, canUndo: true }
  ), []);

  const loadRows = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    const [nextRows, nextHistory, rawKnowledge] = await Promise.all([
      knowledge.listUserCorrections().catch(() => []),
      knowledge.getHistoryState().catch(() => ({ canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' })),
      knowledge.exportData().catch(() => ({ cells: {}, corrections: [] })),
    ]);
    setRows(nextRows);
    setHistoryState(nextHistory);
    setHealth(inspectSpeedKnowledgeHealth(rawKnowledge));
    setSelectedRows((current) => new Set([...current].filter((key) => (
      nextRows.some((row) => correctionKey(row) === key)
    ))));
    setDrafts((current) => {
      const next = { ...current };
      for (const row of nextRows) {
        const key = correctionKey(row);
        if (!next[key]) {
          next[key] = {
            limitKmh: String(row.limitKmh || ''),
            source: row.source || 'user_entered_estimate',
            note: row.note || '',
            roadName: row.roadName || '',
            directionMode: row.directionMode || 'both',
            timeRuleMode: timeRuleModeForRow(row),
            startTime: timeString(row.timeRule?.startMinutes),
            endTime: timeString(row.timeRule?.endMinutes, '17:00'),
            expiresAtDate: dateInputValue(row.expiresAt),
          };
        }
      }
      return next;
    });
    if (!silent) setLoading(false);

    const loadId = mapTripsLoadRef.current + 1;
    mapTripsLoadRef.current = loadId;
    scheduleIdleWork(() => {
      tripService.list({ sort: '-start_time', limit: 500 })
        .then((nextTrips) => {
          if (mapTripsLoadRef.current === loadId) setMapTrips(nextTrips);
        })
        .catch(() => {
          if (mapTripsLoadRef.current === loadId) setMapTrips([]);
        });
    });
  }, [knowledge]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  useEffect(() => {
    setPage(1);
  }, [rowFilter, rowQuery, rowSort]);

  useEffect(() => {
    let cancelled = false;
    if (!tripId) {
      setLinkedTrip(null);
      return undefined;
    }
    tripService.getById(tripId)
      .then((trip) => {
        if (!cancelled) setLinkedTrip(trip || null);
      })
      .catch(() => {
        if (!cancelled) setLinkedTrip(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  useEffect(() => {
    const onKnowledgeChanged = () => {
      window.clearTimeout(knowledgeReloadTimerRef.current);
      knowledgeReloadTimerRef.current = window.setTimeout(() => {
        loadRows({ silent: true });
      }, 80);
    };
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onKnowledgeChanged);
    return () => {
      window.clearTimeout(knowledgeReloadTimerRef.current);
      window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onKnowledgeChanged);
    };
  }, [loadRows]);

  const updateDraft = (geohash, patch) => {
    setDrafts((current) => ({
      ...current,
      [geohash]: {
        limitKmh: '',
        source: 'user_entered_estimate',
        note: '',
        roadName: '',
        ...(current[geohash] || {}),
        ...patch,
      },
    }));
  };

  const saveRow = async (row) => {
    const key = correctionKey(row);
    const draft = drafts[key] || {};
    const limitKmh = Number(draft.limitKmh);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0) {
      setStatus('Enter a valid speed limit before saving.');
      return;
    }
    setBusyGeohash(key);
    const updatedCorrection = {
      ...row,
      limitKmh: Math.round(limitKmh),
      source: draft.source || row.source || 'user_entered_estimate',
      note: draft.note,
      roadName: String(draft.roadName ?? row.roadName ?? '').trim(),
      directionMode: draft.directionMode || 'both',
      timeRule: timeRuleFromDraft(draft),
      expiresAt: expiresAtFromDate(draft.expiresAtDate),
    };
    const beforeTrips = matchingTripsForCorrection(updatedCorrection);
    const saved = await knowledge.updateUserCorrection(
      key,
      Math.round(limitKmh),
      draft.source || row.source || 'user_entered_estimate',
      draft.note,
      {
        directionMode: draft.directionMode || 'both',
        timeRule: timeRuleFromDraft(draft),
        expiresAt: expiresAtFromDate(draft.expiresAtDate),
        roadName: String(draft.roadName ?? row.roadName ?? '').trim(),
      }
    ).catch(() => false);
    if (saved) {
      setRows((current) => current.map((item) => (
        correctionKey(item) === key
          ? { ...item, ...updatedCorrection, appliedAt: new Date().toISOString() }
          : item
      )));
      setBusyGeohash(null);
      setStatus(withUndo('Saved road speed updated. Matching trip scores are updating in the background.'));
      void (async () => {
        const updatedTrips = await refreshTripsCrossingLocalSpeedCorrection(updatedCorrection).catch(() => null);
        setStatus(withUndo(buildRecalculationStatus(
          updatedTrips
            ? `Saved road speed updated. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
            : 'Saved road speed updated, but matching trips could not be recalculated right now.',
          beforeTrips,
          updatedTrips
        )));
        await loadRows({ silent: true });
      })();
    } else {
      setStatus('Could not update that saved speed.');
      setBusyGeohash(null);
    }
  };

  const removeRow = async (row) => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this saved road speed?')) return;
    const key = correctionKey(row);
    setBusyGeohash(key);
    const beforeTrips = matchingTripsForCorrection(row);
    const removed = await knowledge.removeUserCorrection(key).catch(() => false);
    if (removed) {
      const updatedTrips = await refreshTripsCrossingLocalSpeedCorrection(row).catch(() => null);
      setStatus(withUndo(buildRecalculationStatus(
        updatedTrips
          ? `Saved road speed removed. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} using remaining speed data and fallbacks.`
          : 'Saved road speed removed, but matching trips could not be recalculated right now.',
        beforeTrips,
        updatedTrips
      )));
      await loadRows();
    } else {
      setStatus('Could not remove that saved speed.');
    }
    setBusyGeohash(null);
  };

  const resolveSavedSpeedConflict = async (row, conflict, action, draft = {}) => {
    if (!row?.geohash || !conflict) return;
    const keepSaved = action === 'keep_saved';
    const nextLimitKmh = keepSaved
      ? Number(row.limitKmh)
      : Number(conflict.observedLimitKmh);
    if (!Number.isFinite(nextLimitKmh) || nextLimitKmh <= 0) {
      setStatus('Could not resolve this conflict because the speed value is missing.');
      return;
    }

    const nextCorrection = {
      ...row,
      limitKmh: Math.round(nextLimitKmh),
      source: draft.source || row.source || 'user_entered_estimate',
      note: draft.note ?? row.note ?? '',
      roadName: String(draft.roadName ?? row.roadName ?? '').trim(),
      directionMode: draft.directionMode || row.directionMode || 'both',
      timeRule: timeRuleFromDraft({ ...row, ...draft }),
      expiresAt: expiresAtFromDate(draft.expiresAtDate) ?? row.expiresAt ?? null,
      sectionPoints: row.sectionPoints || [],
    };
    const beforeTrips = matchingTripsForCorrection(nextCorrection);
    const key = correctionKey(row);
    setBusyGeohash(key);
    const saved = await knowledge.updateUserCorrection(
      key,
      nextCorrection.limitKmh,
      nextCorrection.source,
      nextCorrection.note,
      {
        roadName: nextCorrection.roadName,
        sectionPoints: nextCorrection.sectionPoints,
        directionMode: nextCorrection.directionMode,
        directionBearing: row.directionBearing,
        timeRule: nextCorrection.timeRule,
        expiresAt: nextCorrection.expiresAt,
        conflictResolution: keepSaved ? {
          savedLimitKmh: conflict.savedLimitKmh,
          observedLimitKmh: conflict.observedLimitKmh,
          deltaKmh: conflict.deltaKmh,
          action: 'kept_saved_limit',
          note: 'User kept the saved local road speed after reviewing the observed trip evidence.',
        } : null,
      }
    ).catch(() => false);

    if (!saved) {
      setBusyGeohash(null);
      setStatus('Could not resolve that speed conflict.');
      return;
    }

    setRows((current) => current.map((item) => (
      correctionKey(item) === key
        ? {
          ...item,
          ...nextCorrection,
          conflictResolution: keepSaved ? {
            savedLimitKmh: conflict.savedLimitKmh,
            observedLimitKmh: conflict.observedLimitKmh,
            deltaKmh: conflict.deltaKmh,
            action: 'kept_saved_limit',
            resolvedAt: new Date().toISOString(),
          } : null,
          appliedAt: new Date().toISOString(),
        }
        : item
    )));
    setDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] || {}),
        limitKmh: String(nextCorrection.limitKmh),
        source: nextCorrection.source,
        note: nextCorrection.note,
        roadName: nextCorrection.roadName,
      },
    }));
    if (correctionKey(selectedSection) === key) {
      setSelectedSection((current) => current ? {
        ...current,
        ...nextCorrection,
        conflict: null,
        conflictResolution: keepSaved ? {
          savedLimitKmh: conflict.savedLimitKmh,
          observedLimitKmh: conflict.observedLimitKmh,
          deltaKmh: conflict.deltaKmh,
          action: 'kept_saved_limit',
          resolvedAt: new Date().toISOString(),
        } : null,
      } : current);
      setMapDraft((current) => ({
        ...current,
        limitKmh: String(nextCorrection.limitKmh),
        source: nextCorrection.source,
        note: nextCorrection.note,
        roadName: nextCorrection.roadName,
      }));
    }
    setBusyGeohash(null);

    if (keepSaved) {
      setStatus(withUndo(`Conflict resolved: kept the saved ${Math.round(nextLimitKmh)} km/h rule for this road section.`));
      await loadRows({ silent: true });
      return;
    }

    setStatus(withUndo(`Conflict resolved: updated this road section to ${Math.round(nextLimitKmh)} km/h. Matching trip scores are updating in the background.`));
    void (async () => {
      const updatedTrips = await refreshTripsCrossingLocalSpeedCorrection(nextCorrection).catch(() => null);
      setStatus(withUndo(buildRecalculationStatus(
        updatedTrips
          ? `Conflict resolved: updated this road section to ${Math.round(nextLimitKmh)} km/h and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
          : `Conflict resolved: updated this road section to ${Math.round(nextLimitKmh)} km/h, but matching trips could not be recalculated right now.`,
        beforeTrips,
        updatedTrips
      )));
      await loadRows({ silent: true });
    })();
  };

  const selectMapSection = (section) => {
    setSelectedSection(section);
    setMapMode(section?.conflict ? 'review' : mapMode);
    setMapDraft({
      limitKmh: mapDraftLimitForSection(section),
      source: mapDraftSourceForSection(section),
      note: section.note || '',
      roadName: section.roadName || '',
      directionMode: section.directionMode || 'both',
      timeRuleMode: timeRuleModeForRow(section),
      startTime: timeString(section.timeRule?.startMinutes),
      endTime: timeString(section.timeRule?.endMinutes, '17:00'),
      expiresAtDate: dateInputValue(section.expiresAt),
    });
    setAddMode(false);
    setAddPath([]);
  };

  const startAddingSection = () => {
    setSelectedSection(null);
    setAddPath([]);
    setAddMode(true);
    setMapMode('edit');
    setMapDraft({
      limitKmh: '',
      source: 'user_confirmed_posted_sign',
      note: '',
      roadName: '',
      directionMode: 'both',
      timeRuleMode: 'always',
      startTime: '07:00',
      endTime: '17:00',
      expiresAtDate: '',
    });
    setStatus(autoSnapTrace
      ? 'Trace the road by tapping several points. Each tap will snap to nearby recorded trip geometry when possible.'
      : 'Trace the road by tapping several points. Add more points around bends, then enter the speed and save.');
  };

  const selectNewMapPoint = (point) => {
    setAddPath((current) => {
      const rawNext = [...current, point].slice(-24);
      const snappedNext = autoSnapTrace
        ? snapSectionPointsToTripRoutes(rawNext, mapTrips)
        : rawNext;
      const next = snappedNext.length ? snappedNext : rawNext;
      const midpoint = next[Math.floor(next.length / 2)];
      setSelectedSection({
        ...midpoint,
        geohash: geohashEncode(midpoint.lat, midpoint.lng),
        saved: false,
        roadName: '',
        sectionPoints: next,
      });
      return next;
    });
  };

  const moveAddPoint = (index, point) => {
    setAddPath((current) => {
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return current;
      const next = current.map((item, itemIndex) => (
        itemIndex === index ? { lat: point.lat, lng: point.lng } : item
      ));
      const midpoint = next[Math.floor(next.length / 2)];
      setSelectedSection((section) => ({
        ...(section || {}),
        ...midpoint,
        geohash: geohashEncode(midpoint.lat, midpoint.lng),
        saved: false,
        sectionPoints: next,
      }));
      return next;
    });
  };

  const focusAttentionItem = (item) => {
    if (!item?.section) return;
    selectMapSection(item.section);
    setMapLayers((current) => ({
      ...current,
      conflicts: true,
      saved: true,
      observed: true,
      unset: true,
    }));
    setStatus(item.kind === 'conflict'
      ? 'Conflict selected. Choose Use observed or Keep saved to clear it.'
      : 'Road section selected. Enter a posted sign or local estimate, then save.');
  };

  const undoAddPoint = () => {
    setAddPath((current) => {
      const next = current.slice(0, -1);
      if (!next.length) {
        setSelectedSection(null);
      } else {
        const midpoint = next[Math.floor(next.length / 2)];
        setSelectedSection((section) => ({
          ...(section || {}),
          ...midpoint,
          geohash: geohashEncode(midpoint.lat, midpoint.lng),
          sectionPoints: next,
        }));
      }
      return next;
    });
  };

  const snapSelectedSectionToTrips = () => {
    if (!selectedSection) return;
    const currentPoints = selectedSection.sectionPoints || addPath;
    const hasRecordedRoute = mapTrips.some((trip) => (
      Array.isArray(trip?.route_points) && trip.route_points.length > 0
    ));
    if (!hasRecordedRoute) {
      setStatus('Snap to route needs at least one recorded trip. The traced line was not changed.');
      return;
    }
    const snapped = snapSectionPointsToTripRoutes(currentPoints, mapTrips);
    if (snapped.length < 2) {
      setStatus('This section needs at least two points before it can snap to recorded routes.');
      return;
    }
    const changed = snapped.some((point, index) => (
      point.lat !== currentPoints[index]?.lat || point.lng !== currentPoints[index]?.lng
    ));
    if (!changed) {
      setStatus('No recorded route samples were within 80 metres, so the traced line was not changed.');
      return;
    }
    setSelectedSection((current) => ({ ...current, sectionPoints: snapped }));
    if (addMode) setAddPath(snapped);
    setStatus('Section points snapped to the nearest recorded route samples within 80 metres. Review the line before saving.');
  };

  const prepareMergeWithNearbySection = () => {
    if (!selectedSection?.saved || !mergeCandidate?.candidate) return;
    const merged = mergeSpeedSections(selectedSection, mergeCandidate.candidate);
    if (!merged) {
      setStatus('These sections could not be merged because their saved geometry is incomplete.');
      return;
    }
    setSelectedSection({
      ...merged,
      saved: false,
      pendingMerge: true,
      mergedSelectors: merged.mergedSelectors,
    });
    setAddMode(false);
    setAddPath(merged.sectionPoints);
    setStatus(`Prepared a merged section with ${mergeCandidate.candidate.roadName || 'the nearby saved section'}. Saving will replace both original rules.`);
  };

  const saveMapSection = async () => {
    if (!selectedSection) return;
    const limitKmh = Number(mapDraft.limitKmh);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0) {
      setStatus('Enter a valid speed limit before saving.');
      return;
    }
    if (!selectedSection.saved && selectedSection.sectionPoints?.length < 2) {
      setStatus('Tap at least two points along the road so Road Sage can save a real road section.');
      return;
    }
    const selectedKey = correctionKey(selectedSection);
    setBusyGeohash(selectedKey);
    const historyGroup = selectedSection.pendingMerge
      ? `merge-${Date.now()}`
      : null;
    const saved = selectedSection.saved
      ? await knowledge.updateUserCorrection(
        selectedKey,
        Math.round(limitKmh),
        mapDraft.source,
        mapDraft.note,
        {
          roadName: mapDraft.roadName || selectedSection.roadName || '',
          sectionPoints: selectedSection.sectionPoints || [],
          directionMode: mapDraft.directionMode || 'both',
          directionBearing: selectedSection.directionBearing,
          timeRule: timeRuleFromDraft(mapDraft),
          expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
          historyGroup,
        }
      ).catch(() => false)
      : await knowledge.saveUserCorrection(
        selectedSection.lat,
        selectedSection.lng,
        Math.round(limitKmh),
        mapDraft.note,
        expiresAtFromDate(mapDraft.expiresAtDate),
        privacyZones,
        mapDraft.source,
        {
          roadName: mapDraft.roadName || selectedSection.roadName || '',
          contextLabel: 'Selected from the saved road speed map',
          directionLabel: directionLabel(mapDraft.directionMode),
          directionMode: mapDraft.directionMode || 'both',
          directionBearing: selectedSection.directionBearing,
          timeRule: timeRuleFromDraft(mapDraft),
          sectionPoints: selectedSection.sectionPoints || [selectedSection],
          historyGroup,
        }
      ).catch(() => false);

    if (saved) {
      if (selectedSection.pendingMerge && Array.isArray(selectedSection.mergedSelectors)) {
        await Promise.all(selectedSection.mergedSelectors
          .filter((selector) => selector && selector !== selectedKey)
          .map((selector) => knowledge.removeUserCorrection(selector, { historyGroup }).catch(() => false)));
      }
      const correction = {
        ...selectedSection,
        limitKmh: Math.round(limitKmh),
        roadName: mapDraft.roadName || selectedSection.roadName || '',
        sectionPoints: selectedSection.sectionPoints || [],
        directionMode: mapDraft.directionMode || 'both',
        timeRule: timeRuleFromDraft(mapDraft),
        expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
      };
      const beforeTrips = matchingTripsForCorrection(correction);
      setRows((current) => {
        const nextRow = {
          ...correction,
          geohash: selectedSection.geohash,
          source: mapDraft.source,
          note: mapDraft.note,
          saved: true,
          appliedAt: new Date().toISOString(),
        };
        const existingIndex = current.findIndex((item) => correctionKey(item) === selectedKey);
        if (existingIndex < 0) return [nextRow, ...current];
        return current.map((item, index) => index === existingIndex ? { ...item, ...nextRow } : item);
      });
      setSelectedSection(null);
      setAddMode(false);
      setAddPath([]);
      setBusyGeohash(null);
      setStatus(withUndo(`Saved ${Math.round(limitKmh)} km/h for this road section. Matching trip scores are updating in the background.`));
      void (async () => {
        const updatedTrips = await refreshTripsCrossingLocalSpeedCorrection(correction).catch(() => null);
        setStatus(withUndo(buildRecalculationStatus(
          updatedTrips
            ? `Saved ${Math.round(limitKmh)} km/h for this road section. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
            : `Saved ${Math.round(limitKmh)} km/h for this road section, but matching trips could not be recalculated right now.`,
          beforeTrips,
          updatedTrips
        )));
        await loadRows({ silent: true });
      })();
    } else {
      setStatus('Could not save this road section. Private-zone sections cannot be saved.');
      setBusyGeohash(null);
    }
  };

  const removeMapSection = async () => {
    if (!selectedSection?.saved) return;
    if (typeof window !== 'undefined' && !window.confirm('Remove the saved speed from this road section?')) return;
    await removeRow(selectedSection);
    setSelectedSection(null);
  };

  const splitMapSection = async () => {
    if (!selectedSection?.saved) return;
    const parts = buildSplitCorrections({
      ...selectedSection,
      limitKmh: Number(mapDraft.limitKmh || selectedSection.limitKmh),
      source: mapDraft.source || selectedSection.source,
      note: mapDraft.note || selectedSection.note || '',
      roadName: mapDraft.roadName || selectedSection.roadName || '',
      directionMode: mapDraft.directionMode || selectedSection.directionMode || 'both',
      timeRule: timeRuleFromDraft(mapDraft),
      expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
    });
    if (parts.length !== 2) {
      setStatus('This road section needs at least three trace points before it can be split.');
      return;
    }
    const distinct = new Set(parts.map((part) => part.geohash));
    if (distinct.size !== parts.length) {
      setStatus('This section is too short to split safely. Add a longer traced section first.');
      return;
    }
    if (typeof window !== 'undefined' && !window.confirm('Split this saved speed into two editable road sections?')) return;

    const selectedKey = correctionKey(selectedSection);
    setBusyGeohash(selectedKey);
    const source = mapDraft.source || selectedSection.source || 'user_entered_estimate';
    const historyGroup = `split-${Date.now()}`;
    const noteBase = mapDraft.note || selectedSection.note || '';
    const expiresAt = expiresAtFromDate(mapDraft.expiresAtDate);
    const savedParts = [];
    for (const part of parts) {
      const metadata = {
        roadName: part.roadName || '',
        contextLabel: part.contextLabel,
        directionLabel: directionLabel(part.directionMode),
        sectionPoints: part.sectionPoints,
        directionMode: part.directionMode,
        directionBearing: part.directionBearing,
        timeRule: part.timeRule,
        historyGroup,
      };
      const note = noteBase ? `${noteBase} (split ${part.splitPart}/2)` : `Split section ${part.splitPart}/2`;
      const saved = part.geohash === selectedSection.geohash
        ? await knowledge.updateUserCorrection(selectedKey, part.limitKmh, source, note, {
          ...metadata,
          expiresAt,
        }).catch(() => false)
        : await knowledge.saveUserCorrection(
          part.lat,
          part.lng,
          part.limitKmh,
          note,
          expiresAt,
          privacyZones,
          source,
          metadata
        ).catch(() => false);
      if (saved) savedParts.push(part);
    }
    if (savedParts.length === parts.length) {
      if (!parts.some((part) => part.geohash === selectedSection.geohash)) {
        await knowledge.removeUserCorrection(selectedKey, { historyGroup }).catch(() => false);
      }
      const updatedTrips = await Promise.all(parts.map((part) => (
        refreshTripsCrossingLocalSpeedCorrection(part).catch(() => null)
      )));
      const recalculated = updatedTrips.flat().filter(Boolean).length;
      setStatus(withUndo(`Road section split into two saved speeds. Recalculated ${recalculated} matching trip${recalculated === 1 ? '' : 's'} locally.`));
      setSelectedSection(null);
      await loadRows();
    } else {
      setStatus('Could not split this section completely. Review saved speeds before trying again.');
      await loadRows();
    }
    setBusyGeohash(null);
  };

  const undoKnowledgeChange = async () => {
    setBusyGeohash('undo');
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const undone = await knowledge.undo().catch(() => false);
    if (!undone) {
      setStatus('There is no saved road-speed change to undo.');
      setBusyGeohash(null);
      return;
    }
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    const updatedTrips = beforeKnowledge && afterKnowledge
      ? await refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
      : null;
    setStatus(updatedTrips
      ? `Change undone. Recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.`
      : 'Change undone, but affected trips could not be recalculated right now.');
    setBusyGeohash(null);
    await loadRows();
  };

  const exportSpeedKnowledge = async () => {
    const data = await knowledge.exportData();
    const payload = {
      app: 'Road Sage',
      format: 'road-sage-speed-knowledge',
      version: 1,
      exported_at: new Date().toISOString(),
      speed_knowledge: data,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `road-sage-speed-rules-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${rows.length} saved road-speed rule${rows.length === 1 ? '' : 's'} as JSON.`);
  };

  const importSpeedKnowledge = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setStatus('Speed-rule backup is too large. Choose a JSON file smaller than 5 MB.');
      return;
    }
    try {
      const payload = JSON.parse(await file.text());
      const data = payload?.speed_knowledge ?? payload?.data ?? payload;
      if (!data || typeof data !== 'object' || typeof data.cells !== 'object' || !Array.isArray(data.corrections)) {
        throw new Error('Invalid speed-rule backup');
      }
      const beforeKnowledge = await knowledge.exportData();
      await knowledge.replaceData(data, 'restore_speed_backup');
      const afterKnowledge = await knowledge.exportData();
      const updatedTrips = await refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null);
      setStatus(withUndo(updatedTrips
        ? `Restored ${data.corrections.length} saved road-speed rule${data.corrections.length === 1 ? '' : 's'} and recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.`
        : `Restored ${data.corrections.length} saved road-speed rule${data.corrections.length === 1 ? '' : 's'}, but affected trips could not be recalculated right now.`));
      await loadRows();
    } catch {
      setStatus('Could not restore that file. Choose a Road Sage speed-rule or full-backup JSON file.');
    }
  };

  const toggleSelectedRow = (key) => {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectVisibleRows = () => {
    setSelectedRows((current) => {
      const next = new Set(current);
      const allSelected = visibleRows.length > 0 && visibleRows.every((row) => next.has(correctionKey(row)));
      visibleRows.forEach((row) => {
        const key = correctionKey(row);
        if (allSelected) next.delete(key);
        else next.add(key);
      });
      return next;
    });
  };

  const confirmSelectedAsPosted = async () => {
    const selected = rows.filter((row) => selectedRows.has(correctionKey(row)));
    if (!selected.length) return;
    const historyGroup = `bulk-confirm-${Date.now()}`;
    setBusyGeohash('bulk');
    const results = await Promise.all(selected.map((row) => knowledge.updateUserCorrection(
      correctionKey(row),
      row.limitKmh,
      'user_confirmed_posted_sign',
      row.note || 'Bulk confirmed from saved speed review',
      { historyGroup }
    ).catch(() => false)));
    const updated = selected.filter((_, index) => results[index]);
    await Promise.all(updated.map((row) => refreshTripsCrossingLocalSpeedCorrection(row).catch(() => null)));
    setSelectedRows(new Set());
    setStatus(withUndo(`Confirmed ${updated.length} selected rule${updated.length === 1 ? '' : 's'} as posted signs.`));
    setBusyGeohash(null);
    await loadRows();
  };

  const deleteSelectedRows = async () => {
    const selected = rows.filter((row) => selectedRows.has(correctionKey(row)));
    if (!selected.length) return;
    if (!window.confirm(`Delete ${selected.length} selected saved road-speed rule${selected.length === 1 ? '' : 's'}?`)) return;
    const historyGroup = `bulk-delete-${Date.now()}`;
    setBusyGeohash('bulk');
    const results = await Promise.all(selected.map((row) => (
      knowledge.removeUserCorrection(correctionKey(row), { historyGroup }).catch(() => false)
    )));
    const removed = selected.filter((_, index) => results[index]);
    await Promise.all(removed.map((row) => refreshTripsCrossingLocalSpeedCorrection(row).catch(() => null)));
    setSelectedRows(new Set());
    setStatus(withUndo(`Deleted ${removed.length} selected rule${removed.length === 1 ? '' : 's'}.`));
    setBusyGeohash(null);
    await loadRows();
  };

  const cleanExpiredSpeedKnowledge = async () => {
    const beforeKnowledge = await knowledge.exportData();
    await knowledge.prune(180);
    const afterKnowledge = await knowledge.exportData();
    const updatedTrips = await refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null);
    setStatus(withUndo(updatedTrips
      ? `Removed expired rules and learned evidence older than 180 days. Recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.`
      : 'Removed expired rules and learned evidence older than 180 days, but affected trips could not be recalculated right now.'));
    await loadRows();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-grotesk text-2xl font-bold tracking-tight">Saved road speeds</h1>
            <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground">
              {rows.length} saved
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            User-set road speeds used by trip review, map speed colors, speed zones, and scoring.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={restoreInputRef}
            type="file"
            accept=".json,application/json"
            onChange={importSpeedKnowledge}
            className="hidden"
            aria-label="Restore speed-rule JSON"
          />
          {tripId && (
            <Link
              to={`/trips/${tripId}?review=speed-limit-conflicts`}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Trip review
            </Link>
          )}
          <button
            type="button"
            onClick={exportSpeedKnowledge}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-secondary"
            title="Export speed rules only"
            aria-label="Export speed rules only"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => restoreInputRef.current?.click()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-secondary"
            title="Restore speed rules"
            aria-label="Restore speed rules"
          >
            <Upload className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => loadRows()}
            disabled={loading}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {status && (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium" aria-live="polite">
          <div className="min-w-0 flex-1">
            {typeof status === 'string' ? status : (
              <div className="space-y-2">
                <div>{status.message}</div>
                {status.scoreDeltas?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    {status.scoreDeltas.slice(0, 6).map(({ trip, text, changed }) => (
                      <Link
                        key={trip.id}
                        to={`/trips/${trip.id}`}
                        className={`rounded-full px-2 py-1 font-semibold ${
                          changed
                            ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200'
                            : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
                        }`}
                      >
                        {tripLabel(trip)}: {text}
                      </Link>
                    ))}
                    {status.scoreDeltas.length > 6 && (
                      <span className="rounded-full bg-secondary px-2 py-1 text-muted-foreground">
                        +{status.scoreDeltas.length - 6} more
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {typeof status === 'object' && status.canUndo && historyState.canUndo && (
            <button
              type="button"
              onClick={undoKnowledgeChange}
              disabled={loading || busyGeohash === 'undo'}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-50"
            >
              <Undo2 className="h-3.5 w-3.5" />
              Undo {undoActionText(historyState.undoLabel)}
            </button>
          )}
        </div>
      )}

      <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Saved rules
          </div>
          <div className="mt-1 text-2xl font-bold">{rows.length}</div>
        </div>
        <div className="rounded-xl border border-border bg-card px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5" />
            Conflicts
          </div>
          <div className="mt-1 text-2xl font-bold text-red-600">{mapStats.conflicts}</div>
        </div>
        <div className="rounded-xl border border-border bg-card px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase text-muted-foreground">
            <Layers className="h-3.5 w-3.5" />
            Observed only
          </div>
          <div className="mt-1 text-2xl font-bold">{mapStats.observedOnly}</div>
        </div>
        <div className="rounded-xl border border-border bg-card px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" />
            Map sections
          </div>
          <div className="mt-1 text-2xl font-bold">{mapStats.total}</div>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-primary" />
              <h2 className="font-grotesk text-lg font-bold">Needs attention</h2>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                {attentionItems.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Review conflicts first, then save observed-only or unset road speeds from the map.
            </p>
          </div>
          {firstConflictSection && (
            <button
              type="button"
              onClick={() => focusAttentionItem({ kind: 'conflict', section: firstConflictSection })}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Review first conflict
            </button>
          )}
        </div>
        {attentionItems.length === 0 ? (
          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
            No conflicts or missing speed sections need attention right now.
          </div>
        ) : (
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {attentionItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => focusAttentionItem(item)}
                className={`rounded-xl border p-3 text-left text-sm transition-colors hover:bg-secondary/70 ${
                  item.kind === 'conflict'
                    ? 'border-red-200 bg-red-50/80 dark:border-red-900/50 dark:bg-red-950/20'
                    : 'border-border bg-secondary/30'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{item.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{item.detail}</div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    item.kind === 'conflict'
                      ? 'bg-red-600 text-white'
                      : item.kind === 'observed'
                        ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                        : 'bg-secondary text-muted-foreground'
                  }`}>
                    {item.kind === 'conflict' ? 'Resolve' : item.kind === 'observed' ? 'Save' : 'Set'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className={`rounded-xl border p-3 ${
        health?.healthy
          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30'
          : 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30'
      }`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <HeartPulse className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div>
              <h2 className="text-sm font-semibold">Local data health</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {health?.healthy
                  ? 'No conflicts, expired rules, stale evidence, invalid geometry, or road-level disagreements were found.'
                  : `${health?.issueCount || 0} issue${health?.issueCount === 1 ? '' : 's'} found: ${health?.counts?.high || 0} high, ${health?.counts?.medium || 0} medium, ${health?.counts?.low || 0} low.`}
              </p>
              {!health?.healthy && health?.issues?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold">
                  {Object.entries(health.counts || {})
                    .filter(([key, count]) => !['high', 'medium', 'low'].includes(key) && count > 0)
                    .map(([key, count]) => (
                      <span key={key} className="rounded-full bg-background/80 px-2 py-1">
                        {String(key).replace(/_/g, ' ')} {count}
                      </span>
                    ))}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={cleanExpiredSpeedKnowledge}
            disabled={!health || (!health.counts?.expired_rule && !health.counts?.stale_cell)}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clean expired
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <MapIcon className="h-5 w-5 text-primary" />
              <h2 className="font-grotesk text-lg font-bold">Road speed map</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Speed badges stay visible on each section. Solid sections are saved, dashed sections are trip observations, and red sections disagree with saved data.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div className="inline-flex rounded-xl border border-border bg-secondary/50 p-1">
              {[
                ['review', 'Review'],
                ['edit', 'Edit'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setMapMode(value);
                    if (value === 'review') setAddMode(false);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                    mapMode === value
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  aria-pressed={mapMode === value}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap justify-start gap-2 sm:justify-end">
              {firstConflictSection && (
                <button
                  type="button"
                  onClick={() => focusAttentionItem({ kind: 'conflict', section: firstConflictSection })}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Review conflict
                </button>
              )}
              <button
                type="button"
                onClick={addMode ? () => {
                  setAddMode(false);
                  setAddPath([]);
                  setSelectedSection(null);
                } : startAddingSection}
                disabled={mapMode !== 'edit' && !addMode}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold ${
                  addMode ? 'border border-border bg-secondary text-foreground' : 'bg-primary text-primary-foreground'
                } disabled:opacity-50`}
              >
                {addMode ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                {addMode ? 'Cancel adding' : 'Add road speed'}
              </button>
              <button
                type="button"
                onClick={() => setAutoSnapTrace((value) => !value)}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold ${
                  autoSnapTrace
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200'
                    : 'border-border bg-card text-muted-foreground'
                }`}
                aria-pressed={autoSnapTrace}
              >
                <Magnet className="h-3.5 w-3.5" />
                Auto snap
              </button>
            </div>
            <label className="relative w-full sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={mapQuery}
                onChange={(event) => setMapQuery(event.target.value)}
                placeholder="Search map by road, source, speed..."
                className="w-full rounded-xl border border-border bg-background py-2 pl-9 pr-3 text-xs outline-none focus:border-primary"
              />
            </label>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span><span className="mr-1 inline-block h-2.5 w-5 rounded bg-slate-400" />Not set</span>
              <span><span className="mr-1 inline-block h-2.5 w-5 rounded border-2 border-dashed border-sky-500 bg-sky-100" />Observed</span>
              <span><span className="mr-1 inline-block h-2.5 w-5 rounded bg-red-600" />Conflict</span>
              {[30, 40, 50, 60, 80, 100].map((limit) => (
                <span key={limit}>
                  <span className="mr-1 inline-block h-2.5 w-5 rounded" style={{ backgroundColor: speedLimitColor(limit) }} />
                  {limit}
                </span>
              ))}
              <span>km/h</span>
            </div>
          </div>
        </div>

        <SpeedLimitEditorMap
          trips={mapTrips}
          corrections={rows}
          preparedSections={mapSections}
          selectedGeohash={correctionKey(selectedSection) || ''}
          mapQuery={mapQuery}
          layers={mapLayers}
          addMode={addMode}
          addPath={addPath}
          onLayerChange={setMapLayers}
          onSelect={selectMapSection}
          onAddPoint={selectNewMapPoint}
          onMoveAddPoint={moveAddPoint}
        />

        {addMode && (
          <div className="grid gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 shadow-sm dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <div className="font-semibold">Add speed trace</div>
              <div className="mt-1 text-xs opacity-85">
                Tap along the road, drag trace points if needed, then enter the speed below. Auto snap uses only recorded trip geometry.
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs font-semibold">
                <span className="rounded-full bg-background/80 px-2 py-1">{addPath.length} point{addPath.length === 1 ? '' : 's'}</span>
                <span className="rounded-full bg-background/80 px-2 py-1">{Math.round(traceLengthM)} m traced</span>
                <span className="rounded-full bg-background/80 px-2 py-1">{autoSnapTrace ? 'Auto snap on' : 'Auto snap off'}</span>
              </div>
            </div>
            {traceQuality && (
              <div className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                traceQuality.level === 'good'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200'
                  : traceQuality.level === 'info'
                    ? 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200'
                    : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100'
              }`}>
                {traceQuality.text}
              </div>
            )}
          </div>
        )}

        <details className="rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-semibold text-foreground">What the map actions do</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <p><strong>Snap to route</strong> moves each traced point to the nearest recorded trip sample within 80 metres. It never contacts a routing service.</p>
            <p><strong>Split at midpoint</strong> replaces one saved rule with two independently editable road sections.</p>
            <p><strong>Merge nearby</strong> joins two nearby saved sections only when their speeds match.</p>
            <p><strong>Continue tracing</strong> means the road is still being drawn. It disappears immediately after a successful save.</p>
          </div>
        </details>

        {selectedSection && (
          <div className="rounded-2xl border border-primary/30 bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-primary">
                  {selectedSection.saved ? 'Edit saved section' : 'Set road speed'}
                </div>
                <h3 className="mt-1 font-semibold">
                  {mapDraft.roadName || selectedSection.roadName || `Road area ${selectedSection.geohash}`}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedSection.saved
                    ? 'This value follows the highlighted saved road section. Create a separate section where the posted limit changes.'
                    : addMode
                      ? `${addPath.length} trace point${addPath.length === 1 ? '' : 's'}. Tap along the road and around each bend; at least two points are required.`
                    : `${selectedSectionPointCount} recorded point${selectedSectionPointCount === 1 ? '' : 's'} in this trip section. Enter the speed and save it as a road section.`}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold">
                  <span className={`rounded-full px-2 py-0.5 ${speedLimitSourceBadgeClass(mapDraft.source)}`}>
                    {speedLimitSourceLabel(mapDraft.source, { short: true })}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
                    {speedLimitScorePreview(selectedSection.limitKmh ?? selectedSection.observedLimitKmh, mapDraft.limitKmh)}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
                    Observed {formatSpeedLimit(selectedSection.observedLimitKmh ?? selectedSection.effectiveLimitKmh)}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
                    {formatSourceList(selectedSection.observedSources)}
                  </span>
                  {selectedEvidence && (
                    <span className={`rounded-full px-2 py-0.5 ${
                      selectedEvidence.level === 'high'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                        : selectedEvidence.level === 'medium'
                          ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                          : 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                    }`}>
                      {speedLimitConfidenceLabel(selectedEvidence)} {selectedEvidence.confidencePercent}%
                    </span>
                  )}
                  {selectedImpactPreview && (
                    <span className="rounded-full bg-slate-900 px-2 py-0.5 text-white dark:bg-slate-100 dark:text-slate-900">
                      {selectedImpactPreview.affectedTripCount} affected trip{selectedImpactPreview.affectedTripCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {selectedSection.conflict && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700 dark:bg-red-950/40 dark:text-red-300">
                      Saved {selectedSection.conflict.savedLimitKmh} km/h vs observed {selectedSection.conflict.observedLimitKmh} km/h
                    </span>
                  )}
                </div>
                {!selectedSection.saved && addPath.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={undoAddPoint}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary px-2.5 py-1.5 text-xs font-semibold"
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      Undo last point
                    </button>
                    <button
                      type="button"
                      onClick={snapSelectedSectionToTrips}
                      disabled={selectedSectionPointCount < 2}
                      title="Move traced points to nearby recorded trip samples within 80 metres. No online routing service is used."
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                    >
                      <Magnet className="h-3.5 w-3.5" />
                      Snap to route
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedSection(null);
                  setAddPath([]);
                }}
                className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"
                aria-label="Close road speed editor"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr]">
              <div className="rounded-xl border border-border bg-secondary/30 p-3 text-xs">
                <div className="font-semibold text-foreground">Rule intelligence</div>
                <div className="mt-1 text-muted-foreground">
                  {selectedRecommendation?.text || 'Enter a speed limit to calculate a recommendation.'}
                </div>
                {selectedImpactPreview && (
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <div>
                      <div className="text-lg font-bold text-foreground">{selectedImpactPreview.affectedTripCount}</div>
                      <div className="text-muted-foreground">Trips</div>
                    </div>
                    <div>
                      <div className="text-lg font-bold text-foreground">{selectedImpactPreview.matchedPointCount}</div>
                      <div className="text-muted-foreground">Matched points</div>
                    </div>
                    <div>
                      <div className="text-lg font-bold text-foreground">{selectedImpactPreview.estimatedEventCount}</div>
                      <div className="text-muted-foreground">Likely events</div>
                    </div>
                  </div>
                )}
              </div>
              <div className="rounded-xl border border-border bg-background p-3 text-xs">
                <div className="font-semibold text-foreground">Validation</div>
                {editorWarnings.length > 0 ? (
                  <div className="mt-2 space-y-1 text-muted-foreground">
                    {editorWarnings.map((warning) => <div key={warning}>- {warning}</div>)}
                  </div>
                ) : (
                  <div className="mt-2 text-emerald-700 dark:text-emerald-300">Geometry, evidence, and trip coverage checks passed.</div>
                )}
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-[12rem_14rem_1fr_1fr_auto] xl:items-end">
              <label className="grid gap-1 text-xs font-semibold">
                Speed limit
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="5"
                    step="5"
                    autoFocus
                    value={mapDraft.limitKmh}
                    onChange={(event) => setMapDraft((current) => ({ ...current, limitKmh: event.target.value }))}
                    className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <span className="text-muted-foreground">km/h</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {COMMON_SPEED_LIMITS_KMH.map((limit) => (
                    <button
                      key={limit}
                      type="button"
                      onClick={() => setMapDraft((current) => ({ ...current, limitKmh: String(limit) }))}
                      className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${
                        Number(mapDraft.limitKmh) === limit
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-secondary text-foreground hover:bg-secondary/80'
                      }`}
                    >
                      {limit}
                    </button>
                  ))}
                </div>
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Road name
                <input
                  type="text"
                  value={mapDraft.roadName}
                  onChange={(event) => setMapDraft((current) => ({ ...current, roadName: event.target.value }))}
                  placeholder="Optional road name"
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Evidence
                <select
                  value={mapDraft.source}
                  onChange={(event) => setMapDraft((current) => ({ ...current, source: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="user_confirmed_posted_sign">Posted sign</option>
                  <option value="user_entered_estimate">Estimate</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Optional note
                <input
                  type="text"
                  value={mapDraft.note}
                  onChange={(event) => setMapDraft((current) => ({ ...current, note: event.target.value }))}
                  placeholder="School zone, construction, sign changed..."
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveMapSection}
                  disabled={busyGeohash === correctionKey(selectedSection) || !canSaveSelectedMapSection}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {selectedSection.saved ? <Pencil className="h-3.5 w-3.5" /> : <Gauge className="h-3.5 w-3.5" />}
                  {selectedSection.saved ? 'Update' : 'Save'}
                </button>
                {selectedSection.saved && (
                  <button
                    type="button"
                    onClick={removeMapSection}
                    disabled={busyGeohash === correctionKey(selectedSection)}
                    className="inline-flex items-center justify-center rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-700 disabled:opacity-60 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                    aria-label="Remove saved speed"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <div className="mt-3 grid gap-3 rounded-xl border border-border bg-secondary/30 p-3 md:grid-cols-5">
              <label className="grid gap-1 text-xs font-semibold">
                Applies by direction
                <select
                  value={mapDraft.directionMode}
                  onChange={(event) => setMapDraft((current) => ({ ...current, directionMode: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="both">Both directions</option>
                  <option value="forward">Drawn direction only</option>
                  <option value="reverse">Opposite direction only</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Active days
                <select
                  value={mapDraft.timeRuleMode}
                  onChange={(event) => setMapDraft((current) => ({ ...current, timeRuleMode: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="always">Always active</option>
                  <option value="daily">Every day</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="weekends">Weekends</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Start time
                <input
                  type="time"
                  value={mapDraft.startTime}
                  disabled={mapDraft.timeRuleMode === 'always'}
                  onChange={(event) => setMapDraft((current) => ({ ...current, startTime: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                End time
                <input
                  type="time"
                  value={mapDraft.endTime}
                  disabled={mapDraft.timeRuleMode === 'always'}
                  onChange={(event) => setMapDraft((current) => ({ ...current, endTime: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Active until
                <input
                  type="date"
                  value={mapDraft.expiresAtDate}
                  onChange={(event) => setMapDraft((current) => ({ ...current, expiresAtDate: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
            </div>
            {selectedSection.saved && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={snapSelectedSectionToTrips}
                  disabled={busyGeohash === correctionKey(selectedSection) || (selectedSection.sectionPoints || []).length < 2}
                  title="Move this saved geometry to nearby recorded trip samples within 80 metres. No online routing service is used."
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                >
                  <Magnet className="h-3.5 w-3.5" />
                  Snap to route
                </button>
                <button
                  type="button"
                  onClick={splitMapSection}
                  disabled={busyGeohash === correctionKey(selectedSection) || (selectedSection.sectionPoints || []).length < 3}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                >
                  Split at midpoint
                </button>
                {mergeCandidate && (
                  <button
                    type="button"
                    onClick={prepareMergeWithNearbySection}
                    disabled={busyGeohash === correctionKey(selectedSection)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                  >
                    <GitMerge className="h-3.5 w-3.5" />
                    Merge nearby ({Math.round(mergeCandidate.distanceM)} m)
                  </button>
                )}
                {selectedSection.conflict && (
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                    <span>
                      Conflict: saved {selectedSection.conflict.savedLimitKmh} km/h, trip data suggests {selectedSection.conflict.observedLimitKmh} km/h
                    </span>
                    <button
                      type="button"
                      onClick={() => resolveSavedSpeedConflict(selectedSection, selectedSection.conflict, 'use_observed', mapDraft)}
                      disabled={busyGeohash === correctionKey(selectedSection)}
                      className="rounded-lg bg-red-600 px-2.5 py-1.5 text-white hover:bg-red-700 disabled:opacity-60"
                    >
                      Use observed {selectedSection.conflict.observedLimitKmh}
                    </button>
                    <button
                      type="button"
                      onClick={() => resolveSavedSpeedConflict(selectedSection, selectedSection.conflict, 'keep_saved', mapDraft)}
                      disabled={busyGeohash === correctionKey(selectedSection)}
                      className="rounded-lg border border-red-200 bg-background px-2.5 py-1.5 text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-900/50 dark:bg-background/80 dark:text-red-300"
                    >
                      Keep saved {selectedSection.conflict.savedLimitKmh}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-primary" />
              <h2 className="font-grotesk text-lg font-bold">Saved speed rules</h2>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                {filteredRows.length} shown
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Search, triage, and edit local speed rules without hunting through every saved road area.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_11rem] lg:w-[34rem]">
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={rowQuery}
                onChange={(event) => setRowQuery(event.target.value)}
                placeholder="Search saved speeds..."
                className="w-full rounded-xl border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-primary"
              />
            </label>
            <select
              value={rowSort}
              onChange={(event) => setRowSort(event.target.value)}
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              aria-label="Sort saved speeds"
            >
              {ROW_SORTS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {ROW_FILTERS.map(([value, label]) => {
            const active = rowFilter === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setRowFilter(value)}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-foreground hover:bg-secondary'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        {rows.length > 0 && (
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={selectVisibleRows}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold hover:bg-secondary"
            >
              <CheckSquare2 className="h-3.5 w-3.5" />
              {visibleRows.length > 0 && visibleRows.every((row) => selectedRows.has(correctionKey(row)))
                ? 'Clear visible'
                : 'Select visible'}
            </button>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">{selectedRows.size} selected</span>
              <button
                type="button"
                onClick={confirmSelectedAsPosted}
                disabled={selectedRows.size === 0 || busyGeohash === 'bulk'}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Confirm posted
              </button>
              <button
                type="button"
                onClick={deleteSelectedRows}
                disabled={selectedRows.size === 0 || busyGeohash === 'bulk'}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-40 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </div>
          </div>
        )}
      </section>

      {loading ? (
        <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          Loading saved speeds...
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
              <Gauge className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">No saved road speeds</h2>
              <p className="mt-1 text-sm text-muted-foreground">Use a trip speed review to save a posted sign or local estimate.</p>
            </div>
          </div>
          <Link
            to="/trips"
            className="mt-4 inline-flex items-center justify-center rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
          >
            Open trips
          </Link>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          No saved speeds match the current filters.
        </div>
      ) : (
        <div className="space-y-3">
          {visibleRows.map((row) => {
            const key = correctionKey(row);
            const draft = drafts[key] || {};
            const disabled = busyGeohash === key;
            const identity = correctionSectionIdentity(row, linkedTrip);
            const conflict = conflictsByGeohash.get(key);
            const rowEvidence = assessSpeedLimitEvidence(row);
            const rowRecommendation = buildSpeedLimitRecommendation({ ...row, conflict });
            const rowImpact = buildCorrectionImpactPreview(mapTrips, {
              ...row,
              limitKmh: Number(draft.limitKmh || row.limitKmh),
              directionMode: draft.directionMode || row.directionMode,
              timeRule: timeRuleFromDraft(draft),
            }, draft.limitKmh || row.limitKmh);
            return (
              <article key={key} className="rounded-xl border border-border bg-card p-3 shadow-sm">
                <div className="grid gap-3 lg:grid-cols-[1fr_16rem_13rem] lg:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-background">
                        <input
                          type="checkbox"
                          checked={selectedRows.has(key)}
                          onChange={() => toggleSelectedRow(key)}
                          className="h-4 w-4 accent-primary"
                          aria-label={`Select ${identity.title}`}
                        />
                      </label>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-foreground">
                        <MapPin className="h-3.5 w-3.5" />
                        {identity.title}
                      </span>
                    </div>
                    <div className="mt-2">
                      <RoadSectionPreview
                        identity={identity}
                        routePoints={linkedTrip?.route_points || []}
                        legacyApproximate={row.coordinateSource === 'geohash_cell_center_legacy'}
                      />
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">Current value</div>
                        <div className="font-semibold">{Math.round(Number(row.limitKmh) || 0)} km/h</div>
                      </div>
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">Type</div>
                        <div>
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${speedLimitSourceBadgeClass(row.source)}`}>
                            {sourceLabel(row.source)}
                          </span>
                        </div>
                      </div>
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">Updated</div>
                        <div className="truncate font-semibold">{formatDate(row.appliedAt)}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold text-muted-foreground">
                      <span className="rounded-full bg-secondary px-2 py-1">{directionLabel(row.directionMode)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">{timeRuleLabel(row.timeRule)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">{expiryLabel(row.expiresAt)}</span>
                      <span className={`rounded-full px-2 py-1 ${
                        rowEvidence.level === 'high'
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                          : rowEvidence.level === 'medium'
                            ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                            : 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                      }`}>
                        {speedLimitConfidenceLabel(rowEvidence)} {rowEvidence.confidencePercent}%
                      </span>
                      <span className="rounded-full bg-secondary px-2 py-1">
                        {rowImpact.affectedTripCount} affected trip{rowImpact.affectedTripCount === 1 ? '' : 's'}
                      </span>
                      <span className="rounded-full bg-secondary px-2 py-1">
                        {speedLimitScorePreview(row.limitKmh, draft.limitKmh)}
                      </span>
                      {conflict && (
                        <span className="rounded-full bg-red-100 px-2 py-1 text-red-700 dark:bg-red-950/40 dark:text-red-300">
                          Conflict: trip data suggests {conflict.observedLimitKmh} km/h
                        </span>
                      )}
                      {Array.isArray(row.editHistory) && row.editHistory.length > 0 && (
                        <span className="rounded-full bg-secondary px-2 py-1">{row.editHistory.length} previous edit{row.editHistory.length === 1 ? '' : 's'}</span>
                      )}
                    </div>
                    <div className="mt-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs">
                      <div className="font-semibold text-foreground">{rowRecommendation.action}</div>
                      <div className="mt-1 text-muted-foreground">{rowRecommendation.text}</div>
                    </div>
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer font-medium">Saved location reference</summary>
                      <div className="mt-1">
                        {coordinateLabel(row.coordinateSource)}: {formatCoordinate(row.lat)}, {formatCoordinate(row.lng)}; cell {row.geohash}
                      </div>
                    </details>
                    {Array.isArray(row.auditTrail) && row.auditTrail.length > 0 && (
                      <details className="mt-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer font-medium">Audit history ({row.auditTrail.length})</summary>
                        <div className="mt-2 space-y-1">
                          {[...row.auditTrail].reverse().slice(0, 5).map((entry, index) => (
                            <div key={`${entry.changedAt}-${index}`}>
                              {formatDate(entry.changedAt)}: {String(entry.action || 'updated').replace(/_/g, ' ')}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>

                  <div className="grid gap-2">
                    <label className="flex items-center gap-2 text-xs font-semibold text-foreground">
                      <Gauge className="h-4 w-4 text-muted-foreground" />
                      <input
                        type="number"
                        min="5"
                        step="5"
                        value={draft.limitKmh ?? ''}
                        onChange={(event) => updateDraft(key, { limitKmh: event.target.value })}
                        className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <span className="text-xs text-muted-foreground">km/h</span>
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {COMMON_SPEED_LIMITS_KMH.map((limit) => (
                        <button
                          key={limit}
                          type="button"
                          onClick={() => updateDraft(key, { limitKmh: String(limit) })}
                          className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${
                            Number(draft.limitKmh) === limit
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-secondary/80 text-foreground hover:bg-secondary'
                          }`}
                        >
                          {limit}
                        </button>
                      ))}
                    </div>
                    <select
                      value={draft.source || 'user_entered_estimate'}
                      onChange={(event) => updateDraft(key, { source: event.target.value })}
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    >
                      <option value="user_confirmed_posted_sign">Posted sign</option>
                      <option value="user_entered_estimate">Estimate</option>
                    </select>
                    <input
                      type="text"
                      value={draft.roadName ?? ''}
                      onChange={(event) => updateDraft(key, { roadName: event.target.value })}
                      placeholder="Road name (optional)"
                      aria-label={`Road name for ${identity.title}`}
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                    <input
                      type="text"
                      value={draft.note ?? ''}
                      onChange={(event) => updateDraft(key, { note: event.target.value })}
                      placeholder="Note"
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                    <select
                      value={draft.directionMode || 'both'}
                      onChange={(event) => updateDraft(key, { directionMode: event.target.value })}
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    >
                      <option value="both">Both directions</option>
                      <option value="forward">Drawn direction only</option>
                      <option value="reverse">Opposite direction only</option>
                    </select>
                    <div
                      className={`grid gap-2 ${
                        (draft.timeRuleMode || 'always') === 'always'
                          ? 'grid-cols-1'
                          : 'grid-cols-2 sm:grid-cols-3'
                      }`}
                    >
                      <select
                        value={draft.timeRuleMode || 'always'}
                        onChange={(event) => updateDraft(key, { timeRuleMode: event.target.value })}
                        className={`min-w-0 rounded-xl border border-border bg-background px-2 py-2 text-xs outline-none focus:border-primary ${
                          (draft.timeRuleMode || 'always') === 'always' ? '' : 'col-span-2 sm:col-span-1'
                        }`}
                        aria-label="Active days"
                      >
                        <option value="always">Always</option>
                        <option value="daily">Daily</option>
                        <option value="weekdays">Weekdays</option>
                        <option value="weekends">Weekends</option>
                      </select>
                      {(draft.timeRuleMode || 'always') !== 'always' && (
                        <>
                          <input
                            type="time"
                            value={draft.startTime || '07:00'}
                            onChange={(event) => updateDraft(key, { startTime: event.target.value })}
                            className="min-w-0 w-full rounded-xl border border-border bg-background px-2 py-2 text-xs outline-none focus:border-primary"
                            aria-label="Start time"
                          />
                          <input
                            type="time"
                            value={draft.endTime || '17:00'}
                            onChange={(event) => updateDraft(key, { endTime: event.target.value })}
                            className="min-w-0 w-full rounded-xl border border-border bg-background px-2 py-2 text-xs outline-none focus:border-primary"
                            aria-label="End time"
                          />
                        </>
                      )}
                    </div>
                    <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                      Active until
                      <input
                        type="date"
                        value={draft.expiresAtDate || ''}
                        onChange={(event) => updateDraft(key, { expiresAtDate: event.target.value })}
                        className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                    {conflict && (
                      <>
                        <button
                          type="button"
                          onClick={() => resolveSavedSpeedConflict(row, conflict, 'use_observed', draft)}
                          disabled={disabled}
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                        >
                          <Gauge className="h-3.5 w-3.5" />
                          Use observed {conflict.observedLimitKmh}
                        </button>
                        <button
                          type="button"
                          onClick={() => resolveSavedSpeedConflict(row, conflict, 'keep_saved', draft)}
                          disabled={disabled}
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                        >
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Keep saved {conflict.savedLimitKmh}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => saveRow(row)}
                      disabled={disabled}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                    >
                      {draft.source === 'user_confirmed_posted_sign' ? <ShieldCheck className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                      Update
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRow(row)}
                      disabled={disabled}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
          {pageCount > 1 && (
            <nav
              className="flex items-center justify-between gap-3 border-t border-border pt-3"
              aria-label="Saved road speed pages"
            >
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page === 1}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
                title="Previous page"
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="text-center text-xs text-muted-foreground">
                <div className="font-semibold text-foreground">Page {page} of {pageCount}</div>
                <div>
                  Showing {(page - 1) * SPEEDS_PER_PAGE + 1}-{Math.min(page * SPEEDS_PER_PAGE, filteredRows.length)} of {filteredRows.length}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                disabled={page === pageCount}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
                title="Next page"
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </nav>
          )}
        </div>
      )}

      <section className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div className="min-w-0">
            <h2 className="font-semibold">How saved road speeds are used</h2>
            <div className="mt-2 grid gap-2 text-xs leading-relaxed">
              <p>
                Speeds you add, edit, split, expire, or delete here are saved locally on this device. When a saved rule matches the road, direction, date, and time, Road Sage uses it first for trip scoring, map colors, speed checks, and voice alerts.
              </p>
              <p>
                If no matching saved rule is available, Road Sage falls back to learned local data, OpenStreetMap/Get Road Data results, then lower-confidence road-type, regional, or GPS estimates.
              </p>
              <p>
                Your saved speed, road name, notes, split sections, direction rules, and time rules are not uploaded to OpenStreetMap. Get Road Data only sends privacy-filtered public-road bounding boxes to an OpenStreetMap Overpass service, which may receive normal network metadata such as your IP address.
              </p>
              <p>
                This map uses OpenStreetMap tiles while online. Saved roads, trip geometry, editing, and speed labels remain available offline, but standard OpenStreetMap tiles are not downloaded for offline use. Tile providers can see the map tile area viewed and normal network metadata.
              </p>
              <p>
                Settings warning margins change when Road Sage warns you; they do not change the saved speed itself.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
