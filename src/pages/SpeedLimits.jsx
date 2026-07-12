// @ts-check
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowLeft, Ban, CheckSquare2, Download, Gauge, GitMerge, HeartPulse, Info, Layers, Magnet, Map as MapIcon, MapPin, Pencil, Plus, RefreshCw, Scissors, Search, ShieldCheck, SlidersHorizontal, Trash2, Undo2, Upload, X } from 'lucide-react';
import { geohashEncode, LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import { refreshTripsCrossingLocalSpeedCorrection, refreshTripsForLocalSpeedKnowledgeChanges, tripCrossesCorrection } from '@/lib/localSpeedScoreRefresh';
import { correctionSectionIdentity } from '@/lib/roadSectionIdentity';
import RoadSectionPreview from '@/components/RoadSectionPreview';
import SpeedLimitEditorMap from '@/components/SpeedLimitEditorMap';
import { TRIAGE_DISABLE_MAPS } from '@/lib/performanceTriage';
import {
  SPEED_MAP_LAYER_FOCUSED_DEFAULTS,
  buildSpeedMapSections,
  buildSplitCorrections,
  buildSpeedZoneReviewItems,
  findOverlappingSpeedSections,
  findMergeableSpeedSection,
  mergeSpeedSections,
  snapSectionPointsToTripRoutesWithStats,
  speedMapSectionFlags,
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
import {
  isSpeedSectionExcluded,
  readExcludedSpeedSectionKeys,
  speedSectionExclusionKeys,
  writeExcludedSpeedSectionKeys,
} from '@/lib/speedSectionExclusions';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { isNativePlatform } from '@/lib/nativePlatform';
import { logSystemFailure } from '@/lib/systemLog';
import InlineRefreshBadge from '@/components/InlineRefreshBadge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/use-toast';
import { requestAppConfirm } from '@/lib/appDialog';

const sourceLabel = (source) => speedLimitSourceLabel(source, { short: true });
const correctionKey = (correction = {}) => correction?.id || correction?.ruleId || correction?.sectionKey || correction?.geohash;
const IGNORED_UNSET_SPEED_SECTIONS_STORAGE_KEY = 'roadsage_ignored_unset_speed_sections_v1';
const SPEED_RULE_EXPORT_PRIVACY_WARNING = [
  'This export contains precise road locations, map-line coordinates, and your saved speed rules.',
  'Store it securely and share it only with people you trust.',
  '',
  'Continue with the export?',
].join('\n');

const formatSpeedLimit = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? `${Math.round(number)} km/h` : 'Unknown';
};

const formatSourceList = (sources = []) => {
  const labels = [...new Set((sources || []).filter(Boolean).map(sourceLabel))];
  return labels.length ? labels.join(', ') : 'Unknown source';
};

const isUnsetMapSection = (section = {}) => (
  !section.saved &&
  !Number(section.effectiveLimitKmh ?? section.observedLimitKmh ?? section.limitKmh)
);

const ignoredUnsetSectionKey = (section = {}) => String(correctionKey(section) || '').trim();

const readIgnoredUnsetSectionKeys = () => {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(IGNORED_UNSET_SPEED_SECTIONS_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
};

const speedSectionAttentionLabel = (section = {}) => {
  const flags = speedMapSectionFlags(section);
  if (flags.expired) return 'Expired temporary rule';
  if (flags.expiring) return 'Temporary rule expiring soon';
  if (flags.stale) return 'Stale speed evidence';
  if (flags.lowConfidence) return 'Low-confidence speed evidence';
  if (flags.missingGeometry) return 'Needs traced road line';
  if (flags.estimate) return 'Estimate ready for confirmation';
  return 'Review saved rule';
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
  if (section.voiceSpeedMarker) {
    return section.posted_phrase_detected || section.source === 'voice_user_posted_sign'
      ? 'user_confirmed_posted_sign'
      : 'user_entered_estimate';
  }
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

const DEFAULT_MAP_DRAFT = {
  limitKmh: '',
  source: 'user_confirmed_posted_sign',
  note: '',
  roadName: '',
  directionMode: 'both',
  timeRuleMode: 'always',
  startTime: '07:00',
  endTime: '17:00',
  expiresAtDate: '',
};

const mapDraftForSection = (section = {}) => ({
  ...DEFAULT_MAP_DRAFT,
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

const normalizeMapDraftForCompare = (draft = {}) => JSON.stringify({
  limitKmh: String(draft.limitKmh ?? '').trim(),
  source: String(draft.source || DEFAULT_MAP_DRAFT.source),
  note: String(draft.note ?? ''),
  roadName: String(draft.roadName ?? ''),
  directionMode: String(draft.directionMode || DEFAULT_MAP_DRAFT.directionMode),
  timeRuleMode: String(draft.timeRuleMode || DEFAULT_MAP_DRAFT.timeRuleMode),
  startTime: String(draft.startTime || DEFAULT_MAP_DRAFT.startTime),
  endTime: String(draft.endTime || DEFAULT_MAP_DRAFT.endTime),
  expiresAtDate: String(draft.expiresAtDate || ''),
});

const normalizePointForCompare = (point = {}) => {
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  return Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) }
    : null;
};

const normalizeSectionPointsForCompare = (section = {}) => {
  const points = Array.isArray(section.sectionPoints) && section.sectionPoints.length
    ? section.sectionPoints
    : [section];
  return points
    .map(normalizePointForCompare)
    .filter(Boolean);
};

const sectionGeometryCompareKey = (section = {}) => JSON.stringify(normalizeSectionPointsForCompare(section));

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
const SPEED_WORKSPACES = [
  { value: 'map', label: 'Map', Icon: MapIcon },
  { value: 'review', label: 'Needs review', Icon: AlertTriangle },
  { value: 'saved', label: 'Saved roads', Icon: SlidersHorizontal },
];
const MAP_MODEL_WORKSPACES = new Set(['map', 'review']);

const speedSummaryMetrics = (rows, mapStats) => [
  { key: 'saved', label: 'Saved', value: rows.length, Icon: ShieldCheck, className: 'text-foreground' },
  { key: 'conflicts', label: 'Conflicts', value: mapStats.conflicts, Icon: AlertTriangle, className: 'text-red-600' },
  { key: 'observed', label: 'Observed only', value: mapStats.observedOnly, Icon: Layers, className: 'text-sky-600' },
  { key: 'sections', label: 'Map sections', value: mapStats.total, Icon: MapPin, className: 'text-foreground' },
  { key: 'posted', label: 'Posted', value: mapStats.posted, Icon: CheckSquare2, className: 'text-emerald-600' },
  { key: 'estimates', label: 'Estimates', value: mapStats.estimates, Icon: Gauge, className: 'text-sky-600' },
  { key: 'lowConfidence', label: 'Low conf.', value: mapStats.lowConfidence, Icon: Info, className: 'text-amber-600' },
  { key: 'missingGeometry', label: 'Needs line', value: mapStats.missingGeometry, Icon: MapPin, className: 'text-foreground' },
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

const sectionMidpoint = (points = []) => {
  const clean = (Array.isArray(points) ? points : [])
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  return clean[Math.floor(clean.length / 2)] || null;
};

const voiceSpeedMarkerKey = (marker = {}, index = 0) => String(
  marker.id ||
  marker.marker_id ||
  [
    marker.timestamp || marker.timestamp_ms || 'voice-marker',
    marker.lat,
    marker.lng,
    marker.speed_limit_kmh ?? marker.limitKmh,
    index,
  ].join(':')
);

const voiceSpeedMarkerLimit = (marker = {}) => {
  const limit = Number(marker.speed_limit_kmh ?? marker.limitKmh ?? marker.limit_kmh);
  return Number.isFinite(limit) && limit > 0 ? Math.round(limit) : null;
};

const isPendingVoiceSpeedMarker = (marker = {}) => (
  marker.review_status !== 'saved' &&
  marker.review_status !== 'ignored' &&
  Number.isFinite(Number(marker.lat)) &&
  Number.isFinite(Number(marker.lng)) &&
  marker.masked_for_privacy !== true &&
  marker.privacy_gap !== true &&
  Boolean(voiceSpeedMarkerLimit(marker))
);

const publicRoutePoints = (trip = {}) => (Array.isArray(trip.route_points) ? trip.route_points : [])
  .filter((point) => (
    Number.isFinite(Number(point?.lat)) &&
    Number.isFinite(Number(point?.lng)) &&
    point.masked_for_privacy !== true &&
    point.privacy_gap !== true
  ))
  .map((point, index) => ({ lat: Number(point.lat), lng: Number(point.lng), routeIndex: index }));

const voiceMarkerRouteSection = (trip = {}, marker = {}) => {
  const markerPoint = { lat: Number(marker.lat), lng: Number(marker.lng) };
  const routePoints = publicRoutePoints(trip);
  if (routePoints.length < 2) return [markerPoint];

  let nearestIndex = 0;
  let nearestDistanceM = Infinity;
  routePoints.forEach((point, index) => {
    const distanceM = distanceMeters(markerPoint, point);
    if (distanceM < nearestDistanceM) {
      nearestIndex = index;
      nearestDistanceM = distanceM;
    }
  });
  if (nearestDistanceM > 120) return [markerPoint];

  let start = nearestIndex;
  let end = nearestIndex;
  while (
    sectionLengthMeters(routePoints.slice(start, end + 1)) < 100 &&
    end - start < 12 &&
    (start > 0 || end < routePoints.length - 1)
  ) {
    if (start > 0) start -= 1;
    if (sectionLengthMeters(routePoints.slice(start, end + 1)) >= 100) break;
    if (end < routePoints.length - 1) end += 1;
  }
  const section = routePoints.slice(start, end + 1).map((point) => ({ lat: point.lat, lng: point.lng }));
  return section.length >= 2 ? section : [markerPoint];
};

const buildVoiceSpeedMarkerSections = (trips = []) => (Array.isArray(trips) ? trips : []).flatMap((trip, tripIndex) => {
  const markers = Array.isArray(trip?.voice_speed_limit_markers) ? trip.voice_speed_limit_markers : [];
  return markers
    .map((marker, markerIndex) => {
      if (!isPendingVoiceSpeedMarker(marker)) return null;
      const limitKmh = voiceSpeedMarkerLimit(marker);
      const lat = Number(marker.lat);
      const lng = Number(marker.lng);
      const key = voiceSpeedMarkerKey(marker, markerIndex);
      const sectionPoints = voiceMarkerRouteSection(trip, marker);
      const markerTripLabel = tripLabel(trip);
      return {
        id: `voice-speed-${trip?.id || tripIndex}-${key}`,
        sectionKey: `voice-speed-${trip?.id || tripIndex}-${key}`,
        geohash: geohashEncode(lat, lng),
        lat,
        lng,
        saved: false,
        voiceSpeedMarker: true,
        voiceTripId: trip?.id || null,
        voiceMarkerKey: key,
        voiceMarkerIndex: markerIndex,
        source: marker.source || (marker.posted_phrase_detected ? 'voice_user_posted_sign' : 'voice_user_estimate'),
        observedSources: [marker.source || (marker.posted_phrase_detected ? 'voice_user_posted_sign' : 'voice_user_estimate')],
        observedLimitKmh: limitKmh,
        effectiveLimitKmh: limitKmh,
        sampleCount: sectionPoints.length,
        sectionPoints,
        roadName: marker.road_name || '',
        contextLabel: `Voice marker from ${markerTripLabel}`,
        note: marker.transcript ? `Voice marker heard: ${marker.transcript}` : 'Saved from a voice speed marker.',
        transcript: marker.transcript || '',
        posted_phrase_detected: marker.posted_phrase_detected === true,
        directionBearing: Number.isFinite(Number(marker.heading)) ? Number(marker.heading) : undefined,
        tripLabel: markerTripLabel,
        timestamp: marker.timestamp || (marker.timestamp_ms ? new Date(marker.timestamp_ms).toISOString() : null),
      };
    })
    .filter(Boolean);
});

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
  repair_saved_speed_data: 'repair',
  restore_speed_backup: 'restore',
  restore_backup: 'restore',
  prune: 'cleanup',
}[action] || 'change');

const statusMessageText = (value) => (
  typeof value === 'string' ? value : String(value?.message || '')
);

const speedStatusToast = (value) => {
  const message = statusMessageText(value).trim();
  if (!message) return null;
  const lower = message.toLowerCase();
  if (
    lower.startsWith('could not') ||
    lower.startsWith('cannot') ||
    lower.startsWith('enter a valid') ||
    lower.startsWith('tap at least') ||
    lower.startsWith('this section needs') ||
    lower.startsWith('this road section needs') ||
    lower.startsWith('select ') ||
    lower.startsWith('there is no') ||
    lower.startsWith('speed-rule backup is too large') ||
    lower.startsWith('snap to route needs') ||
    lower.startsWith('no recorded route samples') ||
    lower.includes('failed')
  ) {
    return { title: 'Saved road speed issue', description: message, variant: 'destructive' };
  }
  if (
    lower.includes('matching trip scores are updating') ||
    lower.includes('affected trips could not be recalculated') ||
    lower.includes('matching trips could not be recalculated')
  ) {
    return { title: 'Saved road speed saved', description: message };
  }
  if (
    lower.startsWith('saved ') ||
    lower.startsWith('adding ') ||
    lower.startsWith('add road section') ||
    lower.startsWith('auto-snap ') ||
    lower.startsWith('choose ') ||
    lower.startsWith('saved road speeds refreshed') ||
    lower.startsWith('restored ') ||
    lower.startsWith('downloading ') ||
    lower.startsWith('exported ') ||
    lower.startsWith('change undone') ||
    lower.startsWith('conflict resolved') ||
    lower.startsWith('road section split') ||
    lower.startsWith('deleted ') ||
    lower.startsWith('confirmed ') ||
    lower.startsWith('removed expired') ||
    lower.startsWith('section snapped') ||
    lower.startsWith('snapped the line') ||
    lower.startsWith('saved snapped')
  ) {
    return { title: 'Saved road speed updated', description: message };
  }
  if (lower.startsWith('prepared a merged')) {
    return { title: 'Saved road speed ready', description: message };
  }
  return null;
};

const mapSectionReasonText = (section = {}, addMode = false) => {
  if (section.saved) {
    const source = sourceLabel(section.source);
    return `Saved local rule from ${source}; this rule is used before trip-derived map evidence.`;
  }
  if (addMode) return 'New traced road section; it will become a saved local rule after saving.';
  if (section.voiceSpeedMarker) {
    return `Voice speed marker from ${section.tripLabel || 'a completed trip'}; review the route line, then save it as a posted sign or estimate.`;
  }
  const points = Number(section.sampleCount || section.sectionPoints?.length || 0);
  const sampleText = points > 0 ? `${points} route sample${points === 1 ? '' : 's'}` : 'recorded route evidence';
  const observedLimit = Number(section.effectiveLimitKmh ?? section.observedLimitKmh);
  if (Number.isFinite(observedLimit) && observedLimit > 0) {
    return `Observed-only trip section from ${sampleText}; save it to turn it into a local posted sign or estimate.`;
  }
  return `Unset trip section from ${sampleText}; no saved rule covers this part of the recorded route yet.`;
};

const downloadBrowserJson = (filename, payload) => {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: 'application/json;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const saveSpeedKnowledgeExport = async (filename, payload) => {
  const data = `${JSON.stringify(payload, null, 2)}\n`;
  if (isNativePlatform()) {
    try {
      const result = await saveExportToDownloads({
        filename,
        data,
        mimeType: 'application/json',
      });
      return { native: true, filename, uri: result?.uri || null };
    } catch (error) {
      logSystemFailure('speed_knowledge_native_export_failed', error, {
        filename,
        native_fallback: true,
      });
    }
  }
  downloadBrowserJson(filename, payload);
  return { native: false, filename };
};

function SavedRoadSpeedsSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading saved road speeds">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-96 max-w-[75vw]" />
        </div>
        <Skeleton className="h-9 w-24 rounded-xl" />
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-20 rounded-xl" />)}
      </div>
      <Skeleton className="h-12 rounded-2xl" />
      <div className="rounded-2xl border border-border bg-card p-3">
        <Skeleton className="h-[28rem] min-h-[22rem] rounded-xl" />
      </div>
      <div className="space-y-3">
        {[1, 2, 3].map((item) => (
          <div key={item} className="rounded-xl border border-border bg-card p-4">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="mt-3 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-4/5" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading saved road speeds</span>
    </div>
  );
}

function MapModelSkeleton({ label = 'Loading map model...' }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-3 shadow-sm" role="status" aria-label={label}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-72 max-w-[70vw]" />
        </div>
        <Skeleton className="h-8 w-24 rounded-xl" />
      </div>
      <Skeleton className="h-[28rem] min-h-[22rem] rounded-xl" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export default function SpeedLimits() {
  const [searchParams] = useSearchParams();
  const tripId = searchParams.get('tripId');
  const initialWorkspace = ['map', 'review', 'saved'].includes(searchParams.get('view'))
    ? searchParams.get('view')
    : 'map';
  const knowledge = useMemo(() => new LocalSpeedKnowledge(speedKnowledgeStore), []);
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [mapModelState, setMapModelState] = useState({ status: 'idle', error: null });
  const mapModelStateRef = useRef({ status: 'idle', error: null });
  const [recalculationBusy, setRecalculationBusy] = useState(false);
  const recalculationCountRef = useRef(0);
  const loadedOnceRef = useRef(false);
  const [busyGeohash, setBusyGeohash] = useState(null);
  const [status, setStatus] = useState(/** @type {string | { message: string, scoreDeltas?: any[], canUndo?: boolean }} */ (''));
  const [linkedTrip, setLinkedTrip] = useState(null);
  const [mapTrips, setMapTrips] = useState([]);
  const [selectedSection, setSelectedSection] = useState(null);
  const [addMode, setAddMode] = useState(false);
  const [addPath, setAddPath] = useState([]);
  const [mapQuery, setMapQuery] = useState('');
  const deferredMapQuery = useDeferredValue(mapQuery);
  const [mapLayers, setMapLayers] = useState(SPEED_MAP_LAYER_FOCUSED_DEFAULTS);
  const [activeWorkspace, setActiveWorkspace] = useState(initialWorkspace);
  const [autoSnapTrace, setAutoSnapTrace] = useState(true);
  const [ignoredUnsetSectionKeys, setIgnoredUnsetSectionKeys] = useState(readIgnoredUnsetSectionKeys);
  const [excludedSpeedSectionKeys, setExcludedSpeedSectionKeys] = useState(readExcludedSpeedSectionKeys);
  const [rowQueryInput, setRowQueryInput] = useState('');
  const [rowFilter, setRowFilter] = useState('all');
  const [rowSort, setRowSort] = useState('updated');
  const deferredRowQuery = useDeferredValue(rowQueryInput);
  const deferredRowFilter = useDeferredValue(rowFilter);
  const deferredRowSort = useDeferredValue(rowSort);
  const isRowQueryPending = deferredRowQuery !== rowQueryInput ||
    deferredRowFilter !== rowFilter || deferredRowSort !== rowSort;
  const [selectedRows, setSelectedRows] = useState(() => new Set());
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' });
  const [health, setHealth] = useState(null);
  const restoreInputRef = useRef(null);
  const knowledgeReloadTimerRef = useRef(null);
  const mapTripsLoadRef = useRef(0);
  const mapModelCancelRef = useRef(null);
  const savedRowsListRef = useRef(null);
  const lastStatusToastRef = useRef('');
  const selectedMapEditSnapshotRef = useRef(null);
  const [mapDraft, setMapDraft] = useState(DEFAULT_MAP_DRAFT);
  const settings = useLocalSettings();
  const privacyZones = useMemo(() => getPrivacyZones(settings), [settings]);
  const mapModelActive = MAP_MODEL_WORKSPACES.has(activeWorkspace);
  const mapModelLoading = mapModelState.status === 'loading';
  const mapModelLoaded = mapModelState.status === 'loaded';
  const mapQueryPending = mapQuery !== deferredMapQuery;
  const ignoredUnsetSectionKeySet = useMemo(() => new Set(ignoredUnsetSectionKeys), [ignoredUnsetSectionKeys]);
  const excludedSpeedSectionKeySet = useMemo(() => new Set(excludedSpeedSectionKeys), [excludedSpeedSectionKeys]);
  const rawMapSections = useMemo(() => ([
    ...buildSpeedMapSections(mapTrips, rows),
    ...buildVoiceSpeedMarkerSections(mapTrips),
  ]), [mapTrips, rows]);
  const mapSections = useMemo(() => rawMapSections.filter((section) => (
    !isSpeedSectionExcluded(section, excludedSpeedSectionKeySet) &&
    (
      !isUnsetMapSection(section) ||
      !ignoredUnsetSectionKeySet.has(ignoredUnsetSectionKey(section))
    )
  )), [excludedSpeedSectionKeySet, ignoredUnsetSectionKeySet, rawMapSections]);
  const hiddenUnsetSectionCount = useMemo(() => rawMapSections.filter((section) => (
    isUnsetMapSection(section) &&
    ignoredUnsetSectionKeySet.has(ignoredUnsetSectionKey(section))
  )).length, [ignoredUnsetSectionKeySet, rawMapSections]);
  const excludedSpeedSectionCount = useMemo(() => rawMapSections.filter((section) => (
    isSpeedSectionExcluded(section, excludedSpeedSectionKeySet)
  )).length, [excludedSpeedSectionKeySet, rawMapSections]);
  const mapStats = useMemo(() => summarizeSpeedMapSections(mapSections), [mapSections]);
  const conflictsByGeohash = useMemo(() => new Map(
    mapSections
      .filter((section) => section.conflict)
      .map((section) => [correctionKey(section), section.conflict])
  ), [mapSections]);
  const filteredRows = useMemo(() => {
    const query = deferredRowQuery.trim().toLowerCase();
    const items = rows
      .map((row) => ({ row, conflict: conflictsByGeohash.get(correctionKey(row)) || null }))
      .filter(({ row, conflict }) => matchesRowFilter(row, conflict, deferredRowFilter))
      .filter(({ row, conflict }) => !query || rowSearchText(row, conflict).includes(query));
    return sortRows(items, deferredRowSort).map(({ row }) => row);
  }, [conflictsByGeohash, deferredRowFilter, deferredRowQuery, deferredRowSort, rows]);
  const updateRowQuery = (value) => setRowQueryInput(value);
  const updateRowFilter = (value) => setRowFilter(value);
  const updateRowSort = (value) => setRowSort(value);
  const revealSavedSpeedMapLayer = useCallback((source = 'user_entered_estimate') => {
    const posted = source === 'user_confirmed_posted_sign';
    setMapLayers((current) => ({
      ...current,
      conflicts: true,
      saved: true,
      observed: false,
      unset: false,
      posted: posted ? true : current.posted,
      estimates: posted ? current.estimates : true,
    }));
  }, []);
  const revealSavedRowsFilter = useCallback((source = 'user_entered_estimate') => {
    const posted = source === 'user_confirmed_posted_sign';
    setRowFilter((current) => {
      if (current === 'estimates' && posted) return 'posted';
      if (current === 'posted' && !posted) return 'estimates';
      return current;
    });
  }, []);
  const rowCardModels = useMemo(() => (
    filteredRows.map((row) => {
      const key = correctionKey(row);
      const draft = drafts[key] || {};
      const conflict = conflictsByGeohash.get(key) || null;
      return {
        key,
        row,
        draft,
        disabled: busyGeohash === key,
        identity: correctionSectionIdentity(row, linkedTrip),
        conflict,
        evidence: assessSpeedLimitEvidence(row),
        recommendation: buildSpeedLimitRecommendation({ ...row, conflict }),
        impact: buildCorrectionImpactPreview(mapTrips, {
          ...row,
          limitKmh: Number(draft.limitKmh || row.limitKmh),
          directionMode: draft.directionMode || row.directionMode,
          timeRule: timeRuleFromDraft(draft),
        }, draft.limitKmh || row.limitKmh),
      };
    })
  ), [busyGeohash, conflictsByGeohash, drafts, filteredRows, linkedTrip, mapTrips]);
  const savedRowsVirtualizer = useVirtualizer({
    count: rowCardModels.length,
    getScrollElement: () => savedRowsListRef.current,
    estimateSize: () => 520,
    overscan: 3,
  });
  const virtualRowItems = savedRowsVirtualizer.getVirtualItems();
  const visibleRows = useMemo(
    () => virtualRowItems.map((item) => filteredRows[item.index]).filter(Boolean),
    [filteredRows, virtualRowItems]
  );
  const firstConflictSection = useMemo(() => mapSections.find((section) => section.conflict), [mapSections]);
  const speedZoneReviewItems = useMemo(() => (
    buildSpeedZoneReviewItems(mapSections)
      .slice(0, 6)
      .map((item) => ({
        ...item,
        title: item.section.roadName || `Trip speed zone ${item.zoneIndex}`,
        detail: `Zone ${item.zoneIndex} of ${item.zoneCount}: observed ${item.limitKmh} km/h from ${formatSourceList(item.section.observedSources)}. Save or adjust this segment separately.`,
      }))
  ), [mapSections]);
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
    const reviewableSaved = mapSections
      .filter((section) => {
        if (!section.saved || section.conflict) return false;
        const flags = speedMapSectionFlags(section);
        return flags.expired ||
          flags.expiring ||
          flags.stale ||
          flags.lowConfidence ||
          flags.missingGeometry;
      })
      .slice(0, 4)
      .map((section) => ({
        key: `review-${correctionKey(section)}`,
        kind: 'review',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: `${speedSectionAttentionLabel(section)}; saved ${formatSpeedLimit(section.limitKmh)} from ${sourceLabel(section.source)}`,
        section,
      }));
    const unset = mapSections
      .filter((section) => !section.saved && !Number(section.effectiveLimitKmh))
      .slice(0, 4)
      .map((section) => ({
        key: `unset-${correctionKey(section)}`,
        kind: 'unset',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: `${section.sampleCount || section.sectionPoints?.length || 1} trip sample${(section.sampleCount || section.sectionPoints?.length || 1) === 1 ? '' : 's'} without a saved speed`,
        section,
      }));
    const observed = mapSections
      .filter((section) => (
        !section.saved &&
        !section.voiceSpeedMarker &&
        Number(section.effectiveLimitKmh) > 0 &&
        (
          Number(section.sampleCount) >= 3 ||
          Number(section.confirmedObservedLimits?.length) >= 2
        )
      ))
      .slice(0, 4)
      .map((section) => ({
        key: `observed-${correctionKey(section)}`,
        kind: 'observed',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: `Observed ${Math.round(Number(section.effectiveLimitKmh))} km/h from ${formatSourceList(section.observedSources)}`,
        section,
      }));
    const voice = mapSections
      .filter((section) => section.voiceSpeedMarker && !section.saved)
      .slice(0, 6)
      .map((section) => ({
        key: `voice-${correctionKey(section)}`,
        kind: 'voice',
        title: section.roadName || `Voice marker ${formatSpeedLimit(section.effectiveLimitKmh)}`,
        detail: `${formatSpeedLimit(section.effectiveLimitKmh)} spoken during ${section.tripLabel || 'a trip'}${section.transcript ? `; "${section.transcript}"` : ''}`,
        section,
      }));
    return [...conflicts, ...voice, ...speedZoneReviewItems, ...reviewableSaved, ...unset, ...observed].slice(0, 12);
  }, [mapSections, speedZoneReviewItems]);
  const selectedSectionPointCount = selectedSection?.sectionPoints?.length || 0;
  const traceLengthM = useMemo(() => sectionLengthMeters(addPath), [addPath]);
  const traceQuality = useMemo(() => {
    if (!addMode) return null;
    if (addPath.length < 2) return { level: 'warn', text: autoSnapTrace ? 'Tap the start and end of the road segment.' : 'Tap at least two points along the road.' };
    if (traceLengthM < 25) return { level: 'warn', text: 'Trace a longer section so the saved rule matches real driving.' };
    if (!mapTrips.some((trip) => Array.isArray(trip?.route_points) && trip.route_points.length > 0)) {
      return { level: 'info', text: 'No recorded trip route is available for snapping; review the line carefully.' };
    }
    return {
      level: 'good',
      text: autoSnapTrace && addPath.length > 2
        ? `Route assist built a ${Math.round(traceLengthM)} m trace from recorded geometry.`
        : `Ready to save. The trace is about ${Math.round(traceLengthM)} m long.`,
    };
  }, [addMode, addPath.length, autoSnapTrace, mapTrips, traceLengthM]);
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
  const selectedOverlapChecks = useMemo(() => (
    selectedCorrectionDraft
      ? findOverlappingSpeedSections(selectedCorrectionDraft, mapSections, {
        excludeKey: correctionKey(selectedSection),
      })
      : []
  ), [mapSections, selectedCorrectionDraft, selectedSection]);
  const blockingOverlapChecks = useMemo(
    () => selectedOverlapChecks.filter((item) => item.severity === 'block'),
    [selectedOverlapChecks]
  );
  const selectedBlockingOverlap = blockingOverlapChecks[0] || null;
  const selectedSectionReason = useMemo(
    () => selectedSection ? mapSectionReasonText(selectedSection, addMode) : '',
    [addMode, selectedSection]
  );
  const canSaveSelectedMapSection = Boolean(selectedSection) && (
    selectedSection.saved || selectedSectionPointCount >= 2
  ) && blockingOverlapChecks.length === 0;
  const mergeCandidate = useMemo(() => (
    selectedSection?.saved
      ? findMergeableSpeedSection(selectedSection, mapSections)
      : null
  ), [mapSections, selectedSection]);
  const editorWarnings = useMemo(() => {
    if (!selectedSection) return [];
    const warnings = [];
    if (blockingOverlapChecks.length > 0) {
      const overlap = blockingOverlapChecks[0];
      warnings.push(`Blocked: this section overlaps ${overlap.roadName || 'another saved section'} saved at ${overlap.limitKmh} km/h. Split, merge, or edit the existing rule first.`);
    } else if (selectedOverlapChecks.length > 0) {
      const overlap = selectedOverlapChecks[0];
      warnings.push(`This geometry overlaps ${overlap.roadName || 'another saved section'} (${overlap.limitKmh || 'unknown'} km/h). Save only if the direction or time rule makes it distinct.`);
    }
    if ((selectedSection.sectionPoints || []).length < 2) warnings.push('Trace at least two points to define a road section.');
    if (addMode && traceLengthM > 0 && traceLengthM < 25) warnings.push('Trace a longer section before saving; very short rules are easy to match to the wrong road.');
    if (!String(mapDraft.roadName || selectedSection.roadName || '').trim()) warnings.push('Add a road name to make future review and merging more reliable.');
    if (mapDraft.source === 'user_confirmed_posted_sign' && !String(mapDraft.note || '').trim()) {
      warnings.push('Add a short confirmation note for the audit history.');
    }
    if (selectedImpactPreview?.affectedTripCount === 0) warnings.push('No stored completed trips currently cross this rule.');
    if (selectedImpactPreview && selectedImpactPreview.affectedTripCount > 0 && selectedImpactPreview.matchedPointCount < 2) {
      warnings.push('Only one stored route sample matches this rule. Snap to route or trace a longer section before relying on it.');
    }
    return warnings;
  }, [
    addMode,
    blockingOverlapChecks,
    mapDraft.note,
    mapDraft.roadName,
    mapDraft.source,
    selectedImpactPreview,
    selectedOverlapChecks,
    selectedSection,
    traceLengthM,
  ]);
  const matchingTripsForCorrection = useCallback((correction) => (
    mapTrips.filter((trip) => trip?.status === 'completed' && tripCrossesCorrection(trip, correction))
  ), [mapTrips]);

  const removeSavedRowsFromView = useCallback((removedRows = []) => {
    const removedIds = new Set(
      removedRows
        .map((row) => row?.id || row?.ruleId || row?.sectionKey)
        .filter(Boolean)
    );
    const removedFallbackGeohashes = new Set(
      removedRows
        .filter((row) => !(row?.id || row?.ruleId || row?.sectionKey))
        .map((row) => row?.geohash)
        .filter(Boolean)
    );
    if (!removedIds.size && !removedFallbackGeohashes.size) return;

    setRows((current) => current.filter((row) => (
      !removedIds.has(row?.id || row?.ruleId || row?.sectionKey) &&
      !removedFallbackGeohashes.has(row?.geohash)
    )));
    setSelectedRows((current) => {
      const next = new Set(current);
      removedRows.forEach((row) => next.delete(correctionKey(row)));
      return next;
    });
    setSelectedSection((current) => {
      if (!current?.saved) return current;
      const currentId = current.id || current.ruleId || current.sectionKey;
      return removedIds.has(currentId) || (!currentId && removedFallbackGeohashes.has(current.geohash))
        ? null
        : current;
    });
  }, []);

  const beginRecalculation = useCallback(() => {
    recalculationCountRef.current += 1;
    setRecalculationBusy(true);
    return () => {
      recalculationCountRef.current = Math.max(0, recalculationCountRef.current - 1);
      if (recalculationCountRef.current === 0) setRecalculationBusy(false);
    };
  }, []);

  const withRecalculation = useCallback(async (task) => {
    const finish = beginRecalculation();
    try {
      return await task();
    } finally {
      finish();
    }
  }, [beginRecalculation]);

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
    const firstLoad = !loadedOnceRef.current;
    if (firstLoad && !silent) setLoading(true);
    else if (!silent) setRefreshing(true);
    const [nextRows, nextHistory, rawKnowledge] = await Promise.all([
      knowledge.listUserCorrections().catch(() => []),
      knowledge.getHistoryState().catch(() => ({ canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' })),
      knowledge.exportData().catch(() => ({ cells: {}, corrections: [] })),
    ]);
    const safeRows = (Array.isArray(nextRows) ? nextRows : []).filter(Boolean);
    setRows(safeRows);
    setHistoryState(nextHistory);
    setHealth(inspectSpeedKnowledgeHealth(rawKnowledge));
    setSelectedRows((current) => new Set([...current].filter((key) => (
      safeRows.some((row) => correctionKey(row) === key)
    ))));
    setDrafts((current) => {
      const next = { ...current };
      for (const row of safeRows) {
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
    loadedOnceRef.current = true;
    setLoadedOnce(true);
    if (!silent) {
      setLoading(false);
      setRefreshing(false);
    }
  }, [knowledge]);

  const loadMapModel = useCallback(({ force = false } = {}) => {
    if (TRIAGE_DISABLE_MAPS || !loadedOnceRef.current) return;
    const currentStatus = mapModelStateRef.current.status;
    if (!force && (currentStatus === 'loading' || currentStatus === 'loaded')) return;
    mapModelCancelRef.current?.();
    const loadId = mapTripsLoadRef.current + 1;
    mapTripsLoadRef.current = loadId;
    mapModelStateRef.current = { status: 'loading', error: null };
    setMapModelState({ status: 'loading', error: null });
    mapModelCancelRef.current = scheduleIdleWork(() => {
      tripService.list({ sort: '-start_time', limit: 500 })
        .then((nextTrips) => {
          if (mapTripsLoadRef.current !== loadId) return;
          setMapTrips(Array.isArray(nextTrips) ? nextTrips : []);
          mapModelStateRef.current = { status: 'loaded', error: null };
          setMapModelState({ status: 'loaded', error: null });
        })
        .catch((error) => {
          if (mapTripsLoadRef.current !== loadId) return;
          setMapTrips([]);
          mapModelStateRef.current = { status: 'error', error };
          setMapModelState({ status: 'error', error });
        })
        .finally(() => {
          if (mapTripsLoadRef.current === loadId) mapModelCancelRef.current = null;
      });
    });
  }, []);

  const refreshRowsAndMap = useCallback(async ({ silent = false, forceMap = true } = {}) => {
    await loadRows({ silent });
    if (forceMap && (mapModelActive || mapModelStateRef.current.status !== 'idle')) {
      loadMapModel({ force: true });
    }
  }, [loadMapModel, loadRows, mapModelActive]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        IGNORED_UNSET_SPEED_SECTIONS_STORAGE_KEY,
        JSON.stringify([...new Set(ignoredUnsetSectionKeys)].slice(-500))
      );
    } catch {
      // Ignore storage failures; dismissing unset map hints is a convenience only.
    }
  }, [ignoredUnsetSectionKeys]);

  useEffect(() => {
    try {
      writeExcludedSpeedSectionKeys(excludedSpeedSectionKeys);
    } catch {
      // Ignore storage failures; private/parking cleanup remains an in-session filter.
    }
  }, [excludedSpeedSectionKeys]);

  useEffect(() => () => {
    mapModelCancelRef.current?.();
  }, []);

  useEffect(() => {
    if (loadedOnce && mapModelActive) loadMapModel();
  }, [loadedOnce, loadMapModel, mapModelActive]);

  useEffect(() => {
    const nextToast = speedStatusToast(status);
    if (!nextToast) return;
    const key = `${nextToast.title}:${nextToast.description}`;
    if (lastStatusToastRef.current === key) return;
    lastStatusToastRef.current = key;
    toast(nextToast);
  }, [status]);

  useEffect(() => {
    if (!selectedSection?.saved) return;
    const selectedKey = correctionKey(selectedSection);
    const stillSaved = rows.some((row) => (
      correctionKey(row) === selectedKey ||
      (!selectedKey && row.geohash === selectedSection.geohash)
    ));
    if (!stillSaved) setSelectedSection(null);
  }, [rows, selectedSection]);

  useEffect(() => {
    if (!selectedSection || !isUnsetMapSection(selectedSection)) return;
    if (ignoredUnsetSectionKeySet.has(ignoredUnsetSectionKey(selectedSection))) {
      setSelectedSection(null);
      setAddPath([]);
      setAddMode(false);
    }
  }, [ignoredUnsetSectionKeySet, selectedSection]);

  useEffect(() => {
    if (!selectedSection) return;
    if (isSpeedSectionExcluded(selectedSection, excludedSpeedSectionKeySet)) {
      setSelectedSection(null);
      setAddPath([]);
      setAddMode(false);
    }
  }, [excludedSpeedSectionKeySet, selectedSection]);

  useEffect(() => {
    savedRowsVirtualizer.scrollToIndex(0, { align: 'start' });
  }, [deferredRowFilter, deferredRowQuery, deferredRowSort, savedRowsVirtualizer]);

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
        void refreshRowsAndMap({ silent: true });
      }, 200);
    };
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onKnowledgeChanged);
    return () => {
      window.clearTimeout(knowledgeReloadTimerRef.current);
      window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onKnowledgeChanged);
    };
  }, [refreshRowsAndMap]);

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
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const beforeTrips = [
      ...new Map([
        ...matchingTripsForCorrection(row),
        ...matchingTripsForCorrection(updatedCorrection),
      ].map((trip) => [String(trip.id), trip])).values(),
    ];
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
      revealSavedRowsFilter(updatedCorrection.source);
      revealSavedSpeedMapLayer(updatedCorrection.source);
      setBusyGeohash(null);
      setStatus(withUndo('Saved road speed updated. Matching trip scores are updating in the background.'));
      void (async () => {
        const afterKnowledge = await knowledge.exportData().catch(() => null);
        const updatedTrips = await withRecalculation(() => (
          beforeKnowledge && afterKnowledge
            ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
            : refreshTripsCrossingLocalSpeedCorrection(updatedCorrection).catch(() => null)
        ));
        setStatus(withUndo(buildRecalculationStatus(
          updatedTrips
            ? `Saved road speed updated. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
            : 'Saved road speed updated, but matching trips could not be recalculated right now.',
          beforeTrips,
          updatedTrips
        )));
        await refreshRowsAndMap({ silent: true });
      })();
    } else {
      setStatus('Could not update that saved speed.');
      setBusyGeohash(null);
    }
  };

  const removeRow = async (row) => {
    const confirmed = await requestAppConfirm({
      title: 'Delete saved speed?',
      message: 'Delete this saved road speed?',
      confirmLabel: 'Delete speed',
      destructive: true,
    });
    if (!confirmed) return;
    const key = correctionKey(row);
    setBusyGeohash(key);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const beforeTrips = matchingTripsForCorrection(row);
    const removed = await knowledge.removeUserCorrection(key).catch(() => false);
    if (removed) {
      removeSavedRowsFromView([row]);
      const afterKnowledge = await knowledge.exportData().catch(() => null);
      const updatedTrips = await withRecalculation(() => (
        beforeKnowledge && afterKnowledge
          ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
          : refreshTripsCrossingLocalSpeedCorrection(row).catch(() => null)
      ));
      setStatus(withUndo(buildRecalculationStatus(
        updatedTrips
          ? `Saved road speed removed. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} using remaining speed data and fallbacks.`
          : 'Saved road speed removed, but matching trips could not be recalculated right now.',
        beforeTrips,
        updatedTrips
      )));
      await refreshRowsAndMap();
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
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const beforeTrips = [
      ...new Map([
        ...matchingTripsForCorrection(row),
        ...matchingTripsForCorrection(nextCorrection),
      ].map((trip) => [String(trip.id), trip])).values(),
    ];
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
    revealSavedRowsFilter(nextCorrection.source);
    revealSavedSpeedMapLayer(nextCorrection.source);
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
      const nextDraft = {
        ...mapDraft,
        limitKmh: String(nextCorrection.limitKmh),
        source: nextCorrection.source,
        note: nextCorrection.note,
        roadName: nextCorrection.roadName,
      };
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
      setMapDraft(nextDraft);
      setMapEditorSnapshot({ ...selectedSection, ...nextCorrection, conflict: null }, nextDraft);
    }
    setBusyGeohash(null);

    if (keepSaved) {
      setStatus(withUndo(`Conflict resolved: kept the saved ${Math.round(nextLimitKmh)} km/h rule for this road section. Matching trip scores are updating in the background.`));
      void (async () => {
        const afterKnowledge = await knowledge.exportData().catch(() => null);
        const updatedTrips = beforeKnowledge && afterKnowledge
          ? await withRecalculation(() => (
            refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
          ))
          : [];
        setStatus(withUndo(buildRecalculationStatus(
          updatedTrips
            ? `Conflict resolved: kept the saved ${Math.round(nextLimitKmh)} km/h rule and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
            : `Conflict resolved: kept the saved ${Math.round(nextLimitKmh)} km/h rule, but matching trips could not be recalculated right now.`,
          beforeTrips,
          updatedTrips
        )));
        await refreshRowsAndMap({ silent: true });
      })();
      return;
    }

    setStatus(withUndo(`Conflict resolved: updated this road section to ${Math.round(nextLimitKmh)} km/h. Matching trip scores are updating in the background.`));
    void (async () => {
      const afterKnowledge = await knowledge.exportData().catch(() => null);
      const updatedTrips = await withRecalculation(() => (
        beforeKnowledge && afterKnowledge
          ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
          : refreshTripsCrossingLocalSpeedCorrection(nextCorrection).catch(() => null)
      ));
      setStatus(withUndo(buildRecalculationStatus(
        updatedTrips
          ? `Conflict resolved: updated this road section to ${Math.round(nextLimitKmh)} km/h and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
          : `Conflict resolved: updated this road section to ${Math.round(nextLimitKmh)} km/h, but matching trips could not be recalculated right now.`,
        beforeTrips,
        updatedTrips
      )));
      await refreshRowsAndMap({ silent: true });
    })();
  };

  const setMapEditorSnapshot = (section = null, draft = DEFAULT_MAP_DRAFT) => {
    selectedMapEditSnapshotRef.current = section
      ? {
        key: correctionKey(section),
        saved: section.saved === true,
        geometry: sectionGeometryCompareKey(section),
        draft: normalizeMapDraftForCompare(draft),
      }
      : null;
  };

  const mapEditorHasUnsavedChanges = () => {
    if (!selectedSection) return false;
    const snapshot = selectedMapEditSnapshotRef.current;
    if (addMode) {
      return addPath.length > 0 ||
        normalizeMapDraftForCompare(mapDraft) !== normalizeMapDraftForCompare(DEFAULT_MAP_DRAFT);
    }
    if (!snapshot) return false;
    const selectedKey = correctionKey(selectedSection);
    if (selectedKey !== snapshot.key) return false;
    if (selectedSection.pendingMerge || selectedSection.linkedGeometryEdits?.length) return true;
    return sectionGeometryCompareKey(selectedSection) !== snapshot.geometry ||
      normalizeMapDraftForCompare(mapDraft) !== snapshot.draft;
  };

  const confirmDiscardMapEditorChanges = async (actionText = 'switch sections') => {
    if (!mapEditorHasUnsavedChanges()) return true;
    const confirmed = await requestAppConfirm({
      title: 'Discard unsaved road speed edits?',
      message: `You have unsaved changes to this road speed. Save or update the road speed to keep the adjusted line.\n\nDiscard those edits and ${actionText}?`,
      confirmLabel: 'Discard edits',
      cancelLabel: 'Keep editing',
      destructive: true,
    });
    if (!confirmed) {
      setStatus('Kept the current road speed edits open. Update road speed to save the adjusted line.');
    }
    return confirmed;
  };

  const selectMapSection = async (section) => {
    if (!section) {
      setStatus('Select a saved or observed road section before editing.');
      return false;
    }
    const nextKey = correctionKey(section);
    if (selectedSection && nextKey === correctionKey(selectedSection) && mapEditorHasUnsavedChanges()) {
      setStatus('Kept the current road speed edits open. Update road speed to save the adjusted line.');
      return false;
    }
    if (selectedSection && nextKey !== correctionKey(selectedSection)) {
      const confirmed = await confirmDiscardMapEditorChanges('switch to another section');
      if (!confirmed) return false;
    }
    const nextDraft = mapDraftForSection(section);
    setSelectedSection(section);
    setMapDraft(nextDraft);
    setAddMode(false);
    setAddPath([]);
    setMapEditorSnapshot(section, nextDraft);
    return true;
  };

  const ignoreUnsetMapSection = () => {
    if (!selectedSection || !isUnsetMapSection(selectedSection)) {
      setStatus('Select an unset road section before hiding it.');
      return;
    }
    const key = ignoredUnsetSectionKey(selectedSection);
    if (!key) {
      setStatus('Could not hide this unset section because it has no stable map key.');
      return;
    }
    setIgnoredUnsetSectionKeys((current) => (
      current.includes(key) ? current : [...current, key]
    ));
    setSelectedSection(null);
    setAddPath([]);
    setAddMode(false);
    setStatus('Hidden this unset road section from the map and review list on this device.');
  };

  const restoreIgnoredUnsetMapSections = () => {
    setIgnoredUnsetSectionKeys([]);
    setStatus('Restored hidden unset road sections.');
  };

  const addExcludedSpeedSection = (section) => {
    const keys = speedSectionExclusionKeys(section);
    if (!keys.length) return false;
    setExcludedSpeedSectionKeys((current) => [...new Set([...current, ...keys])]);
    return true;
  };

  const restoreExcludedSpeedSections = () => {
    setExcludedSpeedSectionKeys([]);
    setStatus('Restored parking/private road-section cleanup exclusions.');
  };

  const markSelectedSectionPrivate = async () => {
    if (!selectedSection) {
      setStatus('Select a parking, driveway, or private-road section before marking it ignored.');
      return;
    }
    const keys = speedSectionExclusionKeys(selectedSection);
    if (!keys.length) {
      setStatus('Could not mark this section ignored because it has no stable geometry key.');
      return;
    }
    const confirmed = await requestAppConfirm({
      title: 'Mark private or parking?',
      message: selectedSection.saved
        ? 'Mark this as parking/private and remove the saved speed for this section?'
        : 'Mark this section as parking/private so it stops appearing in speed review?',
      confirmLabel: 'Mark section',
    });
    if (!confirmed) return;

    const selectedKey = correctionKey(selectedSection);

    if (!selectedSection.saved) {
      addExcludedSpeedSection(selectedSection);
      setIgnoredUnsetSectionKeys((current) => {
        const unsetKey = ignoredUnsetSectionKey(selectedSection);
        return unsetKey && !current.includes(unsetKey) ? [...current, unsetKey] : current;
      });
      setSelectedSection(null);
      setAddPath([]);
      setAddMode(false);
      setStatus('Marked this section as parking/private. Road Sage will hide it from saved-speed cleanup prompts on this device.');
      return;
    }

    setBusyGeohash(selectedKey);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const beforeTrips = matchingTripsForCorrection(selectedSection);
    const removed = await knowledge.removeUserCorrection(selectedKey, { historyGroup: `private-section-${Date.now()}` }).catch(() => false);
    if (!removed) {
      setBusyGeohash(null);
      setStatus('Could not remove the saved speed for this parking/private section.');
      return;
    }

    addExcludedSpeedSection(selectedSection);
    removeSavedRowsFromView([selectedSection]);
    setSelectedSection(null);
    setAddPath([]);
    setAddMode(false);
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    const updatedTrips = await withRecalculation(() => (
      beforeKnowledge && afterKnowledge
        ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
        : refreshTripsCrossingLocalSpeedCorrection(selectedSection).catch(() => null)
    ));
    setBusyGeohash(null);
    setStatus(withUndo(buildRecalculationStatus(
      updatedTrips
        ? `Marked this section as parking/private, removed its saved speed, and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
        : 'Marked this section as parking/private and removed its saved speed, but matching trips could not be recalculated right now.',
      beforeTrips,
      updatedTrips
    )));
    await refreshRowsAndMap();
  };

  const startAddingSection = async () => {
    const confirmed = await confirmDiscardMapEditorChanges('start a new road speed trace');
    if (!confirmed) return;
    setSelectedSection(null);
    setAddPath([]);
    setAddMode(true);
    setMapDraft(DEFAULT_MAP_DRAFT);
    setMapEditorSnapshot(null);
    setStatus(autoSnapTrace
      ? 'Adding road section started. Tap the start and end of the road segment; Auto snap will fill the recorded route shape when possible.'
      : 'Adding road section started. Tap points around bends, then enter the speed and save.');
  };

  const selectNewMapPoint = (point) => {
    setAddPath((current) => {
      const rawNext = [...current, point].slice(-24);
      let next = rawNext;
      if (autoSnapTrace) {
        const snapResult = snapSectionPointsToTripRoutesWithStats(rawNext, mapTrips, 80, {
          expandToRouteSegment: rawNext.length >= 2,
          maxPoints: 24,
        });
        if (snapResult.points.length) next = snapResult.points;
        if (snapResult.matchType === 'route_segment' && next.length > rawNext.length) {
          setStatus(`Auto snap traced ${next.length} route point${next.length === 1 ? '' : 's'} from ${snapResult.tripLabel || 'a recorded trip'}. Enter the speed and save.`);
        } else if (snapResult.snappedCount > 0 && rawNext.length >= 2) {
          setStatus(`Auto snap matched ${snapResult.snappedCount} point${snapResult.snappedCount === 1 ? '' : 's'} to recorded trip geometry. Add another point or save the speed.`);
        }
      }
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

  const moveSelectedSectionEndpoint = (index, point) => {
    const current = selectedSection;
    if (!current) return;
    const points = [...(current.sectionPoints || [])];
    if (!points[index]) return;

    const selectedKey = correctionKey(current);
    const originalPoint = points[index];
    const nextPoint = { lat: Number(point.lat), lng: Number(point.lng) };
    if (!Number.isFinite(nextPoint.lat) || !Number.isFinite(nextPoint.lng)) return;

    points[index] = nextPoint;
    const midpoint = points[Math.floor(points.length / 2)] || nextPoint;
    const linkedGeometryEdits = [];

    if (
      current.saved &&
      current.splitParentId &&
      (index === 0 || index === points.length - 1)
    ) {
      rows.forEach((row) => {
        const rowKey = correctionKey(row);
        if (
          rowKey === selectedKey ||
          row.splitParentId !== current.splitParentId ||
          !Array.isArray(row.sectionPoints) ||
          row.sectionPoints.length < 2
        ) return;

        const siblingPoints = row.sectionPoints.map((item) => ({ lat: Number(item.lat), lng: Number(item.lng) }));
        const siblingIndex = [0, siblingPoints.length - 1].find((pointIndex) => (
          distanceMeters(siblingPoints[pointIndex], originalPoint) <= 8
        ));
        if (!Number.isInteger(siblingIndex)) return;

        siblingPoints[siblingIndex] = nextPoint;
        const siblingMidpoint = siblingPoints[Math.floor(siblingPoints.length / 2)] || nextPoint;
        linkedGeometryEdits.push({
          selector: rowKey,
          lat: siblingMidpoint.lat,
          lng: siblingMidpoint.lng,
          geohash: geohashEncode(siblingMidpoint.lat, siblingMidpoint.lng),
          limitKmh: row.limitKmh,
          source: row.source,
          note: row.note || '',
          roadName: row.roadName || '',
          directionMode: row.directionMode || 'both',
          directionBearing: row.directionBearing,
          timeRule: row.timeRule,
          expiresAt: row.expiresAt || null,
          sectionPoints: siblingPoints,
        });
      });
    }

    const nextSection = {
      ...current,
      lat: midpoint.lat,
      lng: midpoint.lng,
      geohash: geohashEncode(midpoint.lat, midpoint.lng),
      sectionPoints: points,
    };
    if (linkedGeometryEdits.length) nextSection.linkedGeometryEdits = linkedGeometryEdits;
    else delete nextSection.linkedGeometryEdits;

    setSelectedSection(nextSection);
    if (linkedGeometryEdits.length) {
      setRows((currentRows) => currentRows.map((row) => {
        const linked = linkedGeometryEdits.find((edit) => edit.selector === correctionKey(row));
        return linked
          ? {
            ...row,
            lat: linked.lat,
            lng: linked.lng,
            geohash: linked.geohash,
            sectionPoints: linked.sectionPoints,
          }
          : row;
      }));
      setStatus('Moved the shared split point. Update road speed to save both adjusted halves.');
    }
  };

  const focusAttentionItem = async (item) => {
    if (!item?.section) return;
    const selected = await selectMapSection(item.section);
    if (!selected) return;
    setActiveWorkspace('map');
    setMapLayers((current) => ({
      ...current,
      conflicts: true,
      saved: true,
      observed: true,
      unset: true,
      posted: true,
      estimates: true,
      lowConfidence: true,
      stale: true,
      expiring: true,
      missingGeometry: true,
    }));
    setStatus(item.kind === 'conflict'
      ? 'Conflict selected. Choose Use observed or Keep saved to clear it.'
      : item.kind === 'voice'
        ? 'Voice speed marker selected. Review the route line and save it as a posted sign or estimate.'
      : item.kind === 'speedZone'
        ? `Trip speed zone ${item.zoneIndex} of ${item.zoneCount} selected. Save, adjust, or confirm this ${Math.round(Number(item.limitKmh))} km/h segment independently.`
      : item.kind === 'review'
        ? `${speedSectionAttentionLabel(item.section)} selected. Review the saved speed, source, timing, and traced road line before updating.`
      : 'Road section selected. Enter a posted sign or local estimate, then save.');
  };

  const markVoiceSpeedMarkerReviewed = async (section, correction, reviewStatus = 'saved') => {
    if (!section?.voiceSpeedMarker || !section.voiceTripId || !section.voiceMarkerKey) return false;
    const trip = mapTrips.find((item) => String(item?.id) === String(section.voiceTripId));
    const markers = Array.isArray(trip?.voice_speed_limit_markers) ? trip.voice_speed_limit_markers : [];
    if (!trip || markers.length === 0) return false;
    const reviewedAt = new Date().toISOString();
    let changed = false;
    const nextMarkers = markers.map((marker, index) => {
      if (voiceSpeedMarkerKey(marker, index) !== section.voiceMarkerKey) return marker;
      changed = true;
      return {
        ...marker,
        review_status: reviewStatus,
        reviewed_at: reviewedAt,
        saved_source: correction?.source || null,
        saved_correction_id: correction?.id || correction?.ruleId || correction?.correctionId || null,
      };
    });
    if (!changed) return false;
    const patchedTrip = await tripService.update(section.voiceTripId, {
      voice_speed_limit_markers: nextMarkers,
      voice_speed_limit_marker_reviewed_at: reviewedAt,
    });
    setMapTrips((current) => current.map((item) => (
      String(item?.id) === String(section.voiceTripId)
        ? { ...item, ...(patchedTrip || {}), voice_speed_limit_markers: nextMarkers }
        : item
    )));
    if (linkedTrip && String(linkedTrip.id) === String(section.voiceTripId)) {
      setLinkedTrip({ ...linkedTrip, ...(patchedTrip || {}), voice_speed_limit_markers: nextMarkers });
    }
    return true;
  };

  const undoAddPoint = () => {
    setAddPath((current) => {
      if (!current.length) {
        setStatus('Cannot undo a trace point because no trace points have been added yet.');
        return current;
      }
      const next = current.slice(0, -1);
      if (!next.length) {
        setSelectedSection(null);
        setStatus('Removed the last trace point. Add road section mode is still active.');
      } else {
        const midpoint = next[Math.floor(next.length / 2)];
        setSelectedSection((section) => ({
          ...(section || {}),
          ...midpoint,
          geohash: geohashEncode(midpoint.lat, midpoint.lng),
          sectionPoints: next,
        }));
        setStatus(`Removed one trace point. ${next.length} point${next.length === 1 ? '' : 's'} remain.`);
      }
      return next;
    });
  };

  const snapSelectedSectionToTrips = async () => {
    if (!selectedSection) {
      setStatus('Select or trace a road section before using Snap to route.');
      return;
    }
    const currentPoints = selectedSection.sectionPoints || addPath;
    const hasRecordedRoute = mapTrips.some((trip) => (
      Array.isArray(trip?.route_points) && trip.route_points.length > 0
    ));
    if (!hasRecordedRoute) {
      setStatus('Snap to route needs at least one recorded trip. The traced line was not changed.');
      return;
    }
    const snapResult = snapSectionPointsToTripRoutesWithStats(currentPoints, mapTrips, 80, {
      expandToRouteSegment: true,
      maxPoints: 24,
    });
    const snapped = snapResult.points;
    if (snapped.length < 2) {
      setStatus('This section needs at least two points before it can snap to recorded routes.');
      return;
    }
    const geometryChanged = snapResult.changedCount > 0 ||
      snapped.length !== currentPoints.length ||
      snapped.some((point, index) => (
        Number(point.lat) !== Number(currentPoints[index]?.lat) ||
        Number(point.lng) !== Number(currentPoints[index]?.lng)
      ));
    if (!geometryChanged) {
      setStatus('No recorded route samples were within 80 metres, so the traced line was not changed.');
      return;
    }
    const midpoint = snapped[Math.floor(snapped.length / 2)];
    const snappedSection = {
      ...selectedSection,
      lat: midpoint.lat,
      lng: midpoint.lng,
      geohash: geohashEncode(midpoint.lat, midpoint.lng),
      sectionPoints: snapped,
      directionBearing: selectedSection.directionBearing,
    };
    setSelectedSection(snappedSection);
    if (addMode) setAddPath(snapped);
    const snapSummary = snapResult.matchType === 'route_segment'
      ? `matched ${snapped.length} ordered route point${snapped.length === 1 ? '' : 's'} from ${snapResult.tripLabel || 'a recorded trip'}, average ${snapResult.averageMoveM} m, max ${snapResult.maxMoveM} m`
      : `${snapResult.changedCount} point${snapResult.changedCount === 1 ? '' : 's'} moved, average ${snapResult.averageMoveM} m, max ${snapResult.maxMoveM} m`;
    if (!selectedSection.saved) {
      setStatus(`Section snapped to recorded route samples (${snapSummary}). Review the line, then save the road speed.`);
      return;
    }

    const selectedKey = correctionKey(selectedSection);
    const limitKmh = Number(mapDraft.limitKmh || selectedSection.limitKmh);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0) {
      setStatus('Snapped the line on the map, but could not save it because the speed limit is missing.');
      return;
    }
    setBusyGeohash(selectedKey);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const saved = await knowledge.updateUserCorrection(
      selectedKey,
      Math.round(limitKmh),
      mapDraft.source || selectedSection.source || 'user_entered_estimate',
      mapDraft.note || selectedSection.note || '',
      {
        lat: snappedSection.lat,
        lng: snappedSection.lng,
        roadName: mapDraft.roadName || selectedSection.roadName || '',
        sectionPoints: snapped,
        directionMode: mapDraft.directionMode || selectedSection.directionMode || 'both',
        directionBearing: snappedSection.directionBearing,
        timeRule: timeRuleFromDraft(mapDraft),
        expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
      }
    ).catch(() => false);
    if (!saved) {
      setBusyGeohash(null);
      setStatus('Snapped the line on the map, but could not save it. Try Update road speed.');
      return;
    }
    const updatedSection = {
      ...snappedSection,
      limitKmh: Math.round(limitKmh),
      source: mapDraft.source || selectedSection.source || 'user_entered_estimate',
      note: mapDraft.note || selectedSection.note || '',
      roadName: mapDraft.roadName || selectedSection.roadName || '',
      directionMode: mapDraft.directionMode || selectedSection.directionMode || 'both',
      timeRule: timeRuleFromDraft(mapDraft),
      expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
    };
    setRows((current) => current.map((row) => (
      correctionKey(row) === selectedKey ? { ...row, ...updatedSection } : row
    )));
    setSelectedSection(updatedSection);
    setMapEditorSnapshot(updatedSection, mapDraft);
    setStatus(withUndo(`Saved snapped route geometry (${snapSummary}). Matching trip scores are updating in the background.`));
    void (async () => {
      const afterKnowledge = await knowledge.exportData().catch(() => null);
      const updatedTrips = await withRecalculation(() => (
        beforeKnowledge && afterKnowledge
          ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
          : refreshTripsCrossingLocalSpeedCorrection(updatedSection).catch(() => null)
      ));
      setStatus(withUndo(buildRecalculationStatus(
        updatedTrips
          ? `Saved snapped route geometry (${snapSummary}) and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'}.`
          : `Saved snapped route geometry (${snapSummary}), but matching trips could not be recalculated right now.`,
        matchingTripsForCorrection(selectedSection),
        updatedTrips
      )));
      await refreshRowsAndMap();
    })();
    setBusyGeohash(null);
  };

  const prepareMergeWithNearbySection = () => {
    if (!selectedSection?.saved) {
      setStatus('Select a saved road section before using Merge nearby.');
      return;
    }
    if (!mergeCandidate?.candidate) {
      setStatus('Cannot merge this road section yet. No nearby saved section with the same speed was found.');
      return;
    }
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
    if (!selectedSection) {
      setStatus('Select or trace a road section before saving.');
      return;
    }
    const limitKmh = Number(mapDraft.limitKmh);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0) {
      setStatus('Enter a valid speed limit before saving.');
      return;
    }
    if (!selectedSection.saved && selectedSection.sectionPoints?.length < 2) {
      setStatus('Tap at least two points along the road so Road Sage can save a real road section.');
      return;
    }
    if (blockingOverlapChecks.length > 0) {
      const overlap = blockingOverlapChecks[0];
      setStatus(`Cannot save this road speed because it overlaps ${overlap.roadName || 'another saved section'} at ${overlap.limitKmh} km/h. Edit, split, merge, or add a distinct direction/time rule first.`);
      return;
    }
    const selectedKey = correctionKey(selectedSection);
    setBusyGeohash(selectedKey);
    const linkedGeometryEdits = Array.isArray(selectedSection.linkedGeometryEdits)
      ? selectedSection.linkedGeometryEdits
      : [];
    const historyGroup = selectedSection.pendingMerge
      ? `merge-${Date.now()}`
      : linkedGeometryEdits.length
        ? `linked-geometry-${Date.now()}`
      : null;
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const saved = selectedSection.saved
      ? await knowledge.updateUserCorrection(
        selectedKey,
        Math.round(limitKmh),
        mapDraft.source,
        mapDraft.note,
        {
          lat: selectedSection.lat,
          lng: selectedSection.lng,
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
      const savedCorrection = saved && typeof saved === 'object' ? saved : null;
      if (linkedGeometryEdits.length) {
        await Promise.all(linkedGeometryEdits.map((edit) => knowledge.updateUserCorrection(
          edit.selector,
          Number(edit.limitKmh),
          edit.source || 'user_entered_estimate',
          edit.note || '',
          {
            lat: edit.lat,
            lng: edit.lng,
            roadName: edit.roadName || '',
            sectionPoints: edit.sectionPoints,
            directionMode: edit.directionMode || 'both',
            directionBearing: edit.directionBearing,
            timeRule: edit.timeRule,
            expiresAt: edit.expiresAt,
            historyGroup,
          }
        ).catch(() => false)));
      }
      if (selectedSection.pendingMerge && Array.isArray(selectedSection.mergedSelectors)) {
        await Promise.all(selectedSection.mergedSelectors
          .filter((selector) => selector && selector !== selectedKey)
          .map((selector) => knowledge.removeUserCorrection(selector, { historyGroup }).catch(() => false)));
      }
      const correction = {
        ...selectedSection,
        ...(savedCorrection || {}),
        limitKmh: Math.round(limitKmh),
        source: mapDraft.source,
        note: mapDraft.note,
        roadName: mapDraft.roadName || selectedSection.roadName || '',
        sectionPoints: selectedSection.sectionPoints || [],
        directionMode: mapDraft.directionMode || 'both',
        timeRule: timeRuleFromDraft(mapDraft),
        expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
      };
      const voiceMarkerReviewed = selectedSection.voiceSpeedMarker
        ? await markVoiceSpeedMarkerReviewed(selectedSection, correction).catch(() => false)
        : false;
      const linkedGeometryLabel = linkedGeometryEdits.length ? ' and updated the linked split half' : '';
      const voiceMarkerLabel = voiceMarkerReviewed ? ' and cleared the voice marker from pending review' : '';
      const beforeTrips = matchingTripsForCorrection(correction);
      const nextRow = {
        ...correction,
        saved: true,
        appliedAt: correction.appliedAt || new Date().toISOString(),
      };
      setRows((current) => {
        const existingIndex = current.findIndex((item) => correctionKey(item) === selectedKey);
        if (existingIndex < 0) return [nextRow, ...current];
        return current.map((item, index) => index === existingIndex ? { ...item, ...nextRow } : item);
      });
      revealSavedSpeedMapLayer(mapDraft.source);
      setSelectedSection(nextRow);
      setAddMode(false);
      setAddPath([]);
      setMapEditorSnapshot(nextRow, mapDraft);
      setBusyGeohash(null);
      loadMapModel({ force: true });
      setStatus(withUndo(`Saved ${Math.round(limitKmh)} km/h for this road section${linkedGeometryLabel}${voiceMarkerLabel}. Matching trip scores are updating in the background.`));
      void (async () => {
        const afterKnowledge = await knowledge.exportData().catch(() => null);
        const updatedTrips = await withRecalculation(() => (
          beforeKnowledge && afterKnowledge
            ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
            : refreshTripsCrossingLocalSpeedCorrection(correction).catch(() => null)
        ));
        setStatus(withUndo(buildRecalculationStatus(
          updatedTrips
            ? `Saved ${Math.round(limitKmh)} km/h for this road section${linkedGeometryLabel}${voiceMarkerLabel}. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
            : `Saved ${Math.round(limitKmh)} km/h for this road section${linkedGeometryLabel}${voiceMarkerLabel}, but matching trips could not be recalculated right now.`,
          beforeTrips,
          updatedTrips
        )));
        await refreshRowsAndMap({ silent: true });
      })();
    } else {
      setStatus('Could not save this road section. Private-zone sections cannot be saved.');
      setBusyGeohash(null);
    }
  };

  const trimSavedMapSection = async (side) => {
    if (!selectedSection?.saved) {
      setStatus('Select a saved road section before trimming it.');
      return;
    }
    const points = (selectedSection.sectionPoints || [])
      .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
    if (points.length < 3) {
      setStatus('This section only has start and end points. Drag S or E, then Update road speed to trim it.');
      return;
    }
    const nextPoints = side === 'start' ? points.slice(1) : points.slice(0, -1);
    const midpoint = sectionMidpoint(nextPoints);
    const limitKmh = Number(mapDraft.limitKmh || selectedSection.limitKmh);
    if (!midpoint || !Number.isFinite(limitKmh) || limitKmh <= 0) {
      setStatus('Could not trim this section because its geometry or speed limit is incomplete.');
      return;
    }

    const selectedKey = correctionKey(selectedSection);
    setBusyGeohash(selectedKey);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const updatedSection = {
      ...selectedSection,
      lat: midpoint.lat,
      lng: midpoint.lng,
      geohash: geohashEncode(midpoint.lat, midpoint.lng),
      limitKmh: Math.round(limitKmh),
      source: mapDraft.source || selectedSection.source || 'user_entered_estimate',
      note: mapDraft.note || selectedSection.note || '',
      roadName: mapDraft.roadName || selectedSection.roadName || '',
      directionMode: mapDraft.directionMode || selectedSection.directionMode || 'both',
      timeRule: timeRuleFromDraft(mapDraft),
      expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
      sectionPoints: nextPoints,
    };
    const saved = await knowledge.updateUserCorrection(
      selectedKey,
      updatedSection.limitKmh,
      updatedSection.source,
      updatedSection.note,
      {
        lat: updatedSection.lat,
        lng: updatedSection.lng,
        roadName: updatedSection.roadName,
        sectionPoints: nextPoints,
        directionMode: updatedSection.directionMode,
        directionBearing: selectedSection.directionBearing,
        timeRule: updatedSection.timeRule,
        expiresAt: updatedSection.expiresAt,
        historyGroup: `trim-section-${Date.now()}`,
      }
    ).catch(() => false);
    if (!saved) {
      setBusyGeohash(null);
      setStatus('Could not trim this saved road section.');
      return;
    }

    setRows((current) => current.map((row) => (
      correctionKey(row) === selectedKey ? { ...row, ...updatedSection, appliedAt: new Date().toISOString() } : row
    )));
    setSelectedSection(updatedSection);
    setMapEditorSnapshot(updatedSection, mapDraft);
    revealSavedSpeedMapLayer(updatedSection.source);
    const beforeTrips = [
      ...new Map([
        ...matchingTripsForCorrection(selectedSection),
        ...matchingTripsForCorrection(updatedSection),
      ].map((trip) => [String(trip.id), trip])).values(),
    ];
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    const updatedTrips = await withRecalculation(() => (
      beforeKnowledge && afterKnowledge
        ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
        : refreshTripsCrossingLocalSpeedCorrection(updatedSection).catch(() => null)
    ));
    setBusyGeohash(null);
    setStatus(withUndo(buildRecalculationStatus(
      updatedTrips
        ? `Trimmed the ${side} of this saved road section and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
        : `Trimmed the ${side} of this saved road section, but matching trips could not be recalculated right now.`,
      beforeTrips,
      updatedTrips
    )));
    await refreshRowsAndMap({ silent: true });
  };

  const removeMapSection = async () => {
    if (!selectedSection?.saved) {
      setStatus('Select a saved road section before removing it.');
      return;
    }
    const confirmed = await requestAppConfirm({
      title: 'Remove saved speed?',
      message: 'Remove the saved speed from this road section?',
      confirmLabel: 'Remove speed',
      destructive: true,
    });
    if (!confirmed) return;
    await removeRow(selectedSection);
    setSelectedSection(null);
    setMapEditorSnapshot(null);
  };

  const splitMapSection = async () => {
    if (!selectedSection?.saved) {
      setStatus('Select a saved road section before splitting it.');
      return;
    }
    const originalSection = selectedSection;
    const parts = buildSplitCorrections({
      ...originalSection,
      limitKmh: Number(mapDraft.limitKmh || originalSection.limitKmh),
      source: mapDraft.source || originalSection.source,
      note: mapDraft.note || originalSection.note || '',
      roadName: mapDraft.roadName || originalSection.roadName || '',
      directionMode: mapDraft.directionMode || originalSection.directionMode || 'both',
      timeRule: timeRuleFromDraft(mapDraft),
      expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
    });
    if (parts.length !== 2) {
      setStatus('This road section needs at least two valid trace points before it can be split.');
      return;
    }
    const confirmed = await requestAppConfirm({
      title: 'Split saved speed?',
      message: 'Split this saved speed into two editable road sections?',
      confirmLabel: 'Split section',
    });
    if (!confirmed) return;

    const selectedKey = correctionKey(originalSection);
    setBusyGeohash(selectedKey);
    const source = mapDraft.source || originalSection.source || 'user_entered_estimate';
    const noteBase = mapDraft.note || originalSection.note || '';
    const expiresAt = expiresAtFromDate(mapDraft.expiresAtDate);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    if (!beforeKnowledge) {
      setStatus('Could not load saved road speeds before splitting. Try refresh, then split again.');
      setBusyGeohash(null);
      return;
    }

    const originalId = originalSection.id || originalSection.ruleId || originalSection.sectionKey || null;
    const matchesOriginal = (correction = {}) => {
      const correctionId = correction.id || correction.ruleId || correction.sectionKey || null;
      return originalId
        ? correctionId === originalId
        : correction.geohash === originalSection.geohash;
    };
    const originalCorrection = (beforeKnowledge.corrections || []).find(matchesOriginal) || originalSection;
    const now = new Date().toISOString();
    const splitCorrections = parts.map((part, index) => {
      const note = noteBase ? `${noteBase} (split ${part.splitPart}/2)` : `Split section ${part.splitPart}/2`;
      return {
        ...originalCorrection,
        ...part,
        id: `${originalId || selectedKey || 'speed-rule'}-split-${Date.now()}-${index + 1}`,
        ruleId: undefined,
        sectionKey: undefined,
        source,
        note,
        expiresAt,
        appliedAt: now,
        verifiedAt: source === 'user_confirmed_posted_sign' ? now : originalCorrection.verifiedAt || null,
        verificationStatus: source === 'user_confirmed_posted_sign' ? 'confirmed_posted_sign' : 'user_estimate',
        directionMode: part.directionMode || originalCorrection.directionMode || 'both',
        directionBearing: part.directionBearing,
        timeRule: part.timeRule,
        roadName: part.roadName || '',
        contextLabel: part.contextLabel,
        directionLabel: directionLabel(part.directionMode),
        sectionPoints: part.sectionPoints,
        splitParentId: originalId || selectedKey || null,
        splitPart: part.splitPart,
        auditTrail: [
          ...(Array.isArray(originalCorrection.auditTrail) ? originalCorrection.auditTrail : []),
          {
            action: 'split_from_midpoint',
            changedAt: now,
            splitPart: part.splitPart,
          },
        ].slice(-25),
      };
    });
    const nextKnowledge = {
      ...beforeKnowledge,
      corrections: [
        ...(beforeKnowledge.corrections || []).filter((correction) => !matchesOriginal(correction)),
        ...splitCorrections,
      ],
    };
    const replaced = await knowledge.replaceData(nextKnowledge, 'split_correction').catch(() => false);
    if (replaced) {
      setRows((current) => [
        ...current.filter((row) => !matchesOriginal(row)),
        ...splitCorrections,
      ]);
      setSelectedSection(splitCorrections[0]);
      setAddMode(false);
      setAddPath([]);
      setMapEditorSnapshot(splitCorrections[0], mapDraft);
      revealSavedSpeedMapLayer(source);
      const updatedTrips = await withRecalculation(() => (
        refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, nextKnowledge).catch(() => null)
      ));
      const recalculated = Array.isArray(updatedTrips) ? updatedTrips.length : 0;
      setStatus(withUndo(`Road section split into two saved speeds. First half is selected; drag S, E, or any numbered bend handle to refine it. Recalculated ${recalculated} matching trip${recalculated === 1 ? '' : 's'} locally.`));
      await refreshRowsAndMap();
    } else {
      setStatus('Could not split this section completely. Review saved speeds before trying again.');
      await refreshRowsAndMap();
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
      ? await withRecalculation(() => (
        refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
      ))
      : null;
    setStatus(updatedTrips
      ? `Change undone. Recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.`
      : 'Change undone, but affected trips could not be recalculated right now.');
    setBusyGeohash(null);
    await refreshRowsAndMap();
  };

  const exportSpeedKnowledge = async () => {
    const confirmed = await requestAppConfirm({
      title: 'Export speed rules?',
      message: SPEED_RULE_EXPORT_PRIVACY_WARNING,
      confirmLabel: 'Export rules',
    });
    if (!confirmed) return;
    const data = await knowledge.exportData();
    const filename = `road-sage-speed-rules-${new Date().toISOString().slice(0, 10)}.json`;
    const payload = {
      app: 'Road Sage',
      format: 'road-sage-speed-knowledge',
      version: 1,
      exported_at: new Date().toISOString(),
      includes: {
        saved_rules: true,
        map_line_geometry: true,
        learned_speed_cells: true,
        map_tiles: false,
      },
      speed_knowledge: data,
    };
    try {
      const result = await saveSpeedKnowledgeExport(filename, payload);
      setStatus(result.native
        ? `Saved ${rows.length} road-speed rule${rows.length === 1 ? '' : 's'} to Downloads as ${result.filename}. Map lines and speed-map data are included.`
        : `Downloading ${rows.length} road-speed rule${rows.length === 1 ? '' : 's'} as ${result.filename}. Map lines and speed-map data are included.`);
    } catch (error) {
      logSystemFailure('speed_knowledge_export_failed', error, {
        rule_count: rows.length,
      });
      setStatus('Could not export saved road speeds right now. Check system logs for the exact failure.');
    }
  };

  const refreshSavedRoadSpeeds = async () => {
    await refreshRowsAndMap();
    setStatus('Saved road speeds refreshed.');
  };

  const repairSavedRoadSpeeds = async () => {
    setBusyGeohash('repair');
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const result = await knowledge.repairSavedSpeedData().catch(() => null);
    if (!result) {
      setStatus('Could not repair saved road speeds right now. Try refresh, then repair again.');
      setBusyGeohash(null);
      return;
    }
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    const updatedTrips = result.changed && beforeKnowledge && afterKnowledge
      ? await withRecalculation(() => (
        refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
      ))
      : null;
    setBusyGeohash(null);
    await refreshRowsAndMap({ silent: true });
    if (!result.changed) {
      setStatus('Repair checked saved road speeds. No expired or duplicate saved rules needed cleanup.');
      return;
    }
    const removed = Number(result.removedExpired || 0) + Number(result.removedDuplicates || 0);
    setStatus(withUndo(updatedTrips
      ? `Repair removed ${removed} stale or duplicate saved rule${removed === 1 ? '' : 's'} and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
      : `Repair removed ${removed} stale or duplicate saved rule${removed === 1 ? '' : 's'}. Matching trips could not be recalculated right now.`));
  };

  const closeMapEditor = async () => {
    const confirmed = await confirmDiscardMapEditorChanges('close the editor');
    if (!confirmed) return;
    setAddMode(false);
    setAddPath([]);
    setSelectedSection(null);
    setMapEditorSnapshot(null);
  };

  const cancelAddSection = async () => {
    const confirmed = await confirmDiscardMapEditorChanges('cancel adding this road speed');
    if (!confirmed) return;
    setAddMode(false);
    setAddPath([]);
    setSelectedSection(null);
    setMapEditorSnapshot(null);
    setStatus('Add road section cancelled.');
  };

  const toggleAutoSnapTrace = () => {
    setAutoSnapTrace((value) => {
      const next = !value;
      setStatus(next
        ? 'Auto-snap enabled. New trace points will snap to nearby recorded trip geometry when possible.'
        : 'Auto-snap disabled. New trace points will stay where you tap them.');
      return next;
    });
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
      const updatedTrips = await withRecalculation(() => (
        refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
      ));
      setStatus(withUndo(updatedTrips
        ? `Restored ${data.corrections.length} saved road-speed rule${data.corrections.length === 1 ? '' : 's'}, including map lines, and recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.`
        : `Restored ${data.corrections.length} saved road-speed rule${data.corrections.length === 1 ? '' : 's'}, including map lines, but affected trips could not be recalculated right now.`));
      await refreshRowsAndMap();
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
    if (!selected.length) {
      setStatus('Select at least one saved road-speed rule before confirming posted signs.');
      return;
    }
    const historyGroup = `bulk-confirm-${Date.now()}`;
    setBusyGeohash('bulk');
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const results = await Promise.all(selected.map((row) => knowledge.updateUserCorrection(
      correctionKey(row),
      row.limitKmh,
      'user_confirmed_posted_sign',
      row.note || 'Bulk confirmed from saved speed review',
      { historyGroup }
    ).catch(() => false)));
    const updated = selected.filter((_, index) => results[index]);
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    await withRecalculation(() => (
      beforeKnowledge && afterKnowledge
        ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
        : Promise.all(updated.map((row) => refreshTripsCrossingLocalSpeedCorrection(row).catch(() => null)))
    ));
    setSelectedRows(new Set());
    if (updated.length > 0) {
      revealSavedRowsFilter('user_confirmed_posted_sign');
      revealSavedSpeedMapLayer('user_confirmed_posted_sign');
    }
    setStatus(withUndo(updated.length > 0
      ? `Confirmed ${updated.length} selected rule${updated.length === 1 ? '' : 's'} as posted signs.`
      : 'Could not confirm the selected rules as posted signs.'));
    setBusyGeohash(null);
    await refreshRowsAndMap();
  };

  const deleteSelectedRows = async () => {
    const selected = rows.filter((row) => selectedRows.has(correctionKey(row)));
    if (!selected.length) {
      setStatus('Select at least one saved road-speed rule before deleting.');
      return;
    }
    const confirmed = await requestAppConfirm({
      title: 'Delete selected speed rules?',
      message: `Delete ${selected.length} selected saved road-speed rule${selected.length === 1 ? '' : 's'}?`,
      confirmLabel: 'Delete selected',
      destructive: true,
    });
    if (!confirmed) return;
    const historyGroup = `bulk-delete-${Date.now()}`;
    setBusyGeohash('bulk');
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const results = await Promise.all(selected.map((row) => (
      knowledge.removeUserCorrection(correctionKey(row), { historyGroup }).catch(() => false)
    )));
    const removed = selected.filter((_, index) => results[index]);
    removeSavedRowsFromView(removed);
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    await withRecalculation(() => (
      beforeKnowledge && afterKnowledge
        ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
        : Promise.all(removed.map((row) => refreshTripsCrossingLocalSpeedCorrection(row).catch(() => null)))
    ));
    setSelectedRows(new Set());
    setStatus(withUndo(`Deleted ${removed.length} selected rule${removed.length === 1 ? '' : 's'}.`));
    setBusyGeohash(null);
    await refreshRowsAndMap();
  };

  const cleanExpiredSpeedKnowledge = async () => {
    const beforeKnowledge = await knowledge.exportData();
    await knowledge.prune(180);
    const afterKnowledge = await knowledge.exportData();
    const updatedTrips = await withRecalculation(() => (
      refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
    ));
    setStatus(withUndo(updatedTrips
      ? `Removed expired rules and learned evidence older than 180 days. Recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.`
      : 'Removed expired rules and learned evidence older than 180 days, but affected trips could not be recalculated right now.'));
    await refreshRowsAndMap();
  };

  if (loading && !loadedOnce) return <SavedRoadSpeedsSkeleton />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-grotesk text-2xl font-bold tracking-tight">Saved road speeds</h1>
            <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground">
              {rows.length} saved
            </span>
            <InlineRefreshBadge visible={refreshing} label="Refreshing saved speeds" />
            <InlineRefreshBadge visible={mapModelLoading} label="Loading map model" />
            <InlineRefreshBadge visible={recalculationBusy} label="Updating trip scores" />
            <InlineRefreshBadge visible={mapQueryPending} label="Updating map filter" />
            <InlineRefreshBadge visible={isRowQueryPending} label="Updating saved speed rows" />
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
            title="Export speed rules and precise road locations"
            aria-label="Export speed rules and precise road locations"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setStatus('Choose a Road Sage speed-rule JSON file to restore.');
              restoreInputRef.current?.click();
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-secondary"
            title="Restore speed rules"
            aria-label="Restore speed rules"
          >
            <Upload className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={refreshSavedRoadSpeeds}
            disabled={loading}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={repairSavedRoadSpeeds}
            disabled={loading || busyGeohash === 'repair'}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Repair
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

      <section className="rounded-xl border border-border bg-card px-3 py-2 shadow-sm">
        <div className="flex gap-1.5 overflow-x-auto thin-scrollbar">
          {speedSummaryMetrics(rows, mapStats).map(({ key, label, value, Icon, className }) => (
            <div key={key} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-secondary/55 px-2.5 py-1.5 text-xs">
              <Icon className={`h-3.5 w-3.5 ${className}`} />
              <span className="font-semibold text-muted-foreground">{label}</span>
              <span className={`font-grotesk text-sm font-bold ${className}`}>{value}</span>
            </div>
          ))}
        </div>
      </section>

      <nav className="grid grid-cols-3 gap-1 rounded-2xl border border-border bg-card p-1.5 shadow-sm" aria-label="Saved road speed workspace">
        {SPEED_WORKSPACES.map(({ value, label, Icon }) => {
          const active = activeWorkspace === value;
          const count = value === 'review'
            ? attentionItems.length
            : value === 'saved'
              ? rows.length
              : mapStats.total;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setActiveWorkspace(value)}
              aria-pressed={active}
              className={`inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold transition-colors ${
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                active ? 'bg-primary-foreground/15' : 'bg-secondary'
              }`}>
                {count}
              </span>
            </button>
          );
        })}
      </nav>

      {activeWorkspace === 'review' && (
        <>
      {!mapModelLoaded && (
        <section className={`rounded-xl border px-3 py-2 text-sm font-medium ${
          mapModelState.status === 'error'
            ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200'
            : 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-200'
        }`}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {mapModelState.status === 'error'
                ? 'Map evidence could not load. Saved rules are still available.'
                : 'Loading trip evidence for conflicts and observed-only sections...'}
            </span>
            {mapModelState.status === 'error' && (
              <button
                type="button"
                onClick={() => loadMapModel({ force: true })}
                className="inline-flex items-center justify-center rounded-lg border border-current/30 px-2.5 py-1 text-xs font-semibold hover:bg-background/50"
              >
                Retry
              </button>
            )}
          </div>
        </section>
      )}
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
              Review conflicts first, then confirm trip speed zones and missing road speeds segment by segment.
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
                      : item.kind === 'voice'
                        ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200'
                      : item.kind === 'observed'
                        ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                        : item.kind === 'speedZone'
                          ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100'
                        : item.kind === 'review'
                          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                        : 'bg-secondary text-muted-foreground'
                  }`}>
                    {item.kind === 'conflict' ? 'Resolve' : item.kind === 'voice' ? 'Voice' : item.kind === 'speedZone' ? 'Zone' : item.kind === 'observed' ? 'Save' : item.kind === 'review' ? 'Review' : 'Set'}
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
        </>
      )}

      {activeWorkspace === 'map' && (
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
                onClick={addMode ? cancelAddSection : startAddingSection}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold ${
                  addMode ? 'border border-border bg-secondary text-foreground' : 'bg-primary text-primary-foreground'
                }`}
              >
                {addMode ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                {addMode ? 'Cancel adding' : 'Add road speed'}
              </button>
              {hiddenUnsetSectionCount > 0 && (
                <button
                  type="button"
                  onClick={restoreIgnoredUnsetMapSections}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  Restore hidden unset {hiddenUnsetSectionCount}
                </button>
              )}
              {excludedSpeedSectionCount > 0 && (
                <button
                  type="button"
                  onClick={restoreExcludedSpeedSections}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  Restore parking/private {excludedSpeedSectionCount}
                </button>
              )}
              {addMode && (
                <button
                  type="button"
                  onClick={toggleAutoSnapTrace}
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
              )}
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

        {TRIAGE_DISABLE_MAPS ? (
          <div className="flex h-[28rem] min-h-[22rem] items-center justify-center rounded-2xl border border-border bg-secondary/30 text-sm text-muted-foreground">
            Map disabled for Phase 0 timing test
          </div>
        ) : mapModelState.status === 'error' ? (
          <div className="flex h-[28rem] min-h-[22rem] flex-col items-center justify-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 text-center text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
            <div>Map trip data could not load. Saved speed rows are still available.</div>
            <button
              type="button"
              onClick={() => loadMapModel({ force: true })}
              className="inline-flex items-center justify-center rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700"
            >
              Retry map model
            </button>
          </div>
        ) : !mapModelLoaded ? (
          <MapModelSkeleton label="Loading saved road speed map model" />
        ) : <SpeedLimitEditorMap
          trips={mapTrips}
          corrections={rows}
          preparedSections={mapSections}
          selectedGeohash={correctionKey(selectedSection) || ''}
          mapQuery={deferredMapQuery}
          layers={mapLayers}
          addMode={addMode}
          addPath={addPath}
          selectedSectionOverride={selectedSection}
          onLayerChange={setMapLayers}
          onSelect={selectMapSection}
          onAddPoint={selectNewMapPoint}
          onMoveAddPoint={moveAddPoint}
          onMoveSectionPoint={moveSelectedSectionEndpoint}
        />}

        {addMode && (
          <div className="grid gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 shadow-sm dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <div className="font-semibold">Add speed trace</div>
              <div className="mt-1 text-xs opacity-85">
                {autoSnapTrace
                  ? 'Tap the start and end of the segment; Auto snap fills the recorded route shape when possible. Drag trace points if needed, then enter the speed below.'
                  : 'Tap along the road, drag trace points if needed, then enter the speed below.'}
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
            <p><strong>Snap to route</strong> matches the trace to one ordered recorded route segment within 80 metres. It never contacts a routing service.</p>
            <p><strong>Split at midpoint</strong> replaces one saved rule with two independently editable road sections.</p>
            <p><strong>Trim start/end</strong> removes one bad tail point from a saved rule and immediately updates affected trip scores.</p>
            <p><strong>Parking/private</strong> removes a saved rule or hides an unset section when it is a lot, driveway, or private access road.</p>
            <p><strong>Edit trace points</strong> hides the selected section&apos;s old line while editing. Drag S, E, or numbered bend handles, then update the road speed to save the new geometry.</p>
            <p><strong>Merge nearby</strong> joins two nearby saved sections only when their speeds match.</p>
            <p><strong>Continue tracing</strong> means the road is still being drawn. It disappears immediately after a successful save.</p>
          </div>
        </details>

        {selectedSection && (
          <div className="max-h-[78vh] overflow-y-auto rounded-2xl border border-primary/30 bg-card p-4 shadow-sm sm:max-h-none sm:overflow-visible">
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
                      ? `${addPath.length} trace point${addPath.length === 1 ? '' : 's'}. ${autoSnapTrace ? 'Tap start and end; add more anchors only if the road match needs help.' : 'Tap along the road and around each bend; at least two points are required.'}`
                    : `${selectedSectionPointCount} recorded point${selectedSectionPointCount === 1 ? '' : 's'} in this trip section. Enter the speed and save it as a road section.`}
                </p>
                {selectedSectionReason && (
                  <div className="mt-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                    {selectedSectionReason}
                  </div>
                )}
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
                      title="Match the trace to one ordered recorded route segment within 80 metres. No online routing service is used."
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
                onClick={closeMapEditor}
                className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"
                aria-label="Close road speed editor"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-[14rem_1fr_1fr_auto] xl:items-end">
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
                How do you know?
                <select
                  value={mapDraft.source}
                  onChange={(event) => setMapDraft((current) => ({ ...current, source: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="user_confirmed_posted_sign">Posted sign</option>
                  <option value="user_entered_estimate">Estimate</option>
                </select>
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveMapSection}
                  disabled={busyGeohash === correctionKey(selectedSection) || !canSaveSelectedMapSection}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {selectedSection.saved ? <Pencil className="h-3.5 w-3.5" /> : <Gauge className="h-3.5 w-3.5" />}
                  {selectedSection.saved ? 'Update road speed' : 'Save road speed'}
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
                {!selectedSection.saved && isUnsetMapSection(selectedSection) && (
                  <button
                    type="button"
                    onClick={ignoreUnsetMapSection}
                    disabled={busyGeohash === correctionKey(selectedSection)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Hide unset
                  </button>
                )}
              </div>
            </div>
            {!selectedSection.saved && isUnsetMapSection(selectedSection) && (
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-200">
                Hide unset removes this small prompt from the saved speed map and review list on this device. It does not delete the trip route.
              </div>
            )}
            <div className="mt-3 rounded-xl border border-border bg-secondary/30 p-3">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="text-xs font-semibold text-foreground">Cleanup tools</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Remove parking-lot tails, driveway stubs, or private access sections so they stop polluting saved speeds and review prompts.
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {selectedSection.saved && (
                    <>
                      <button
                        type="button"
                        onClick={() => trimSavedMapSection('start')}
                        disabled={busyGeohash === correctionKey(selectedSection) || (selectedSection.sectionPoints || []).length < 3}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                      >
                        <Scissors className="h-3.5 w-3.5" />
                        Trim start
                      </button>
                      <button
                        type="button"
                        onClick={() => trimSavedMapSection('end')}
                        disabled={busyGeohash === correctionKey(selectedSection) || (selectedSection.sectionPoints || []).length < 3}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                      >
                        <Scissors className="h-3.5 w-3.5" />
                        Trim end
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={markSelectedSectionPrivate}
                    disabled={busyGeohash === correctionKey(selectedSection)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
                  >
                    <Ban className="h-3.5 w-3.5" />
                    Parking/private
                  </button>
                </div>
              </div>
            </div>
            {editorWarnings.length > 0 && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                {editorWarnings[0]}
                {editorWarnings.length > 1 && ` +${editorWarnings.length - 1} more check${editorWarnings.length === 2 ? '' : 's'} in Advanced options.`}
              </div>
            )}
            {selectedBlockingOverlap && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                <div className="font-semibold">This save would duplicate an active saved rule.</div>
                <div className="mt-1">
                  Overlaps {selectedBlockingOverlap.roadName || 'another saved road section'} at {selectedBlockingOverlap.limitKmh || 'unknown'} km/h.
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedBlockingOverlap.section && (
                    <button
                      type="button"
                      onClick={() => selectMapSection(selectedBlockingOverlap.section)}
                      className="rounded-lg border border-red-200 bg-background px-2.5 py-1.5 font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/50 dark:bg-background/80 dark:text-red-300"
                    >
                      Edit existing rule
                    </button>
                  )}
                  {selectedSection?.saved && (
                    <button
                      type="button"
                      onClick={splitMapSection}
                      disabled={(selectedSection.sectionPoints || []).length < 2}
                      className="rounded-lg border border-red-200 bg-background px-2.5 py-1.5 font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-900/50 dark:bg-background/80 dark:text-red-300"
                    >
                      Split selected section
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setMapDraft((current) => ({
                        ...current,
                        directionMode: current.directionMode === 'both' ? 'forward' : current.directionMode,
                      }));
                      setStatus('Set this rule to a specific direction or time window, then review the overlap warning again before saving.');
                    }}
                    className="rounded-lg border border-red-200 bg-background px-2.5 py-1.5 font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/50 dark:bg-background/80 dark:text-red-300"
                  >
                    Make direction/time distinct
                  </button>
                </div>
              </div>
            )}
            <details className="mt-3 rounded-xl border border-border bg-secondary/30 p-3">
              <summary className="cursor-pointer text-xs font-semibold text-foreground">Advanced options</summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="grid gap-1 text-xs font-semibold">
                  Note
                  <input
                    type="text"
                    value={mapDraft.note}
                    onChange={(event) => setMapDraft((current) => ({ ...current, note: event.target.value }))}
                    placeholder="School zone, construction, sign changed..."
                    className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </label>
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
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
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
              </div>
              <label className="mt-3 grid gap-1 text-xs font-semibold md:max-w-xs">
                Active until
                <input
                  type="date"
                  value={mapDraft.expiresAtDate}
                  onChange={(event) => setMapDraft((current) => ({ ...current, expiresAtDate: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <div className="rounded-xl border border-border bg-background p-3 text-xs">
                  <div className="font-semibold text-foreground">Rule intelligence</div>
                  <div className="mt-1 text-muted-foreground">
                    {selectedRecommendation?.text || 'Enter a speed limit to calculate a recommendation.'}
                  </div>
                  {selectedImpactPreview && (
                    <div className="mt-2">
                      {selectedImpactPreview.affectedTripCount} affected trip{selectedImpactPreview.affectedTripCount === 1 ? '' : 's'} · {selectedImpactPreview.matchedPointCount} matched points · {selectedImpactPreview.estimatedEventCount} likely events
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
              {selectedSection.saved && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={snapSelectedSectionToTrips}
                    disabled={busyGeohash === correctionKey(selectedSection) || (selectedSection.sectionPoints || []).length < 2}
                    title="Match this saved geometry to one ordered recorded route segment within 80 metres. No online routing service is used."
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                  >
                    <Magnet className="h-3.5 w-3.5" />
                    Snap to route
                  </button>
                  <button
                    type="button"
                    onClick={splitMapSection}
                    disabled={busyGeohash === correctionKey(selectedSection) || (selectedSection.sectionPoints || []).length < 2}
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
                </div>
              )}
            </details>
            {selectedSection.conflict && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
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
      </section>
      )}

      {activeWorkspace === 'saved' && (
        <>
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
                value={rowQueryInput}
                onChange={(event) => updateRowQuery(event.target.value)}
                placeholder="Search saved speeds..."
                className="w-full rounded-xl border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-primary"
              />
            </label>
            <select
              value={rowSort}
              onChange={(event) => updateRowSort(event.target.value)}
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
                onClick={() => updateRowFilter(value)}
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

      {rows.length === 0 ? (
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
        <div
          ref={savedRowsListRef}
          className="max-h-[78vh] overflow-y-auto pr-1 thin-scrollbar"
          aria-label="Virtualized saved road speeds list"
        >
          <div
            className="relative w-full"
            style={{ height: `${savedRowsVirtualizer.getTotalSize()}px` }}
          >
          {virtualRowItems.map((virtualItem) => {
            const model = rowCardModels[virtualItem.index];
            if (!model) return null;
            const {
              key,
              row,
              draft,
              disabled,
              identity,
              conflict,
              evidence: rowEvidence,
              recommendation: rowRecommendation,
              impact: rowImpact,
            } = model;
            return (
              <article
                key={key}
                ref={savedRowsVirtualizer.measureElement}
                data-index={virtualItem.index}
                className="absolute left-0 top-0 w-full rounded-xl border border-border bg-card p-3 shadow-sm"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
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
          </div>
        </div>
      )}
        </>
      )}

      <details className="group rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-2 font-semibold">
            <Info className="h-4 w-4 flex-shrink-0" />
            <span>How saved road speeds are used</span>
          </span>
          <span className="shrink-0 rounded-lg border border-blue-200 bg-white/70 px-2 py-1 text-xs font-semibold text-blue-900 group-open:hidden dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100">
            Details
          </span>
          <span className="hidden shrink-0 rounded-lg border border-blue-200 bg-white/70 px-2 py-1 text-xs font-semibold text-blue-900 group-open:inline dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100">
            Hide
          </span>
        </summary>
        <div className="mt-3 grid gap-2 border-t border-blue-200 pt-3 text-xs leading-relaxed dark:border-blue-900/60 md:grid-cols-2">
          <p>
            Speeds you add, edit, split, expire, or delete here are saved locally on this device. When a saved rule matches the road, direction, date, and time, Road Sage uses it first for trip scoring, map colors, speed checks, and voice alerts.
          </p>
          <p>
            If no matching saved rule is available, Road Sage falls back to learned local data, OpenStreetMap/Get Road Data results, then lower-confidence road-type, regional, or GPS estimates.
          </p>
          <p>
            Saving and reviewing road speeds here can reduce how often you need OpenStreetMap lookups for the same roads. Your saved speed, road name, notes, split sections, direction rules, and time rules are not uploaded to OpenStreetMap.
          </p>
          <p>
            Get Road Data sends only privacy-filtered public-road bounding boxes to an OpenStreetMap Overpass service, which may receive normal network metadata such as your IP address. Privacy zones reduce what enabled road-data features can send, but they are not an absolute protection against device compromise, modified app builds, screenshots, exported files, network metadata, or user-approved external endpoints.
          </p>
          <p>
            This map uses OpenStreetMap tiles while online. Saved roads, trip geometry, editing, and speed labels remain available offline, but standard OpenStreetMap tiles are not downloaded for offline use. Tile providers can see the map tile area viewed and normal network metadata.
          </p>
          <p>
            Settings warning margins change when Road Sage warns you; they do not change the saved speed itself.
          </p>
        </div>
      </details>
    </div>
  );
}
