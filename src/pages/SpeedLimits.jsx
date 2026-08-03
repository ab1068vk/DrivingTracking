// @ts-check
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowLeft, Ban, CheckSquare2, Download, Gauge, GitMerge, HeartPulse, Info, Magnet, Map as MapIcon, MapPin, Pencil, Plus, RefreshCw, Scissors, Search, ShieldCheck, SlidersHorizontal, Trash2, Undo2, Upload, X } from 'lucide-react';
import { geohashEncode, LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import { refreshTripsCrossingLocalSpeedCorrection, refreshTripsForLocalSpeedKnowledgeChanges, tripCrossesCorrection } from '@/lib/localSpeedScoreRefresh';
import { correctionSectionIdentity } from '@/lib/roadSectionIdentity';
import RoadSectionPreview from '@/components/RoadSectionPreview';
import SpeedLimitEditorMap from '@/components/SpeedLimitEditorMap';
import { beginMeasure, TRIAGE_DISABLE_MAPS } from '@/lib/performanceTriage';
import {
  SPEED_MAP_LAYER_FAST_DEFAULTS,
  buildSpeedMapSections,
  buildSplitCorrections,
  buildSpeedZoneReviewItems,
  findOverlappingSpeedSections,
  findMergeableSpeedSection,
  filterSpeedMapSections,
  mergeTrustedSpeedMapSections,
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
import { getHydratedPrivacyZones, getPrivacyZones } from '@/lib/privacyZones';
import useLocalSettings from '@/hooks/useLocalSettings';
import RoadSpeedCommandCenter from '@/components/RoadSpeedCommandCenter';
import SpeedRescoreStatus from '@/components/SpeedRescoreStatus';
import SpeedSignEvidenceReview from '@/components/SpeedSignEvidenceReview';
import WhyThisSpeed from '@/components/WhyThisSpeed';
import RoadMemoryChangeReview from '@/components/RoadMemoryChangeReview';
import RoadMemoryIntelligencePanel from '@/components/RoadMemoryIntelligencePanel';
import {
  listSpeedSignEvidence,
  SPEED_SIGN_EVIDENCE_CHANGED_EVENT,
  syncNativeSpeedSignEvidence,
} from '@/lib/speedSignEvidence';
import { assessSpeedLimitEvidence, speedLimitConfidenceLabel } from '@/lib/speedLimitConfidence';
import {
  buildCorrectionImpactPreview,
  buildSpeedLimitRecommendation,
} from '@/lib/speedLimitIntelligence';
import {
  getNativeSpeedKnowledgeMirrorStatus,
  retryNativeSpeedKnowledgeMirror,
  speedKnowledgeStore,
} from '@/lib/speedKnowledgeRepository';
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
import {
  buildSpeedMapModelCacheKey,
  readSpeedMapModelCache,
  writeSpeedMapModelCache,
} from '@/lib/speedMapModelCache';
import InlineRefreshBadge from '@/components/InlineRefreshBadge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/use-toast';
import { requestAppConfirm } from '@/lib/appDialog';
import {
  matchesSavedRoadSpeedFilter,
  savedRoadSpeedSearchText,
  sortSavedRoadSpeedRows,
} from '@/lib/savedRoadSpeedFilters';
import { backfillLocalRoadMemoryFromTripHistory } from '@/lib/roadMemoryCoordinator';
import {
  readSpeedGeometryIndex,
  rebuildSpeedGeometryIndex,
} from '@/lib/speedGeometryIndex';
import { buildLocalCorridorGraph, summarizeLocalCorridorGraph } from '@/lib/localCorridorGraph';
import { buildSpeedEvidenceDecision } from '@/lib/speedEvidenceReasoning';
import { sanitizeSpeedKnowledge } from '@/lib/dataBackup';
import { MAX_SAVED_SPEED_LIMIT_KMH } from '@/lib/speedKnowledgeCellPolicy';
import {
  convertDisplaySpeedToKmh,
  convertSpeedKmh,
  formatSpeedKmh,
  speedInputValueFromKmh,
  speedUnitLabel,
} from '@/lib/unitFormatting';
import {
  changedSavedSpeedDraftKeys,
  reconcileSavedSpeedDrafts,
} from '@/lib/speedLimitDraftReconciliation';

const sourceLabel = (source) => speedLimitSourceLabel(source, { short: true });
const correctionKey = (correction = {}) => correction?.id || correction?.ruleId || correction?.sectionKey || correction?.geohash;
const IGNORED_UNSET_SPEED_SECTIONS_STORAGE_KEY = 'roadsage_ignored_unset_speed_sections_v1';
const SPEED_MAP_TRIP_BATCH_SIZE = 80;
const speedRuleLifecycleAt = (row = {}, nowMs = Date.now()) => {
  if (row.historicalVersion === true) return 'historical';
  const validFrom = row.validFrom ? new Date(row.validFrom).getTime() : null;
  const expiresAt = row.expiresAt ? new Date(row.expiresAt).getTime() : null;
  if (row.validFrom && !Number.isFinite(validFrom)) return 'invalid';
  if (row.expiresAt && !Number.isFinite(expiresAt)) return 'invalid';
  if (Number.isFinite(validFrom) && nowMs < validFrom) return 'future';
  if (Number.isFinite(expiresAt) && nowMs >= expiresAt) return 'expired';
  return 'active';
};
const SPEED_RULE_EXPORT_PRIVACY_WARNING = [
  'This export contains precise road locations, map-line coordinates, and your saved speed rules.',
  'Store it securely and share it only with people you trust.',
  '',
  'Continue with the export?',
].join('\n');

const formatSpeedLimit = (value, units = 'metric') => formatSpeedKmh(value, units);

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

const SPEED_RULE_QUALIFIER_OPTIONS = [
  ['regulatory_text_no_qualifiers', 'Standard / unconditional'],
  ['conditional_school_when_flashing', 'School zone - flashing schedule'],
  ['conditional_school', 'School-zone schedule'],
  ['conditional_temporary_work_zone', 'Temporary work zone'],
  ['conditional_daytime', 'Daytime-only rule'],
  ['conditional_night', 'Night-only rule'],
];

const qualifierStatusForDraft = (draft = {}) => (
  SPEED_RULE_QUALIFIER_OPTIONS.some(([value]) => value === draft.qualifierStatus)
    ? draft.qualifierStatus
    : 'regulatory_text_no_qualifiers'
);

const qualifierStatusLabel = (value) => (
  SPEED_RULE_QUALIFIER_OPTIONS.find(([option]) => option === value)?.[1] ||
  'Standard / unconditional'
);

const qualifierDraftPatch = (value, draft = {}) => {
  const qualifierStatus = SPEED_RULE_QUALIFIER_OPTIONS.some(([option]) => option === value)
    ? value
    : 'regulatory_text_no_qualifiers';
  if (
    qualifierStatus !== 'regulatory_text_no_qualifiers' &&
    qualifierStatus !== 'conditional_temporary_work_zone' &&
    (draft.timeRuleMode || 'always') === 'always'
  ) {
    return {
      qualifierStatus,
      timeRuleMode: qualifierStatus.startsWith('conditional_school') ? 'weekdays' : 'daily',
    };
  }
  return { qualifierStatus };
};

const timeRuleModeForRow = (row = {}) => {
  const rule = row.timeRule;
  if (rule?.enabled !== true) return 'always';
  const days = [...(rule.days || [])].sort((a, b) => a - b).join(',');
  if (days === '1,2,3,4,5') return 'weekdays';
  if (days === '0,6') return 'weekends';
  if (days === '0,1,2,3,4,5,6') return 'daily';
  return 'custom';
};

/** @type {Array<[number, string]>} */
const TIME_RULE_DAY_OPTIONS = [
  [0, 'Sun'],
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
];

const normalizedDraftDays = (draft = {}) => [...new Set(
  (Array.isArray(draft.customDays) ? draft.customDays : [])
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
)].sort((a, b) => a - b);

const invalidCustomDayRule = (draft = {}) => (
  draft.timeRuleMode === 'custom' && normalizedDraftDays(draft).length === 0
);

const timeString = (minutes, fallback = '07:00') => {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.max(0, Math.min(1439, Math.round(value)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
};

const timeRuleLabel = (rule = null) => {
  if (rule?.enabled !== true) return 'Always active';
  const mode = timeRuleModeForRow({ timeRule: rule });
  const dayLabel = mode === 'weekdays'
    ? 'Weekdays'
    : mode === 'weekends'
      ? 'Weekends'
      : mode === 'custom'
        ? TIME_RULE_DAY_OPTIONS
          .filter(([day]) => (rule.days || []).includes(day))
          .map(([, label]) => label)
          .join(', ')
        : 'Every day';
  return `${dayLabel} ${timeString(rule.startMinutes)}-${timeString(rule.endMinutes)}`;
};

const dateInputValue = (value, storedDate = '') => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(storedDate || ''))) return String(storedDate);
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-')
    : '';
};

const expiresAtFromDate = (value) => (
  value ? new Date(`${value}T23:59:59.999`).toISOString() : null
);

const validFromFromDate = (value) => (
  value ? new Date(`${value}T00:00:00`).toISOString() : null
);

const boundaryFromDraft = (draft = {}, kind = 'validFrom') => {
  const dateKey = kind === 'expiresAt' ? 'expiresAtDate' : 'validFromDate';
  const originalKey = kind === 'expiresAt' ? 'originalExpiresAt' : 'originalValidFrom';
  const originalDateKey = kind === 'expiresAt'
    ? 'originalExpiresAtDate'
    : 'originalValidFromDate';
  const selectedDate = String(draft?.[dateKey] || '');
  if (
    Object.prototype.hasOwnProperty.call(draft, originalKey) &&
    selectedDate === String(draft?.[originalDateKey] || '')
  ) {
    return draft?.[originalKey] || null;
  }
  return kind === 'expiresAt'
    ? expiresAtFromDate(selectedDate)
    : validFromFromDate(selectedDate);
};

const validityFromDraft = (draft = {}) => ({
  validFrom: boundaryFromDraft(draft, 'validFrom'),
  validFromDate: String(draft.validFromDate || '') || null,
  expiresAt: boundaryFromDraft(draft, 'expiresAt'),
  expiresAtDate: String(draft.expiresAtDate || '') || null,
});

const qualifierDraftError = (draft = {}) => {
  const qualifierStatus = qualifierStatusForDraft(draft);
  if (
    qualifierStatus === 'conditional_temporary_work_zone' &&
    !validityFromDraft(draft).expiresAt
  ) return 'Temporary work-zone rules need an Active until date.';
  if (
    qualifierStatus !== 'regulatory_text_no_qualifiers' &&
    qualifierStatus !== 'conditional_temporary_work_zone' &&
    (draft.timeRuleMode || 'always') === 'always'
  ) return 'This conditional rule needs active days and times.';
  return '';
};

const invalidValidityWindow = (draft = {}) => {
  const { validFrom, expiresAt } = validityFromDraft(draft);
  return Boolean(validFrom && expiresAt && new Date(validFrom).getTime() >= new Date(expiresAt).getTime());
};

const expiryLabel = (value) => (
  value ? `Expires ${new Date(value).toLocaleDateString()}` : 'No expiry'
);

const validFromLabel = (value) => (
  value ? `Effective ${new Date(value).toLocaleDateString()}` : 'All recorded history'
);

const DEFAULT_MAP_DRAFT = {
  limitKmh: '',
  source: 'user_confirmed_posted_sign',
  qualifierStatus: 'regulatory_text_no_qualifiers',
  note: '',
  roadName: '',
  directionMode: 'both',
  timeRuleMode: 'always',
  startTime: '07:00',
  endTime: '17:00',
  customDays: [1, 2, 3, 4, 5],
  validFromDate: '',
  expiresAtDate: '',
  originalValidFrom: null,
  originalValidFromDate: '',
  originalExpiresAt: null,
  originalExpiresAtDate: '',
};

const mapDraftForSection = (section = {}) => ({
  ...DEFAULT_MAP_DRAFT,
  limitKmh: mapDraftLimitForSection(section),
  source: mapDraftSourceForSection(section),
  qualifierStatus: qualifierStatusForDraft(section),
  note: section.note || '',
  roadName: section.roadName || '',
  directionMode: section.directionMode || 'both',
  timeRuleMode: timeRuleModeForRow(section),
  startTime: timeString(section.timeRule?.startMinutes),
  endTime: timeString(section.timeRule?.endMinutes, '17:00'),
  customDays: Array.isArray(section.timeRule?.days)
    ? [...section.timeRule.days]
    : DEFAULT_MAP_DRAFT.customDays,
  validFromDate: dateInputValue(section.validFrom, section.validFromDate),
  expiresAtDate: dateInputValue(section.expiresAt, section.expiresAtDate),
  originalValidFrom: section.validFrom || null,
  originalValidFromDate: dateInputValue(section.validFrom, section.validFromDate),
  originalExpiresAt: section.expiresAt || null,
  originalExpiresAtDate: dateInputValue(section.expiresAt, section.expiresAtDate),
});

const draftForCorrection = (row = {}) => ({
  limitKmh: String(row.limitKmh || ''),
  source: row.source || 'user_entered_estimate',
  qualifierStatus: qualifierStatusForDraft(row),
  note: row.note || '',
  roadName: row.roadName || '',
  directionMode: row.directionMode || 'both',
  timeRuleMode: timeRuleModeForRow(row),
  startTime: timeString(row.timeRule?.startMinutes),
  endTime: timeString(row.timeRule?.endMinutes, '17:00'),
  customDays: Array.isArray(row.timeRule?.days)
    ? [...row.timeRule.days]
    : [...DEFAULT_MAP_DRAFT.customDays],
  validFromDate: dateInputValue(row.validFrom, row.validFromDate),
  expiresAtDate: dateInputValue(row.expiresAt, row.expiresAtDate),
  originalValidFrom: row.validFrom || null,
  originalValidFromDate: dateInputValue(row.validFrom, row.validFromDate),
  originalExpiresAt: row.expiresAt || null,
  originalExpiresAtDate: dateInputValue(row.expiresAt, row.expiresAtDate),
});

const normalizeMapDraftForCompare = (draft = {}) => JSON.stringify({
  limitKmh: String(draft.limitKmh ?? '').trim(),
  source: String(draft.source || DEFAULT_MAP_DRAFT.source),
  qualifierStatus: qualifierStatusForDraft(draft),
  note: String(draft.note ?? ''),
  roadName: String(draft.roadName ?? ''),
  directionMode: String(draft.directionMode || DEFAULT_MAP_DRAFT.directionMode),
  timeRuleMode: String(draft.timeRuleMode || DEFAULT_MAP_DRAFT.timeRuleMode),
  startTime: String(draft.startTime || DEFAULT_MAP_DRAFT.startTime),
  endTime: String(draft.endTime || DEFAULT_MAP_DRAFT.endTime),
  customDays: normalizedDraftDays(draft).join(','),
  validFromDate: String(draft.validFromDate || ''),
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

const hasTracedRoadGeometry = (section = {}) => {
  const points = (Array.isArray(section.sectionPoints) ? section.sectionPoints : [])
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => (
      Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90 &&
      Number.isFinite(point.lng) && point.lng >= -180 && point.lng <= 180
    ));
  if (points.length < 2) return false;
  const first = points[0];
  return points.some((point) => point.lat !== first.lat || point.lng !== first.lng);
};

const speedConflictCompareKey = (conflict = null) => JSON.stringify(conflict ? {
  savedLimitKmh: Number(conflict.savedLimitKmh) || null,
  observedLimitKmh: Number(conflict.observedLimitKmh) || null,
  deltaKmh: Number(conflict.deltaKmh) || null,
  geohash: String(conflict.geohash || ''),
} : null);

const timeRuleFromDraft = (draft = {}) => {
  const mode = draft.timeRuleMode || 'always';
  if (mode === 'always') return { enabled: false };
  const days = mode === 'weekdays'
    ? [1, 2, 3, 4, 5]
    : mode === 'weekends'
      ? [0, 6]
      : mode === 'custom'
        ? normalizedDraftDays(draft)
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
  ['historical', 'Historical'],
];
/** @type {Array<[string, string]>} */
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
  resolve_conflict_update: 'conflict decision',
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

const mapSectionReasonText = (section = {}, addMode = false, units = 'metric') => {
  if (section.saved) {
    const source = sourceLabel(section.source);
    return `Saved local rule from ${source}; this rule is used before trip-derived map evidence.`;
  }
  if (addMode) return 'New traced road section; it will become a saved local rule after saving.';
  if (section.roadMemoryCandidate) {
    const stageText = section.canAffectScoreAndAlerts === true
      ? 'This estimate can affect scoring and alerts.'
      : section.stage === 'change_review'
        ? `Recent drives may indicate a change to ${formatSpeedLimit(section.changeDetection?.proposedLimitKmh, units)}; scoring and alerts are paused here.`
        : 'This is visible for exploration but does not affect scoring or alerts yet.';
    return `Road Memory suggests ${formatSpeedLimit(section.effectiveLimitKmh, units)}. ${section.confidenceExplanation || `${Number(section.tripCount) || 1} repeated drives at ${Math.round((Number(section.confidence) || 0) * 100)}% confidence`}. ${stageText}`;
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

export default function SpeedLimits() {
  const [searchParams] = useSearchParams();
  const tripId = searchParams.get('tripId');
  const initialWorkspace = ['map', 'review', 'saved'].includes(searchParams.get('view'))
    ? searchParams.get('view')
    : tripId ? 'review' : 'map';
  const knowledge = useMemo(() => new LocalSpeedKnowledge(speedKnowledgeStore), []);
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const dirtyDraftKeysRef = useRef(new Set());
  const persistedDraftBaselinesRef = useRef({});
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [mapModelState, setMapModelState] = useState(/** @type {any} */ ({
    status: 'idle',
    error: null,
    totalTripCount: 0,
    nextOffset: 0,
  }));
  const mapModelStateRef = useRef(/** @type {any} */ ({
    status: 'idle',
    error: null,
    totalTripCount: 0,
    nextOffset: 0,
  }));
  const [mapSectionBuildState, setMapSectionBuildState] = useState(/** @type {any} */ ({
    status: 'idle',
    durationMs: null,
  }));
  const [rawMapSections, setRawMapSections] = useState([]);
  const [mapMoreBusy, setMapMoreBusy] = useState(false);
  const [recalculationBusy, setRecalculationBusy] = useState(false);
  const recalculationCountRef = useRef(0);
  const loadedOnceRef = useRef(false);
  const [busyGeohash, setBusyGeohash] = useState(null);
  const [status, setStatus] = useState(/** @type {string | { message: string, scoreDeltas?: any[], canUndo?: boolean }} */ (''));
  const [linkedTrip, setLinkedTrip] = useState(null);
  const [mapTrips, setMapTrips] = useState([]);
  const [geometryIndexState, setGeometryIndexState] = useState({
    status: 'idle',
    indexedTripCount: 0,
    totalAvailable: 0,
    truncated: false,
  });
  const [roadMemoryCandidates, setRoadMemoryCandidates] = useState([]);
  const [smartProtection, setSmartProtection] = useState({
    confirmedCorridorCount: 0,
    suppressedSuggestionCount: 0,
  });
  const [memoryHistorySync, setMemoryHistorySync] = useState({
    status: 'idle',
    scannedTripCount: 0,
    observationCount: 0,
  });
  const [cameraReviewCount, setCameraReviewCount] = useState(0);
  const [selectedSection, setSelectedSection] = useState(null);
  const [addMode, setAddMode] = useState(false);
  const [addPath, setAddPath] = useState([]);
  const [mapQuery, setMapQuery] = useState('');
  const deferredMapQuery = useDeferredValue(mapQuery);
  const [mapLayers, setMapLayers] = useState(SPEED_MAP_LAYER_FAST_DEFAULTS);
  const [activeWorkspace, setActiveWorkspace] = useState(initialWorkspace);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const [workspacePending, startWorkspaceTransition] = useTransition();
  const [autoSnapTrace, setAutoSnapTrace] = useState(true);
  const [ignoredUnsetSectionKeys, setIgnoredUnsetSectionKeys] = useState(readIgnoredUnsetSectionKeys);
  const [excludedSpeedSectionKeys, setExcludedSpeedSectionKeys] = useState(readExcludedSpeedSectionKeys);
  const [persistedExcludedSpeedSections, setPersistedExcludedSpeedSections] = useState([]);
  const [rowQueryInput, setRowQueryInput] = useState('');
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
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
  const [nativeMirrorHealth, setNativeMirrorHealth] = useState(() => getNativeSpeedKnowledgeMirrorStatus());
  const [nativeMirrorRetrying, setNativeMirrorRetrying] = useState(false);
  const [lifecycleNow, setLifecycleNow] = useState(() => Date.now());
  const restoreInputRef = useRef(null);
  const reviewWorkspaceRef = useRef(null);
  const reviewInventoryRef = useRef(null);
  const learningInventoryRef = useRef(null);
  const knowledgeReloadTimerRef = useRef(null);
  const mapTripsLoadRef = useRef(0);
  const mapModelCancelRef = useRef(null);
  const mapModelWorkerRef = useRef(null);
  const mapSectionBuildRequestRef = useRef(0);
  const savedRowsListRef = useRef(null);
  const lastStatusToastRef = useRef('');
  const selectedMapEditSnapshotRef = useRef(null);
  const legacyExclusionMigrationRef = useRef(new Set());
  const [mapDraft, setMapDraft] = useState(DEFAULT_MAP_DRAFT);
  const settings = useLocalSettings();
  const units = settings.units === 'imperial' ? 'imperial' : 'metric';
  const speedUnit = speedUnitLabel(units);
  const speedQuickPicks = units === 'imperial'
    ? [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70]
    : COMMON_SPEED_LIMITS_KMH;
  const privacyZones = useMemo(() => getPrivacyZones(settings), [settings]);
  const tripEvidenceLayersRequested = activeWorkspace === 'review' || (
    activeWorkspace === 'map' && (
      mapLayers.conflicts ||
      mapLayers.learned ||
      mapLayers.observed ||
      mapLayers.unset
    )
  );
  const mapModelActive = MAP_MODEL_WORKSPACES.has(activeWorkspace) && tripEvidenceLayersRequested;
  const mapModelLoading = mapModelState.status === 'loading';
  const mapModelLoaded = mapModelState.status === 'loaded' && mapSectionBuildState.status === 'ready';
  const mapQueryPending = mapQuery !== deferredMapQuery;
  const switchWorkspace = useCallback((workspace) => {
    startWorkspaceTransition(() => setActiveWorkspace(workspace));
  }, []);
  const ignoredUnsetSectionKeySet = useMemo(() => new Set(ignoredUnsetSectionKeys), [ignoredUnsetSectionKeys]);
  const excludedSpeedSectionKeySet = useMemo(() => new Set(excludedSpeedSectionKeys), [excludedSpeedSectionKeys]);
  const currentMapRows = useMemo(
    () => rows.filter((row) => speedRuleLifecycleAt(row, lifecycleNow) === 'active'),
    [lifecycleNow, rows]
  );
  useEffect(() => {
    const now = Date.now();
    const nextBoundary = rows
      .flatMap((row) => [row.validFrom, row.expiresAt])
      .map((value) => value ? new Date(value).getTime() : Number.NaN)
      .filter((time) => Number.isFinite(time) && time > now)
      .sort((a, b) => a - b)[0];
    if (!Number.isFinite(nextBoundary)) return undefined;
    const timer = window.setTimeout(
      () => setLifecycleNow(Date.now()),
      Math.max(25, Math.min(2_147_000_000, nextBoundary - now + 25))
    );
    return () => window.clearTimeout(timer);
  }, [lifecycleNow, rows]);
  const trustedMapSections = useMemo(
    () => buildSpeedMapSections(
      [],
      currentMapRows,
      activeWorkspace === 'review' || mapLayers.learned ? roadMemoryCandidates : []
    ),
    [activeWorkspace, currentMapRows, mapLayers.learned, roadMemoryCandidates]
  );
  const completeRawMapSections = useMemo(
    () => mergeTrustedSpeedMapSections(rawMapSections, trustedMapSections),
    [rawMapSections, trustedMapSections]
  );
  const visibleRawMapSections = useMemo(() => completeRawMapSections.filter((section) => (
    (section.saved || !isSpeedSectionExcluded(section, excludedSpeedSectionKeySet)) &&
    (
      !isUnsetMapSection(section) ||
      !ignoredUnsetSectionKeySet.has(ignoredUnsetSectionKey(section))
    )
  )), [completeRawMapSections, excludedSpeedSectionKeySet, ignoredUnsetSectionKeySet]);
  const graphInputSections = useMemo(
    () => filterSpeedMapSections(visibleRawMapSections, { layers: mapLayers }),
    [mapLayers, visibleRawMapSections]
  );
  const completeCorridorGraph = useMemo(
    () => buildLocalCorridorGraph(visibleRawMapSections),
    [visibleRawMapSections]
  );
  const knowledgeSections = useMemo(
    () => completeCorridorGraph.sections.filter((section) => !section.graphDuplicateOf),
    [completeCorridorGraph.sections]
  );
  const corridorGraph = useMemo(
    () => buildLocalCorridorGraph(graphInputSections),
    [graphInputSections]
  );
  const corridorGraphSummary = useMemo(
    () => summarizeLocalCorridorGraph(corridorGraph),
    [corridorGraph]
  );
  const mapSections = useMemo(
    () => corridorGraph.sections.filter((section) => !section.graphDuplicateOf),
    [corridorGraph.sections]
  );
  const hiddenUnsetSectionCount = useMemo(() => completeRawMapSections.filter((section) => (
    isUnsetMapSection(section) &&
    ignoredUnsetSectionKeySet.has(ignoredUnsetSectionKey(section))
  )).length, [completeRawMapSections, ignoredUnsetSectionKeySet]);
  const excludedSpeedSectionCount = useMemo(() => Math.max(
    persistedExcludedSpeedSections.length,
    completeRawMapSections.filter((section) => (
      isSpeedSectionExcluded(section, excludedSpeedSectionKeySet)
    )).length
  ), [completeRawMapSections, excludedSpeedSectionKeySet, persistedExcludedSpeedSections.length]);
  const mapStats = useMemo(() => summarizeSpeedMapSections(mapSections), [mapSections]);
  // Prepared sections contain the full indexed history. The Leaflet component
  // only needs a small recent route sample for centering and edit assistance.
  const mapDisplayTrips = useMemo(
    () => mapTrips.slice(0, SPEED_MAP_TRIP_BATCH_SIZE),
    [mapTrips]
  );
  const activeManualRows = currentMapRows;
  const historicalRuleCount = rows.filter((row) => row.historicalVersion === true).length;
  const scheduledOrExpiredRuleCount = Math.max(0, rows.length - activeManualRows.length - historicalRuleCount);
  const postedRuleCount = useMemo(
    () => activeManualRows.filter((row) => row?.source === 'user_confirmed_posted_sign').length,
    [activeManualRows]
  );
  const operationalMemoryCount = useMemo(
    () => roadMemoryCandidates.filter((candidate) => candidate?.canAffectScoreAndAlerts === true).length,
    [roadMemoryCandidates]
  );
  const estimatedRuleCount = Math.max(0, activeManualRows.length - postedRuleCount) + operationalMemoryCount;
  const savedRowsNeedingReviewCount = useMemo(
    () => activeManualRows.filter((row) => assessSpeedLimitEvidence(row).needsReview).length,
    [activeManualRows]
  );
  const learningMemoryCandidates = useMemo(
    () => roadMemoryCandidates.filter((candidate) => (
      candidate?.usageStage === 'learning' || candidate?.usageStage === 'shadow'
    )),
    [roadMemoryCandidates]
  );
  const staleMemoryCount = useMemo(
    () => roadMemoryCandidates.filter((candidate) => candidate?.stage === 'stale').length,
    [roadMemoryCandidates]
  );
  const memoryChangeReviewCount = useMemo(
    () => roadMemoryCandidates.filter((candidate) => candidate?.stage === 'change_review').length,
    [roadMemoryCandidates]
  );
  const reviewInventory = useMemo(() => {
    const manualRules = activeManualRows.map((row) => ({
      key: `saved-${correctionKey(row)}`,
      kind: 'saved',
      focusKind: 'review',
      title: row.roadName || `Saved road ${String(row.geohash || '').slice(0, 6)}`,
      detail: `${formatSpeedLimit(row.limitKmh, units)} · ${sourceLabel(row.source)}`,
      badge: row.source === 'user_confirmed_posted_sign' ? 'Saved posted' : 'Saved estimate',
      tone: row.source === 'user_confirmed_posted_sign' ? 'violet' : 'emerald',
      section: {
        ...row,
        saved: true,
        effectiveLimitKmh: Number(row.limitKmh) || null,
      },
    }));
    const learnedRules = roadMemoryCandidates.map((candidate) => {
      const stage = candidate?.stage || 'learning';
      const stageDetail = candidate?.canAffectScoreAndAlerts === true
        ? `validated local estimate from ${Number(candidate.tripCount) || 0} drives`
        : candidate?.usageStage === 'shadow'
          ? `shadow estimate from ${Number(candidate.tripCount) || 0} drives · blocked from scores and alerts`
        : stage === 'change_review'
          ? `possible change ${formatSpeedLimit(candidate.changeDetection?.previousLimitKmh, units)} → ${formatSpeedLimit(candidate.changeDetection?.proposedLimitKmh, units)}`
          : stage === 'stale'
            ? `stale after ${Number(candidate.ageDays) || 0} days`
            : `${Number(candidate.tripCount) || 0} drives · not used for scores yet`;
      const badge = candidate?.canAffectScoreAndAlerts === true
        ? 'Validated Road Memory'
        : candidate?.usageStage === 'shadow'
          ? 'Shadow check'
        : stage === 'change_review'
          ? 'Possible change'
          : stage === 'stale'
            ? 'Stale'
            : stage === 'suggested'
              ? 'Almost ready'
              : 'Learning';
      return {
        key: `learned-${candidate.id || candidate.sectionKey || candidate.geohash}`,
        kind: 'learned',
        focusKind: stage === 'change_review' || stage === 'stale' ? 'memoryReview' : 'observed',
        title: candidate.roadName || `Learned road ${String(candidate.geohash || '').slice(0, 6)}`,
        detail: `${formatSpeedLimit(candidate.limitKmh, units)} · ${stageDetail}`,
        badge,
        tone: candidate?.canAffectScoreAndAlerts === true
          ? 'sky'
          : stage === 'change_review'
            ? 'amber'
            : stage === 'stale'
              ? 'slate'
              : 'cyan',
        section: {
          ...candidate,
          saved: false,
          operational: stage === 'operational',
          roadMemoryCandidate: true,
          source: 'local_road_memory',
          effectiveLimitKmh: Number(candidate.limitKmh) || null,
        },
      };
    });
    const query = knowledgeQuery.trim().toLowerCase();
    return [...manualRules, ...learnedRules].filter((item) => (
      !query || `${item.title} ${item.detail} ${item.badge}`.toLowerCase().includes(query)
    )).map((item) => ({
      ...item,
      intelligence: buildSpeedEvidenceDecision(item.section),
    })).sort((a, b) => (
      b.intelligence.reviewUrgency - a.intelligence.reviewUrgency ||
      a.title.localeCompare(b.title) || a.detail.localeCompare(b.detail)
    ));
  }, [activeManualRows, knowledgeQuery, roadMemoryCandidates, units]);
  const reviewInventoryVirtualizer = useVirtualizer({
    count: reviewInventory.length,
    getScrollElement: () => reviewInventoryRef.current,
    estimateSize: () => 68,
    overscan: 6,
  });
  const learningInventoryVirtualizer = useVirtualizer({
    count: learningMemoryCandidates.length,
    getScrollElement: () => learningInventoryRef.current,
    estimateSize: () => 76,
    overscan: 6,
  });
  const conflictsByGeohash = useMemo(() => new Map(
    knowledgeSections
      .filter((section) => section.conflict)
      .map((section) => [correctionKey(section), section.conflict])
  ), [knowledgeSections]);
  const filteredRows = useMemo(() => {
    const query = deferredRowQuery.trim().toLowerCase();
    const items = rows
      .map((row) => ({ row, conflict: conflictsByGeohash.get(correctionKey(row)) || null }))
      .filter(({ row, conflict }) => matchesSavedRoadSpeedFilter(row, conflict, deferredRowFilter))
      .filter(({ row, conflict }) => !query || savedRoadSpeedSearchText(row, conflict).includes(query));
    return sortSavedRoadSpeedRows(items, deferredRowSort).map(({ row }) => row);
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
        disabled: busyGeohash === key || row.historicalVersion === true,
        identity: correctionSectionIdentity(row, linkedTrip),
        conflict,
        evidence: assessSpeedLimitEvidence(row),
        recommendation: buildSpeedLimitRecommendation({ ...row, conflict }),
      };
    })
  ), [busyGeohash, conflictsByGeohash, drafts, filteredRows, linkedTrip]);
  const savedRowsVirtualizer = useVirtualizer({
    count: rowCardModels.length,
    getScrollElement: () => savedRowsListRef.current,
    estimateSize: () => 300,
    overscan: 3,
  });
  const virtualRowItems = savedRowsVirtualizer.getVirtualItems();
  const visibleRows = useMemo(
    () => virtualRowItems.map((item) => filteredRows[item.index]).filter(Boolean),
    [filteredRows, virtualRowItems]
  );
  const visibleRowImpactByKey = useMemo(() => {
    if (!mapModelLoaded || !mapTrips.length) return new Map();
    const entries = [];
    virtualRowItems.forEach((item) => {
      const model = rowCardModels[item.index];
      if (!model) return;
      const { key, row, draft } = model;
      entries.push([key, buildCorrectionImpactPreview(mapTrips, {
        ...row,
        limitKmh: Number(draft.limitKmh || row.limitKmh),
        qualifierStatus: qualifierStatusForDraft({ ...row, ...draft }),
        directionMode: draft.directionMode || row.directionMode,
        timeRule: timeRuleFromDraft(draft),
      }, draft.limitKmh || row.limitKmh)]);
    });
    return new Map(entries);
  }, [mapModelLoaded, mapTrips, rowCardModels, virtualRowItems]);
  const firstConflictSection = useMemo(
    () => knowledgeSections.find((section) => section.conflict),
    [knowledgeSections]
  );
  const speedZoneReviewItems = useMemo(() => (
    buildSpeedZoneReviewItems(knowledgeSections)
      .filter((item) => (
        Number(item?.section?.confirmedObservedLimits?.length) > 0 ||
        (item?.section?.observedSources || []).some((source) => (
          source === 'user_confirmed_posted_sign' || source === 'camera_sign_confirmed'
        ))
      ))
      .map((item) => ({
        ...item,
        title: item.section.roadName || `Trip speed zone ${item.zoneIndex}`,
        detail: `Zone ${item.zoneIndex} of ${item.zoneCount}: observed ${formatSpeedLimit(item.limitKmh, units)} from ${formatSourceList(item.section.observedSources)}. Save or adjust this segment separately.`,
      }))
  ), [knowledgeSections, units]);
  const attentionItems = useMemo(() => {
    const conflicts = knowledgeSections
      .filter((section) => section.conflict)
      .map((section) => ({
        key: `conflict-${correctionKey(section)}`,
        kind: 'conflict',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: `Saved ${formatSpeedLimit(section.conflict.savedLimitKmh, units)}, observed ${formatSpeedLimit(section.conflict.observedLimitKmh, units)}`,
        section,
      }));
    const reviewableSaved = knowledgeSections
      .filter((section) => {
        if (!section.saved || section.conflict) return false;
        const flags = speedMapSectionFlags(section);
        return flags.expired ||
          flags.expiring ||
          flags.stale ||
          flags.lowConfidence ||
          flags.missingGeometry;
      })
      .map((section) => ({
        key: `review-${correctionKey(section)}`,
        kind: 'review',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: `${speedSectionAttentionLabel(section)}; saved ${formatSpeedLimit(section.limitKmh, units)} from ${sourceLabel(section.source)}`,
        section,
      }));
    const memoryChanges = knowledgeSections
      .filter((section) => (
        section.roadMemoryCandidate &&
        (section.stage === 'change_review' || section.stage === 'stale')
      ))
      .map((section) => ({
        key: `memory-review-${correctionKey(section)}`,
        kind: 'memoryReview',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: section.stage === 'change_review'
          ? `Possible speed change: ${formatSpeedLimit(section.changeDetection?.previousLimitKmh, units)} to ${formatSpeedLimit(section.changeDetection?.proposedLimitKmh, units)}; confirmation needed`
          : `This previously active local estimate is stale and needs fresh evidence.`,
        section,
      }));
    return [...conflicts, ...speedZoneReviewItems, ...reviewableSaved, ...memoryChanges];
  }, [knowledgeSections, speedZoneReviewItems, units]);
  const visibleAttentionItems = showAllAttention ? attentionItems : attentionItems.slice(0, 24);
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
    qualifierStatus: qualifierStatusForDraft(mapDraft),
    directionMode: mapDraft.directionMode || 'both',
    timeRule: timeRuleFromDraft(mapDraft),
    ...validityFromDraft(mapDraft),
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
      ? findOverlappingSpeedSections(selectedCorrectionDraft, knowledgeSections, {
        excludeKey: correctionKey(selectedSection),
      })
      : []
  ), [knowledgeSections, selectedCorrectionDraft, selectedSection]);
  const blockingOverlapChecks = useMemo(
    () => selectedOverlapChecks.filter((item) => item.severity === 'block'),
    [selectedOverlapChecks]
  );
  const selectedBlockingOverlap = blockingOverlapChecks[0] || null;
  const selectedSectionReason = useMemo(
    () => selectedSection ? mapSectionReasonText(selectedSection, addMode, units) : '',
    [addMode, selectedSection, units]
  );
  const canSaveSelectedMapSection = Boolean(selectedSection) && (
    selectedSection.saved || selectedSectionPointCount >= 2
  ) && blockingOverlapChecks.length === 0 &&
    !invalidValidityWindow(mapDraft) &&
    !invalidCustomDayRule(mapDraft) &&
    !qualifierDraftError(mapDraft);
  const mergeCandidate = useMemo(() => (
    selectedSection?.saved
      ? findMergeableSpeedSection(selectedSection, knowledgeSections)
      : null
  ), [knowledgeSections, selectedSection]);
  const editorWarnings = useMemo(() => {
    if (!selectedSection) return [];
    const warnings = [];
    if (blockingOverlapChecks.length > 0) {
      const overlap = blockingOverlapChecks[0];
      warnings.push(`Blocked: this section overlaps ${overlap.roadName || 'another saved section'} saved at ${formatSpeedLimit(overlap.limitKmh, units)}. Split, merge, or edit the existing rule first.`);
    } else if (selectedOverlapChecks.length > 0) {
      const overlap = selectedOverlapChecks[0];
      warnings.push(`This geometry overlaps ${overlap.roadName || 'another saved section'} (${formatSpeedLimit(overlap.limitKmh, units)}). Save only if the direction or time rule makes it distinct.`);
    }
    if ((selectedSection.sectionPoints || []).length < 2) warnings.push('Trace at least two points to define a road section.');
    if (addMode && traceLengthM > 0 && traceLengthM < 25) warnings.push('Trace a longer section before saving; very short rules are easy to match to the wrong road.');
    if (!String(mapDraft.roadName || selectedSection.roadName || '').trim()) warnings.push('Add a road name to make future review and merging more reliable.');
    if (mapDraft.source === 'user_confirmed_posted_sign' && !String(mapDraft.note || '').trim()) {
      warnings.push('Add a short confirmation note for the audit history.');
    }
    if (invalidValidityWindow(mapDraft)) {
      warnings.push('Effective from must be earlier than Active until.');
    }
    if (invalidCustomDayRule(mapDraft)) {
      warnings.push('Choose at least one active day for this custom schedule.');
    }
    const qualifierError = qualifierDraftError(mapDraft);
    if (qualifierError) warnings.push(qualifierError);
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
    mapDraft.validFromDate,
    mapDraft.expiresAtDate,
    mapDraft.customDays,
    mapDraft.qualifierStatus,
    mapDraft.timeRuleMode,
    selectedImpactPreview,
    selectedOverlapChecks,
    selectedSection,
    traceLengthM,
    units,
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
    const removedKeys = new Set(removedRows.map(correctionKey).filter(Boolean));
    removedKeys.forEach((key) => dirtyDraftKeysRef.current.delete(key));
    persistedDraftBaselinesRef.current = Object.fromEntries(
      Object.entries(persistedDraftBaselinesRef.current)
        .filter(([key]) => !removedKeys.has(key))
    );
    setDrafts((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !removedKeys.has(key))
    ));

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
    const updatedTripsWithQueue = /** @type {any} */ (updatedTrips);
    const queuedTripCount = Math.max(0, Number(updatedTripsWithQueue.queuedTripCount) || 0);
    return {
      message: queuedTripCount
        ? `${message} ${queuedTripCount} more matching trip${queuedTripCount === 1 ? ' is' : 's are'} safely queued in the background.`
        : message,
      scoreDeltas: summarizeTripScoreDeltas(beforeTrips, updatedTrips),
      trips: updatedTrips,
      queuedTripCount,
    };
  }, []);

  const withUndo = useCallback((nextStatus) => (
    typeof nextStatus === 'string'
      ? { message: nextStatus, canUndo: true }
      : { ...nextStatus, canUndo: true }
  ), []);

  const retryNativeMirror = useCallback(async () => {
    if (nativeMirrorRetrying) return;
    setNativeMirrorRetrying(true);
    try {
      const next = await retryNativeSpeedKnowledgeMirror();
      setNativeMirrorHealth(next);
      setStatus(next.state === 'synced'
        ? 'Background Android speed alerts now use the latest privacy-safe saved roads.'
        : 'Background speed syncing remains paused until privacy filtering is available.');
    } catch (error) {
      setNativeMirrorHealth(getNativeSpeedKnowledgeMirrorStatus());
      setStatus(error?.message || 'Background speed syncing could not be retried yet.');
    } finally {
      setNativeMirrorRetrying(false);
    }
  }, [nativeMirrorRetrying]);

  useEffect(() => {
    if (!isNativePlatform() || nativeMirrorHealth.state !== 'unknown') return;
    void retryNativeMirror();
  }, [nativeMirrorHealth.state, retryNativeMirror]);

  const loadRows = useCallback(async ({ silent = false } = {}) => {
    const firstLoad = !loadedOnceRef.current;
    if (firstLoad && !silent) setLoading(true);
    else if (!silent) setRefreshing(true);
    const snapshot = await knowledge.getSpeedLimitsSnapshot().catch(() => ({
      rows: [],
      candidates: [],
      history: { canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' },
      rawKnowledge: { cells: {}, corrections: [] },
      exclusions: [],
      protection: { confirmedCorridorCount: 0, suppressedSuggestionCount: 0 },
    }));
    const nextRows = snapshot.rows;
    const nextCandidates = snapshot.candidates;
    const nextHistory = snapshot.history;
    const rawKnowledge = snapshot.rawKnowledge;
    const nextExclusions = snapshot.exclusions;
    setSmartProtection(snapshot.protection || {
      confirmedCorridorCount: 0,
      suppressedSuggestionCount: 0,
    });
    const safeRows = (Array.isArray(nextRows) ? nextRows : []).filter(Boolean);
    setRows(safeRows);
    setRoadMemoryCandidates((Array.isArray(nextCandidates) ? nextCandidates : []).filter(Boolean));
    const safeExclusions = (Array.isArray(nextExclusions) ? nextExclusions : []).filter(Boolean);
    setPersistedExcludedSpeedSections(safeExclusions);
    setExcludedSpeedSectionKeys((current) => [
      ...new Set([
        ...current,
        ...safeExclusions.flatMap(speedSectionExclusionKeys),
      ]),
    ]);
    setHistoryState(nextHistory);
    setHealth(inspectSpeedKnowledgeHealth(rawKnowledge));
    setNativeMirrorHealth(getNativeSpeedKnowledgeMirrorStatus());
    setSelectedRows((current) => new Set([...current].filter((key) => (
      safeRows.some((row) => correctionKey(row) === key && row.historicalVersion !== true)
    ))));
    const previousBaselines = persistedDraftBaselinesRef.current;
    /** @type {Record<string, any>} */
    const nextBaselines = {};
    safeRows.forEach((row) => {
      const key = correctionKey(row);
      if (key) nextBaselines[key] = draftForCorrection(row);
    });
    setDrafts((current) => {
      const dirtyKeys = changedSavedSpeedDraftKeys({
        current,
        baselines: previousBaselines,
        rows: safeRows,
        keyForRow: correctionKey,
        normalizeDraft: normalizeMapDraftForCompare,
      });
      dirtyDraftKeysRef.current = dirtyKeys;
      return reconcileSavedSpeedDrafts({
        current,
        rows: safeRows,
        dirtyKeys,
        keyForRow: correctionKey,
        draftForRow: draftForCorrection,
      });
    });
    persistedDraftBaselinesRef.current = nextBaselines;
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
    setMapSectionBuildState({ status: 'idle', durationMs: null });
    if (force) {
      setMapTrips([]);
      setRawMapSections([]);
    }
    mapModelCancelRef.current = scheduleIdleWork(() => {
      Promise.all([
        tripService.listForSpeedMap({
          sort: '-start_time',
          offset: 0,
          limit: SPEED_MAP_TRIP_BATCH_SIZE,
        }),
        readSpeedGeometryIndex().catch(() => ({ trips: [], totalAvailable: 0, truncated: false })),
      ])
        .then(([result, geometryIndex]) => {
          if (mapTripsLoadRef.current !== loadId) return;
          const recentTrips = Array.isArray(result?.trips) ? result.trips : [];
          const indexedTrips = Array.isArray(geometryIndex?.trips) ? geometryIndex.trips : [];
          const byId = new Map(indexedTrips.map((trip) => [String(trip?.id), trip]));
          recentTrips.forEach((trip) => byId.set(String(trip?.id), trip));
          const safeTrips = [...byId.values()];
          setMapTrips(safeTrips);
          setGeometryIndexState({
            status: indexedTrips.length ? 'ready' : 'idle',
            indexedTripCount: indexedTrips.length,
            totalAvailable: Math.max(indexedTrips.length, Number(geometryIndex?.totalAvailable) || 0),
            truncated: geometryIndex?.truncated === true,
          });
          const nextState = {
            status: 'loaded',
            error: null,
            totalTripCount: Math.max(
              safeTrips.length,
              Number(result?.totalAvailable) || 0,
              Number(geometryIndex?.totalAvailable) || 0
            ),
            nextOffset: Math.max(safeTrips.length, Number(result?.nextOffset) || 0),
          };
          mapModelStateRef.current = nextState;
          setMapModelState(nextState);
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

  const loadMoreMapTrips = useCallback(async () => {
    if (mapMoreBusy || mapModelStateRef.current.status !== 'loaded') return;
    const offset = Math.max(0, Number(mapModelStateRef.current.nextOffset) || mapTrips.length);
    const total = Math.max(0, Number(mapModelStateRef.current.totalTripCount) || 0);
    if (total > 0 && offset >= total) return;
    setMapMoreBusy(true);
    try {
      const result = await tripService.listForSpeedMap({
        sort: '-start_time',
        offset,
        limit: SPEED_MAP_TRIP_BATCH_SIZE,
      });
      const incoming = Array.isArray(result?.trips) ? result.trips : [];
      setMapTrips((current) => {
        const byId = new Map(current.map((trip) => [String(trip?.id), trip]));
        incoming.forEach((trip) => byId.set(String(trip?.id), trip));
        return [...byId.values()];
      });
      const nextState = {
        ...mapModelStateRef.current,
        status: 'loaded',
        error: null,
        totalTripCount: Math.max(
          Number(mapModelStateRef.current.totalTripCount) || 0,
          Number(result?.totalAvailable) || 0
        ),
        nextOffset: Math.max(offset + incoming.length, Number(result?.nextOffset) || 0),
      };
      mapModelStateRef.current = nextState;
      setMapModelState(nextState);
    } catch (error) {
      setStatus(error?.message || 'Older road evidence could not be loaded.');
    } finally {
      setMapMoreBusy(false);
    }
  }, [mapMoreBusy, mapTrips.length]);

  const syncRoadMemoryHistory = useCallback(async () => {
    if (memoryHistorySync.status === 'syncing') return;
    setMemoryHistorySync((current) => ({ ...current, status: 'syncing' }));
    try {
      const result = await backfillLocalRoadMemoryFromTripHistory();
      setMemoryHistorySync({
        status: 'ready',
        scannedTripCount: Number(result?.scannedTripCount) || 0,
        observationCount: Number(result?.observationCount) || 0,
      });
      await loadRows({ silent: true });
      if (mapModelActive) loadMapModel({ force: true });
    } catch (error) {
      setMemoryHistorySync((current) => ({ ...current, status: 'error' }));
      setStatus(error?.message || 'Stored trip history could not be scanned.');
      logSystemFailure('speed_limits_road_memory_history_backfill', error);
    }
  }, [loadMapModel, loadRows, mapModelActive, memoryHistorySync.status]);

  const loadFullGeometryHistory = useCallback(async () => {
    if (geometryIndexState.status === 'building') return;
    setGeometryIndexState((current) => ({ ...current, status: 'building' }));
    try {
      const index = await rebuildSpeedGeometryIndex();
      setGeometryIndexState({
        status: 'ready',
        indexedTripCount: Number(index?.indexedTripCount) || 0,
        totalAvailable: Number(index?.totalAvailable) || 0,
        truncated: index?.truncated === true,
      });
      setMapTrips((current) => {
        const byId = new Map((index?.trips || []).map((trip) => [String(trip?.id), trip]));
        current.forEach((trip) => byId.set(String(trip?.id), trip));
        return [...byId.values()];
      });
      const nextState = {
        ...mapModelStateRef.current,
        totalTripCount: Math.max(
          Number(mapModelStateRef.current.totalTripCount) || 0,
          Number(index?.totalAvailable) || 0
        ),
        nextOffset: Math.max(
          Number(mapModelStateRef.current.nextOffset) || 0,
          Number(index?.indexedTripCount) || 0
        ),
      };
      mapModelStateRef.current = nextState;
      setMapModelState(nextState);
    } catch (error) {
      setGeometryIndexState((current) => ({ ...current, status: 'error' }));
      setStatus(error?.message || 'Full road history could not be indexed.');
      logSystemFailure('speed_geometry_index_build', error);
    }
  }, [geometryIndexState.status]);

  const refreshRowsAndMap = useCallback(async ({ silent = false, forceMap = false } = {}) => {
    await loadRows({ silent });
    if (forceMap && (mapModelActive || mapModelStateRef.current.status !== 'idle')) {
      loadMapModel({ force: true });
    }
  }, [loadMapModel, loadRows, mapModelActive]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  useEffect(() => {
    let active = true;
    const refreshCameraReviewCount = async () => {
      await syncNativeSpeedSignEvidence().catch(() => null);
      const evidence = await listSpeedSignEvidence({ pendingOnly: false }).catch(() => []);
      if (active) setCameraReviewCount(Array.isArray(evidence) ? evidence.length : 0);
    };
    void refreshCameraReviewCount();
    const onEvidenceChanged = () => void refreshCameraReviewCount();
    window.addEventListener(SPEED_SIGN_EVIDENCE_CHANGED_EVENT, onEvidenceChanged);
    window.addEventListener('focus', onEvidenceChanged);
    return () => {
      active = false;
      window.removeEventListener(SPEED_SIGN_EVIDENCE_CHANGED_EVENT, onEvidenceChanged);
      window.removeEventListener('focus', onEvidenceChanged);
    };
  }, []);

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
      // The engine exclusion is persisted with speed knowledge; these keys only
      // keep the map presentation in sync across reloads.
    }
  }, [excludedSpeedSectionKeys]);

  useEffect(() => {
    if (!completeRawMapSections.length || !excludedSpeedSectionKeys.length) return undefined;
    const persistedKeys = new Set(persistedExcludedSpeedSections.flatMap(speedSectionExclusionKeys));
    const legacyKeys = new Set(excludedSpeedSectionKeys);
    const migrations = new Map();

    completeRawMapSections.forEach((section) => {
      const matchingKeys = speedSectionExclusionKeys(section).filter((key) => legacyKeys.has(key));
      if (!matchingKeys.length || matchingKeys.some((key) => persistedKeys.has(key))) return;
      const migrationKey = matchingKeys[0];
      if (!legacyExclusionMigrationRef.current.has(migrationKey)) {
        migrations.set(migrationKey, { section, matchingKeys });
      }
    });
    if (!migrations.size) return undefined;

    migrations.forEach((_entry, key) => legacyExclusionMigrationRef.current.add(key));
    let cancelled = false;
    void (async () => {
      const beforeKnowledge = await knowledge.exportData().catch(() => null);
      const migrated = [];
      for (const [key, entry] of migrations) {
        try {
          const result = await knowledge.excludeSpeedSection({
            ...entry.section,
            exclusionKeys: entry.matchingKeys,
          });
          if (result && typeof result === 'object' && result.exclusion) {
            migrated.push(result.exclusion);
          }
        } catch (error) {
          legacyExclusionMigrationRef.current.delete(key);
          logSystemFailure('legacy_speed_exclusion_migration', error, { exclusion_key: key });
        }
      }
      if (!cancelled && migrated.length) {
        setPersistedExcludedSpeedSections((current) => [...current, ...migrated]);
        const afterKnowledge = await knowledge.exportData().catch(() => null);
        if (beforeKnowledge && afterKnowledge) {
          const updatedTrips = await refreshTripsForLocalSpeedKnowledgeChanges(
            beforeKnowledge,
            afterKnowledge
          ).catch(() => null);
          if (!cancelled) {
            const queuedCount = Math.max(
              0,
              Number(/** @type {any} */ (updatedTrips)?.queuedTripCount) || 0
            );
            setStatus(
              `Migrated ${migrated.length} private/parking exclusion${migrated.length === 1 ? '' : 's'} into protected saved-speed storage.` +
              (updatedTrips
                ? ` Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'}${queuedCount ? `; ${queuedCount} more queued` : ''}.`
                : ' Matching trip history will refresh when the queue resumes.')
            );
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    completeRawMapSections,
    excludedSpeedSectionKeys,
    knowledge,
    persistedExcludedSpeedSections,
  ]);

  useEffect(() => {
    if (!mapModelActive || mapModelState.status !== 'loaded') return undefined;
    const cacheKey = buildSpeedMapModelCacheKey(mapTrips, currentMapRows, roadMemoryCandidates);
    const cachedSections = readSpeedMapModelCache(cacheKey);
    if (cachedSections) {
      setRawMapSections(cachedSections);
      setMapSectionBuildState({ status: 'ready', durationMs: 0, source: 'memory-cache' });
      return undefined;
    }

    const requestId = mapSectionBuildRequestRef.current + 1;
    mapSectionBuildRequestRef.current = requestId;
    const endMeasure = beginMeasure('SpeedLimits.buildMapModel', {
      tripCount: mapTrips.length,
      correctionCount: currentMapRows.length,
      roadMemoryCandidateCount: roadMemoryCandidates.length,
    });
    let cancelled = false;
    let settled = false;
    let cancelFallback = null;
    setMapSectionBuildState({ status: 'building', durationMs: null });

    const commitSections = (sections, durationMs, source) => {
      if (cancelled || settled || requestId !== mapSectionBuildRequestRef.current) return;
      settled = true;
      const safeSections = Array.isArray(sections) ? sections : [];
      writeSpeedMapModelCache(cacheKey, safeSections);
      setRawMapSections(safeSections);
      setMapSectionBuildState({ status: 'ready', durationMs, source });
      endMeasure({ outcome: 'success', sectionCount: safeSections.length, source, workerDurationMs: durationMs });
    };

    const buildOnMainThreadWhenIdle = () => {
      if (cancelled || settled) return;
      cancelFallback = scheduleIdleWork(() => {
        try {
          const startedAt = performance.now();
          const sections = buildSpeedMapSections(mapTrips, currentMapRows, roadMemoryCandidates);
          commitSections(
            sections,
            Math.round((performance.now() - startedAt) * 10) / 10,
            'idle-main-thread'
          );
        } catch (error) {
          if (cancelled || settled) return;
          settled = true;
          setMapSectionBuildState({ status: 'error', durationMs: null, error });
          endMeasure({ outcome: 'error', error: error?.message || String(error) });
        }
      });
    };

    if (typeof Worker === 'undefined') {
      buildOnMainThreadWhenIdle();
    } else {
      try {
        if (!mapModelWorkerRef.current) {
          mapModelWorkerRef.current = new Worker(
            new URL('../workers/speedMapModel.worker.js', import.meta.url),
            { type: 'module' }
          );
        }
        const worker = mapModelWorkerRef.current;
        const onMessage = (event) => {
          if (event.data?.requestId !== requestId || cancelled || settled) return;
          if (event.data?.error) {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            buildOnMainThreadWhenIdle();
            return;
          }
          commitSections(event.data?.sections, event.data?.durationMs, 'worker');
        };
        const onError = () => {
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          mapModelWorkerRef.current?.terminate();
          mapModelWorkerRef.current = null;
          buildOnMainThreadWhenIdle();
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.postMessage({
          requestId,
          trips: mapTrips,
          corrections: currentMapRows,
          roadMemoryCandidates,
        });
        return () => {
          cancelled = true;
          cancelFallback?.();
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          endMeasure({ outcome: 'cancelled' });
        };
      } catch {
        mapModelWorkerRef.current?.terminate();
        mapModelWorkerRef.current = null;
        buildOnMainThreadWhenIdle();
      }
    }

    return () => {
      cancelled = true;
      cancelFallback?.();
      endMeasure({ outcome: 'cancelled' });
    };
  }, [currentMapRows, mapModelActive, mapModelState.status, mapTrips, roadMemoryCandidates]);

  useEffect(() => () => {
    mapModelCancelRef.current?.();
    mapModelWorkerRef.current?.terminate();
    mapModelWorkerRef.current = null;
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
    const latestRow = rows.find((row) => (
      correctionKey(row) === selectedKey ||
      (!selectedKey && row.geohash === selectedSection.geohash)
    ));
    if (!latestRow) {
      setSelectedSection(null);
      setMapDraft(DEFAULT_MAP_DRAFT);
      selectedMapEditSnapshotRef.current = null;
      return;
    }

    const snapshot = selectedMapEditSnapshotRef.current;
    const editorIsPristine = snapshot?.key === selectedKey &&
      !selectedSection.pendingMerge &&
      !selectedSection.linkedGeometryEdits?.length &&
      sectionGeometryCompareKey(selectedSection) === snapshot.geometry &&
      normalizeMapDraftForCompare(mapDraft) === snapshot.draft;
    if (!editorIsPristine) return;

    const latestKnowledgeSection = knowledgeSections.find((section) => (
      correctionKey(section) === selectedKey ||
      (!selectedKey && section.geohash === selectedSection.geohash)
    ));
    const latestConflict = latestKnowledgeSection
      ? latestKnowledgeSection.conflict || null
      : selectedSection.conflict || null;
    const conflictChanged = speedConflictCompareKey(latestConflict) !==
      speedConflictCompareKey(selectedSection.conflict);

    const nextSection = {
      ...selectedSection,
      ...latestRow,
      saved: true,
      sectionPoints: Array.isArray(latestRow.sectionPoints) && latestRow.sectionPoints.length
        ? latestRow.sectionPoints
        : selectedSection.sectionPoints,
      conflict: latestConflict,
    };
    const nextDraft = mapDraftForSection(nextSection);
    const nextGeometry = sectionGeometryCompareKey(nextSection);
    const nextDraftKey = normalizeMapDraftForCompare(nextDraft);
    if (nextGeometry === snapshot.geometry && nextDraftKey === snapshot.draft && !conflictChanged) return;

    setSelectedSection(nextSection);
    setMapDraft(nextDraft);
    selectedMapEditSnapshotRef.current = {
      key: correctionKey(nextSection),
      saved: true,
      geometry: nextGeometry,
      draft: nextDraftKey,
    };
  }, [knowledgeSections, mapDraft, rows, selectedSection]);

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
    setDrafts((current) => {
      const nextDraft = {
        limitKmh: '',
        source: 'user_entered_estimate',
        note: '',
        roadName: '',
        ...(current[geohash] || {}),
        ...patch,
      };
      const baseline = persistedDraftBaselinesRef.current[geohash];
      if (baseline &&
        normalizeMapDraftForCompare(nextDraft) === normalizeMapDraftForCompare(baseline)) {
        dirtyDraftKeysRef.current.delete(geohash);
      } else {
        dirtyDraftKeysRef.current.add(geohash);
      }
      return { ...current, [geohash]: nextDraft };
    });
  };

  const saveRow = async (row) => {
    const key = correctionKey(row);
    const draft = drafts[key] || {};
    const limitKmh = Number(draft.limitKmh);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0 || limitKmh > MAX_SAVED_SPEED_LIMIT_KMH) {
      setStatus('Enter a valid speed limit before saving.');
      return;
    }
    if (invalidValidityWindow(draft)) {
      setStatus('Effective from must be earlier than Active until.');
      return;
    }
    if (invalidCustomDayRule(draft)) {
      setStatus('Choose at least one active day for this custom schedule.');
      return;
    }
    const qualifierError = qualifierDraftError(draft);
    if (qualifierError) {
      setStatus(qualifierError);
      return;
    }
    setBusyGeohash(key);
    const updatedCorrection = {
      ...row,
      limitKmh: Math.round(limitKmh),
      source: draft.source || row.source || 'user_entered_estimate',
      qualifierStatus: qualifierStatusForDraft({ ...row, ...draft }),
      note: draft.note,
      roadName: String(draft.roadName ?? row.roadName ?? '').trim(),
      directionMode: draft.directionMode || 'both',
      timeRule: timeRuleFromDraft(draft),
      ...validityFromDraft(draft),
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
        qualifierStatus: qualifierStatusForDraft({ ...row, ...draft }),
        directionMode: draft.directionMode || 'both',
        timeRule: timeRuleFromDraft(draft),
        ...validityFromDraft(draft),
        roadName: String(draft.roadName ?? row.roadName ?? '').trim(),
      }
    ).catch(() => false);
    if (saved) {
      dirtyDraftKeysRef.current.delete(key);
      const persistedDraft = draftForCorrection(updatedCorrection);
      persistedDraftBaselinesRef.current = {
        ...persistedDraftBaselinesRef.current,
        [key]: persistedDraft,
      };
      setDrafts((current) => ({
        ...current,
        [key]: persistedDraft,
      }));
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
      dirtyDraftKeysRef.current.delete(key);
      const nextBaselines = { ...persistedDraftBaselinesRef.current };
      delete nextBaselines[key];
      persistedDraftBaselinesRef.current = nextBaselines;
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
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
    if (invalidValidityWindow(draft)) {
      setStatus('Effective from must be earlier than Active until.');
      return;
    }
    if (invalidCustomDayRule(draft)) {
      setStatus('Choose at least one active day for this custom schedule.');
      return;
    }
    const qualifierError = qualifierDraftError({ ...row, ...draft });
    if (qualifierError) {
      setStatus(qualifierError);
      return;
    }
    const keepSaved = action === 'keep_saved';
    const nextLimitKmh = keepSaved
      ? Number(row.limitKmh)
      : Number(conflict.observedLimitKmh);
    if (!Number.isFinite(nextLimitKmh) || nextLimitKmh <= 0 || nextLimitKmh > MAX_SAVED_SPEED_LIMIT_KMH) {
      setStatus('Could not resolve this conflict because the speed value is missing.');
      return;
    }

    const nextCorrection = {
      ...row,
      limitKmh: Math.round(nextLimitKmh),
      // Accepting observed trip evidence is not the same as seeing a posted
      // sign. Preserve posted authority only when the user explicitly keeps
      // the already-confirmed saved value.
      source: keepSaved
        ? draft.source || row.source || 'user_entered_estimate'
        : 'user_entered_estimate',
      qualifierStatus: qualifierStatusForDraft({ ...row, ...draft }),
      note: draft.note ?? row.note ?? '',
      roadName: String(draft.roadName ?? row.roadName ?? '').trim(),
      directionMode: draft.directionMode || row.directionMode || 'both',
      timeRule: timeRuleFromDraft({ ...row, ...draft }),
      ...validityFromDraft(draft),
      sectionPoints: row.sectionPoints || [],
    };
    if (!hasTracedRoadGeometry(nextCorrection)) {
      setStatus('Trace at least two distinct points on the road map before resolving this speed conflict. Point-only rules cannot affect scores or alerts safely.');
      return;
    }
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const beforeTrips = [
      ...new Map([
        ...matchingTripsForCorrection(row),
        ...matchingTripsForCorrection(nextCorrection),
      ].map((trip) => [String(trip.id), trip])).values(),
    ];
    const key = correctionKey(row);
    setBusyGeohash(key);
    // Most visible conflicts compare a saved traced rule with completed-trip
    // evidence and have no coarse conflicted cell. Only ask the core to remove
    // a cell when that exact persisted conflict actually exists; otherwise the
    // saved conflictResolution marker is sufficient to keep the reviewed
    // decision from returning after reload.
    const persistedConflicts = await knowledge.getConflictedCells().catch(() => []);
    const exactConflictCell = persistedConflicts.find((cell) => (
      cell?.geohash && cell.geohash === String(conflict.geohash || row.geohash || '')
    ));
    const saved = await knowledge.updateUserCorrection(
      key,
      nextCorrection.limitKmh,
      nextCorrection.source,
      nextCorrection.note,
      {
        roadName: nextCorrection.roadName,
        sectionPoints: nextCorrection.sectionPoints,
        directionMode: nextCorrection.directionMode,
        qualifierStatus: nextCorrection.qualifierStatus,
        directionBearing: row.directionBearing,
        timeRule: nextCorrection.timeRule,
        validFrom: nextCorrection.validFrom,
        validFromDate: nextCorrection.validFromDate,
        expiresAt: nextCorrection.expiresAt,
        expiresAtDate: nextCorrection.expiresAtDate,
        ...(exactConflictCell ? { resolvesConflictGeohash: exactConflictCell.geohash } : {}),
        conflictResolution: {
          savedLimitKmh: conflict.savedLimitKmh,
          observedLimitKmh: conflict.observedLimitKmh,
          deltaKmh: conflict.deltaKmh,
          action: keepSaved ? 'kept_saved_limit' : 'used_observed_limit',
          note: keepSaved
            ? 'User kept the saved local road speed after reviewing the observed trip evidence.'
            : 'User replaced the saved local road speed with the reviewed observed trip evidence.',
        },
      }
    ).catch(() => false);

    if (!saved) {
      setBusyGeohash(null);
      setStatus('Could not resolve that speed conflict.');
      return;
    }

    dirtyDraftKeysRef.current.delete(key);
    const persistedDraft = draftForCorrection(nextCorrection);
    persistedDraftBaselinesRef.current = {
      ...persistedDraftBaselinesRef.current,
      [key]: persistedDraft,
    };
    setRows((current) => current.map((item) => (
      correctionKey(item) === key
        ? {
          ...item,
          ...nextCorrection,
          conflictResolution: {
            savedLimitKmh: conflict.savedLimitKmh,
            observedLimitKmh: conflict.observedLimitKmh,
            deltaKmh: conflict.deltaKmh,
            action: keepSaved ? 'kept_saved_limit' : 'used_observed_limit',
            resolvedAt: new Date().toISOString(),
          },
          appliedAt: new Date().toISOString(),
        }
        : item
    )));
    revealSavedRowsFilter(nextCorrection.source);
    revealSavedSpeedMapLayer(nextCorrection.source);
    setDrafts((current) => ({
      ...current,
      [key]: persistedDraft,
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
        conflictResolution: {
          savedLimitKmh: conflict.savedLimitKmh,
          observedLimitKmh: conflict.observedLimitKmh,
          deltaKmh: conflict.deltaKmh,
          action: keepSaved ? 'kept_saved_limit' : 'used_observed_limit',
          resolvedAt: new Date().toISOString(),
        },
      } : current);
      setMapDraft(nextDraft);
      setMapEditorSnapshot({ ...selectedSection, ...nextCorrection, conflict: null }, nextDraft);
    }
    setBusyGeohash(null);

    if (keepSaved) {
      setStatus(withUndo(`Conflict resolved: kept the saved ${formatSpeedLimit(nextLimitKmh, units)} rule for this road section. Matching trip scores are updating in the background.`));
      void (async () => {
        const afterKnowledge = await knowledge.exportData().catch(() => null);
        const updatedTrips = beforeKnowledge && afterKnowledge
          ? await withRecalculation(() => (
            refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
          ))
          : [];
        setStatus(withUndo(buildRecalculationStatus(
          updatedTrips
            ? `Conflict resolved: kept the saved ${formatSpeedLimit(nextLimitKmh, units)} rule and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
            : `Conflict resolved: kept the saved ${formatSpeedLimit(nextLimitKmh, units)} rule, but matching trips could not be recalculated right now.`,
          beforeTrips,
          updatedTrips
        )));
        await refreshRowsAndMap({ silent: true });
      })();
      return;
    }

    setStatus(withUndo(`Conflict resolved: updated this road section to ${formatSpeedLimit(nextLimitKmh, units)}. Matching trip scores are updating in the background.`));
    void (async () => {
      const afterKnowledge = await knowledge.exportData().catch(() => null);
      const updatedTrips = await withRecalculation(() => (
        beforeKnowledge && afterKnowledge
          ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
          : refreshTripsCrossingLocalSpeedCorrection(nextCorrection).catch(() => null)
      ));
      setStatus(withUndo(buildRecalculationStatus(
        updatedTrips
          ? `Conflict resolved: updated this road section to ${formatSpeedLimit(nextLimitKmh, units)} and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
          : `Conflict resolved: updated this road section to ${formatSpeedLimit(nextLimitKmh, units)}, but matching trips could not be recalculated right now.`,
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

  const restoreExcludedSpeedSections = async (selector = null) => {
    const restoreKey = selector
      ? `restore-excluded-${selector.id || selector.exclusionId || selector.geohash || 'section'}`
      : 'restore-excluded-sections';
    setBusyGeohash(restoreKey);
    const restored = await knowledge.restoreExcludedSpeedSections(selector).catch(() => null);
    if (!restored) {
      setBusyGeohash(null);
      setStatus('Could not allow learning on the parking/private sections right now.');
      return;
    }
    const remainingExclusions = await knowledge.listExcludedSpeedSections().catch(() => []);
    setPersistedExcludedSpeedSections(remainingExclusions);
    setExcludedSpeedSectionKeys([
      ...new Set(remainingExclusions.flatMap(speedSectionExclusionKeys)),
    ]);
    const replay = Number(restored.restoredCount) > 0
      ? await backfillLocalRoadMemoryFromTripHistory().catch((error) => ({ error }))
      : null;
    setBusyGeohash(null);
    await refreshRowsAndMap({ silent: true });
    const restoredCount = Number(restored.restoredCount) || 0;
    setStatus(restoredCount > 0
      ? `Allowed learning again on ${restoredCount} parking/private exclusion${restoredCount === 1 ? '' : 's'}. ` + (
        replay?.error
          ? 'The history replay could not finish; new drives can still rebuild evidence safely.'
          : `Scanned ${Number(replay?.scannedTripCount) || 0} eligible historical trip${Number(replay?.scannedTripCount) === 1 ? '' : 's'}${replay?.truncated ? ` of ${Number(replay.totalAvailable) || 'more'} available (older trips were not scanned)` : ''}. Saved speeds return only when the evidence earns them again.`
      )
      : 'There were no parking/private learning exclusions to restore.');
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
        ? 'Persistently block learning, matching, scores, and alerts here, and remove all related saved-speed knowledge?'
        : 'Persistently block learning, matching, scores, alerts, and future speed-review prompts on this section?',
      confirmLabel: 'Mark section',
    });
    if (!confirmed) return;

    const selectedKey = correctionKey(selectedSection);
    setBusyGeohash(selectedKey);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const beforeTrips = matchingTripsForCorrection(selectedSection);
    const excluded = await knowledge.excludeSpeedSection({
      ...selectedSection,
      exclusionKeys: keys,
    }).catch(() => false);
    if (!excluded || typeof excluded !== 'object') {
      setBusyGeohash(null);
      setStatus('Could not persist this parking/private exclusion. No saved-speed data was changed.');
      return;
    }

    addExcludedSpeedSection(selectedSection);
    setPersistedExcludedSpeedSections((current) => [
      ...current.filter((item) => !speedSectionExclusionKeys(item).some((key) => keys.includes(key))),
      excluded.exclusion,
    ]);
    setIgnoredUnsetSectionKeys((current) => {
      const unsetKey = ignoredUnsetSectionKey(selectedSection);
      return unsetKey && !current.includes(unsetKey) ? [...current, unsetKey] : current;
    });
    if (selectedSection.saved) removeSavedRowsFromView([selectedSection]);
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
    const removedCount = Number(excluded.correctionsRemoved || 0) +
      Number(excluded.roadMemoryCandidatesRemoved || 0) +
      Number(excluded.cellsRemoved || 0);
    setStatus(buildRecalculationStatus(
      updatedTrips
        ? `Persistently excluded this parking/private section from learning, speed matching, scores, and alerts; removed ${removedCount} related knowledge record${removedCount === 1 ? '' : 's'} and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
        : `Persistently excluded this parking/private section and removed ${removedCount} related knowledge record${removedCount === 1 ? '' : 's'}, but matching trips could not be recalculated right now.`,
      beforeTrips,
      updatedTrips
    ));
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
          validFrom: row.validFrom || null,
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
    switchWorkspace('map');
    setMapLayers((current) => ({
      ...current,
      conflicts: true,
      saved: true,
      learned: true,
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
      : item.kind === 'speedZone'
        ? `Trip speed zone ${item.zoneIndex} of ${item.zoneCount} selected. Save, adjust, or confirm this ${formatSpeedLimit(item.limitKmh, units)} segment independently.`
      : item.kind === 'review'
        ? `${speedSectionAttentionLabel(item.section)} selected. Review the saved speed, source, timing, and traced road line before updating.`
      : item.kind === 'learning'
        ? 'Learning corridor selected. No action is required; this view shows the GPS line and current local estimate.'
      : 'Road section selected. Enter a posted sign or local estimate, then save.');
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
    if (selectedSection.saved && invalidValidityWindow(mapDraft)) {
      setStatus('Effective from must be earlier than Active until before saving snapped geometry.');
      return;
    }
    if (selectedSection.saved && invalidCustomDayRule(mapDraft)) {
      setStatus('Choose at least one active day before saving snapped geometry.');
      return;
    }
    if (selectedSection.saved && qualifierDraftError(mapDraft)) {
      setStatus(`${qualifierDraftError(mapDraft)} Fix it before saving snapped geometry.`);
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
    if (!Number.isFinite(limitKmh) || limitKmh <= 0 || limitKmh > MAX_SAVED_SPEED_LIMIT_KMH) {
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
        qualifierStatus: qualifierStatusForDraft(mapDraft),
        directionBearing: snappedSection.directionBearing,
        timeRule: timeRuleFromDraft(mapDraft),
        ...validityFromDraft(mapDraft),
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
      qualifierStatus: qualifierStatusForDraft(mapDraft),
      timeRule: timeRuleFromDraft(mapDraft),
      ...validityFromDraft(mapDraft),
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
    if (!Number.isFinite(limitKmh) || limitKmh <= 0 || limitKmh > MAX_SAVED_SPEED_LIMIT_KMH) {
      setStatus('Enter a valid speed limit before saving.');
      return;
    }
    if (invalidValidityWindow(mapDraft)) {
      setStatus('Effective from must be earlier than Active until.');
      return;
    }
    if (invalidCustomDayRule(mapDraft)) {
      setStatus('Choose at least one active day for this custom schedule.');
      return;
    }
    const qualifierError = qualifierDraftError(mapDraft);
    if (qualifierError) {
      setStatus(qualifierError);
      return;
    }
    if (!selectedSection.saved && selectedSection.sectionPoints?.length < 2) {
      setStatus('Tap at least two points along the road so Road Sage can save a real road section.');
      return;
    }
    if (blockingOverlapChecks.length > 0) {
      const overlap = blockingOverlapChecks[0];
      setStatus(`Cannot save this road speed because it overlaps ${overlap.roadName || 'another saved section'} at ${formatSpeedLimit(overlap.limitKmh, units)}. Edit, split, merge, or add a distinct direction/time rule first.`);
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
    const validity = validityFromDraft(mapDraft);
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
          qualifierStatus: qualifierStatusForDraft(mapDraft),
          directionBearing: selectedSection.directionBearing,
          timeRule: timeRuleFromDraft(mapDraft),
          ...validity,
          historyGroup,
        }
      ).catch(() => false)
      : await knowledge.saveUserCorrection(
        selectedSection.lat,
        selectedSection.lng,
        Math.round(limitKmh),
        mapDraft.note,
        validity.expiresAt,
        privacyZones,
        mapDraft.source,
        {
          roadName: mapDraft.roadName || selectedSection.roadName || '',
          contextLabel: 'Selected from the saved road speed map',
          directionLabel: directionLabel(mapDraft.directionMode),
          directionMode: mapDraft.directionMode || 'both',
          qualifierStatus: qualifierStatusForDraft(mapDraft),
          directionBearing: selectedSection.directionBearing,
          timeRule: timeRuleFromDraft(mapDraft),
          ...validity,
          sectionPoints: selectedSection.sectionPoints || [selectedSection],
          provenance: selectedSection.roadMemoryCandidate
            ? 'road_memory_map_edit'
            : 'saved_speed_map',
          roadMemoryCandidateId: selectedSection.roadMemoryCandidate
            ? selectedSection.id || selectedSection.candidateId || selectedSection.sectionKey
            : null,
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
            validFrom: edit.validFrom,
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
        qualifierStatus: qualifierStatusForDraft(mapDraft),
        timeRule: timeRuleFromDraft(mapDraft),
        ...validity,
      };
      const linkedGeometryLabel = linkedGeometryEdits.length ? ' and updated the linked split half' : '';
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
      setStatus(withUndo(`Saved ${formatSpeedLimit(limitKmh, units)} for this road section${linkedGeometryLabel}. Matching trip scores are updating in the background.`));
      void (async () => {
        const afterKnowledge = await knowledge.exportData().catch(() => null);
        const updatedTrips = await withRecalculation(() => (
          beforeKnowledge && afterKnowledge
            ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
            : refreshTripsCrossingLocalSpeedCorrection(correction).catch(() => null)
        ));
        setStatus(withUndo(buildRecalculationStatus(
          updatedTrips
            ? `Saved ${formatSpeedLimit(limitKmh, units)} for this road section${linkedGeometryLabel}. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
            : `Saved ${formatSpeedLimit(limitKmh, units)} for this road section${linkedGeometryLabel}, but matching trips could not be recalculated right now.`,
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
    if (invalidValidityWindow(mapDraft)) {
      setStatus('Effective from must be earlier than Active until before trimming this section.');
      return;
    }
    if (invalidCustomDayRule(mapDraft)) {
      setStatus('Choose at least one active day before trimming this section.');
      return;
    }
    const qualifierError = qualifierDraftError(mapDraft);
    if (qualifierError) {
      setStatus(`${qualifierError} Fix it before trimming this section.`);
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
    if (!midpoint || !Number.isFinite(limitKmh) || limitKmh <= 0 || limitKmh > MAX_SAVED_SPEED_LIMIT_KMH) {
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
      qualifierStatus: qualifierStatusForDraft(mapDraft),
      timeRule: timeRuleFromDraft(mapDraft),
      ...validityFromDraft(mapDraft),
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
        qualifierStatus: updatedSection.qualifierStatus,
        directionBearing: selectedSection.directionBearing,
        timeRule: updatedSection.timeRule,
        validFrom: updatedSection.validFrom,
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
    if (invalidValidityWindow(mapDraft)) {
      setStatus('Effective from must be earlier than Active until before splitting this section.');
      return;
    }
    if (invalidCustomDayRule(mapDraft)) {
      setStatus('Choose at least one active day before splitting this section.');
      return;
    }
    const qualifierError = qualifierDraftError(mapDraft);
    if (qualifierError) {
      setStatus(`${qualifierError} Fix it before splitting this section.`);
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
      qualifierStatus: qualifierStatusForDraft(mapDraft),
      timeRule: timeRuleFromDraft(mapDraft),
      ...validityFromDraft(mapDraft),
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
    const { validFrom, validFromDate, expiresAt, expiresAtDate } = validityFromDraft(mapDraft);
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
        validFrom,
        validFromDate,
        expiresAt,
        expiresAtDate,
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
    dirtyDraftKeysRef.current.clear();
    persistedDraftBaselinesRef.current = {};
    setDrafts({});
    setSelectedSection(null);
    setMapDraft(DEFAULT_MAP_DRAFT);
    setMapEditorSnapshot(null);
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
        local_road_memory: true,
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
    await refreshRowsAndMap({ forceMap: mapModelActive });
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
      const hydratedPrivacyZones = await getHydratedPrivacyZones();
      if (!Array.isArray(hydratedPrivacyZones)) {
        throw new Error('Road Sage could not securely load your privacy zones, so no speed rules were restored.');
      }
      const warnings = [];
      const sanitized = sanitizeSpeedKnowledge(data, hydratedPrivacyZones, warnings);
      if (
        !sanitized ||
        typeof sanitized.cells !== 'object' ||
        !Array.isArray(sanitized.corrections) ||
        !Array.isArray(sanitized.excludedSections)
      ) {
        throw new Error('Unsafe speed-rule backup');
      }
      const beforeKnowledge = await knowledge.exportData();
      const restored = await knowledge.replaceData(sanitized, 'restore_speed_backup');
      if (!restored) throw new Error('Speed-rule restore did not commit');
      dirtyDraftKeysRef.current.clear();
      persistedDraftBaselinesRef.current = {};
      setDrafts({});
      setSelectedSection(null);
      setMapDraft(DEFAULT_MAP_DRAFT);
      setMapEditorSnapshot(null);
      const afterKnowledge = await knowledge.exportData();
      const updatedTrips = await withRecalculation(() => (
        refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
      ));
      const importedLearnedCount = Object.values(sanitized.cells || {}).filter((cell) => (
        cell?.importTrustState === 'shadow_relearning'
      )).length +
        (sanitized.roadMemory?.candidates?.length || 0);
      const relearningNotice = importedLearnedCount
        ? ` ${importedLearnedCount} imported learned corridor${importedLearnedCount === 1 ? ' was' : 's were'} reset to shadow/relearning and cannot affect scores or alerts until fresh local evidence revalidates ${importedLearnedCount === 1 ? 'it' : 'them'}.`
        : '';
      const postedReconfirmationCount = sanitized.corrections.filter((correction) => (
        correction?.importTrustState === 'posted_reconfirmation_required'
      )).length;
      const postedReconfirmationNotice = postedReconfirmationCount
        ? ` ${postedReconfirmationCount} imported posted-sign rule${postedReconfirmationCount === 1 ? ' was' : 's were'} downgraded to an estimate; confirm ${postedReconfirmationCount === 1 ? 'it' : 'them'} while parked before posted-sign authority is restored.`
        : '';
      setStatus(withUndo(updatedTrips
        ? `Safely restored ${sanitized.corrections.length} saved road-speed rule${sanitized.corrections.length === 1 ? '' : 's'} and ${sanitized.excludedSections.length} persistent exclusion${sanitized.excludedSections.length === 1 ? '' : 's'}; recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.${relearningNotice}${postedReconfirmationNotice}${warnings.length ? ` ${warnings.length} unsafe or private record${warnings.length === 1 ? ' was' : 's were'} skipped.` : ''}`
        : `Safely restored ${sanitized.corrections.length} saved road-speed rule${sanitized.corrections.length === 1 ? '' : 's'} and ${sanitized.excludedSections.length} persistent exclusion${sanitized.excludedSections.length === 1 ? '' : 's'}, but affected trips could not be recalculated right now.${relearningNotice}${postedReconfirmationNotice}${warnings.length ? ` ${warnings.length} unsafe or private record${warnings.length === 1 ? ' was' : 's were'} skipped.` : ''}`));
      await refreshRowsAndMap();
    } catch (error) {
      setStatus(error?.message?.startsWith('Road Sage could not securely load your privacy zones')
        ? error.message
        : 'Could not restore that file. Choose a Road Sage speed-rule or full-backup JSON file.');
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
      const selectableRows = visibleRows.filter((row) => row.historicalVersion !== true);
      const allSelected = selectableRows.length > 0 && selectableRows.every((row) => next.has(correctionKey(row)));
      selectableRows.forEach((row) => {
        const key = correctionKey(row);
        if (allSelected) next.delete(key);
        else next.add(key);
      });
      return next;
    });
  };

  const confirmSelectedAsPosted = async () => {
    const selected = rows.filter((row) => (
      row.historicalVersion !== true && selectedRows.has(correctionKey(row))
    ));
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
    const selected = rows.filter((row) => (
      row.historicalVersion !== true && selectedRows.has(correctionKey(row))
    ));
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
      ? `Removed expired temporary rules and learned evidence older than 180 days while preserving historical speed versions. Recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.`
      : 'Removed expired temporary rules and old learned evidence while preserving historical speed versions, but affected trips could not be recalculated right now.'));
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
              {activeManualRows.length + operationalMemoryCount} active
            </span>
            {historicalRuleCount > 0 && (
              <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-800 dark:bg-violet-950/40 dark:text-violet-200">
                {historicalRuleCount} historical version{historicalRuleCount === 1 ? '' : 's'} retained
              </span>
            )}
            {scheduledOrExpiredRuleCount > 0 && (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-900 dark:text-slate-200">
                {scheduledOrExpiredRuleCount} scheduled or expired
              </span>
            )}
            <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
              Road Memory v2 · calibrated locally
            </span>
            <InlineRefreshBadge visible={refreshing} label="Refreshing saved speeds" />
            <InlineRefreshBadge
              visible={memoryHistorySync.status === 'syncing'}
              label="Learning from existing trips"
            />
            <InlineRefreshBadge visible={workspacePending} label="Opening workspace" />
            <InlineRefreshBadge visible={mapModelLoading} label="Loading map model" />
            <InlineRefreshBadge
              visible={mapSectionBuildState.status === 'building'}
              label="Building road lines in background"
            />
            <InlineRefreshBadge visible={recalculationBusy} label="Updating trip scores" />
            <InlineRefreshBadge visible={mapQueryPending} label="Updating map filter" />
            <InlineRefreshBadge visible={isRowQueryPending} label="Updating saved speed rows" />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Existing and new trips build private corridor suggestions automatically. New estimates stay in shadow mode until parked decisions prove the model reliable; confirmed posted limits remain authoritative.
          </p>
          {memoryHistorySync.status === 'ready' && memoryHistorySync.scannedTripCount > 0 && (
            <p className="mt-1 text-xs font-medium text-sky-700 dark:text-sky-300">
              Checked {memoryHistorySync.scannedTripCount} stored trip{memoryHistorySync.scannedTripCount === 1 ? '' : 's'}
              {memoryHistorySync.observationCount > 0
                ? ` and learned ${memoryHistorySync.observationCount} road observation${memoryHistorySync.observationCount === 1 ? '' : 's'}.`
                : '; no new usable public road observations were found.'}
            </p>
          )}
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
            onClick={syncRoadMemoryHistory}
            disabled={memoryHistorySync.status === 'syncing'}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
            title="Scan stored trips only when you ask; new completed trips are learned automatically"
          >
            <Gauge className="h-3.5 w-3.5" />
            {memoryHistorySync.status === 'syncing' ? 'Scanning history…' : 'Scan trip history'}
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

      {nativeMirrorHealth.state !== 'not_applicable' && (
        <section
          data-testid="native-speed-mirror-status"
          data-state={nativeMirrorHealth.state}
          className={`flex flex-col gap-2 rounded-xl border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between ${
            nativeMirrorHealth.state === 'synced'
              ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/20'
              : nativeMirrorHealth.state === 'error'
                ? 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/20'
                : 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/20'
          }`}
          aria-live="polite"
        >
          <div className="flex items-start gap-2">
            {nativeMirrorHealth.state === 'synced'
              ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" />
              : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />}
            <div>
              <div className="text-xs font-semibold">
                {nativeMirrorHealth.state === 'synced'
                  ? 'Background Android speed alerts are synchronized'
                  : nativeMirrorHealth.state === 'privacy_blocked'
                    ? 'Background saved-speed alerts are privacy-paused'
                    : nativeMirrorHealth.state === 'error'
                      ? 'Background Android speed alerts need a sync retry'
                      : 'Checking the background Android speed copy'}
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {nativeMirrorHealth.state === 'synced'
                  ? `Only eligible, privacy-safe rules are mirrored in an encrypted device copy${nativeMirrorHealth.syncedAt ? `; last synced ${new Date(nativeMirrorHealth.syncedAt).toLocaleTimeString()}` : ''}.`
                  : nativeMirrorHealth.state === 'privacy_blocked'
                    ? 'The encrypted location-bearing native copy was replaced with an encrypted empty copy because privacy zones could not be verified. In-app rules remain intact.'
                    : nativeMirrorHealth.state === 'error'
                      ? (nativeMirrorHealth.error || 'The native service may not have the latest saved-road rules yet.')
                      : 'Road Sage is reconciling the versioned in-app store with the native background service.'}
              </p>
            </div>
          </div>
          {nativeMirrorHealth.state !== 'synced' && (
            <button
              type="button"
              onClick={retryNativeMirror}
              disabled={nativeMirrorRetrying}
              className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-current/20 bg-background px-3 text-xs font-semibold disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${nativeMirrorRetrying ? 'animate-spin' : ''}`} />
              {nativeMirrorRetrying ? 'Retrying' : 'Retry background sync'}
            </button>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-emerald-300 bg-emerald-50/80 p-4 shadow-sm dark:border-emerald-900/60 dark:bg-emerald-950/20" aria-label="Smart Speed protection status">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Smart Speed · authority status</div>
            <h2 className="mt-1 font-grotesk text-lg font-bold">Confirmed posted speeds are protected</h2>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              A confirmed traced corridor always wins over Road Memory. Matching learned suggestions are suppressed before they can appear, score a trip, or drive an alert.
            </p>
          </div>
          <span className="w-fit rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white">Protection active</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:max-w-md">
          <div className="rounded-xl bg-background/80 px-3 py-2">
            <div className="text-[10px] font-bold uppercase text-muted-foreground">Confirmed corridors</div>
            <div className="mt-1 text-xl font-bold">{smartProtection.confirmedCorridorCount}</div>
          </div>
          <div className="rounded-xl bg-background/80 px-3 py-2">
            <div className="text-[10px] font-bold uppercase text-muted-foreground">Suggestions blocked</div>
            <div className="mt-1 text-xl font-bold">{smartProtection.suppressedSuggestionCount}</div>
          </div>
        </div>
      </section>

      <RoadSpeedCommandCenter
        cameraCount={cameraReviewCount}
        estimatedCount={estimatedRuleCount}
        learningCount={learningMemoryCandidates.length}
        mapStatus={mapModelState.status}
        postedCount={postedRuleCount}
        reviewCount={mapModelLoaded
          ? attentionItems.length
          : savedRowsNeedingReviewCount + memoryChangeReviewCount + staleMemoryCount}
        savedCount={activeManualRows.length + operationalMemoryCount}
        onAdd={() => {
          switchWorkspace('map');
          void startAddingSection();
        }}
        onOpenMap={() => switchWorkspace('map')}
        onOpenReview={() => {
          switchWorkspace('review');
          window.setTimeout(() => {
            reviewWorkspaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 120);
        }}
        onOpenSaved={() => switchWorkspace('saved')}
      />
      <SpeedRescoreStatus />

      <section className="rounded-2xl border border-indigo-200 bg-indigo-50/70 px-4 py-3 text-xs dark:border-indigo-900/60 dark:bg-indigo-950/20" aria-label="Private road corridor intelligence">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-semibold text-indigo-950 dark:text-indigo-100">Private corridor intelligence</div>
            <p className="mt-1 leading-relaxed text-indigo-900/80 dark:text-indigo-200/80">
              Built only from your saved and driven GPS geometry. It protects nearby parallel roads, detects speed boundaries at junctions, and collapses repeated evidence before drawing.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 font-semibold">
            <span className="rounded-full bg-background px-2 py-1">{corridorGraphSummary.corridors} corridors</span>
            <span className="rounded-full bg-background px-2 py-1">{corridorGraphSummary.boundaries} boundary edges</span>
            <span className="rounded-full bg-background px-2 py-1">{corridorGraphSummary.parallelProtected} parallel protected</span>
            <span className="rounded-full bg-background px-2 py-1">{corridorGraphSummary.duplicateEvidence} duplicates hidden</span>
          </div>
        </div>
      </section>

      <RoadMemoryIntelligencePanel
        candidates={roadMemoryCandidates}
        onChanged={() => refreshRowsAndMap({ silent: true, forceMap: true })}
        onFocus={(candidate) => focusAttentionItem({
          kind: 'learning',
          section: {
            ...candidate,
            roadMemoryCandidate: true,
            source: 'local_road_memory',
            effectiveLimitKmh: Number(candidate.limitKmh) || null,
          },
        })}
      />

      <nav className="grid grid-cols-3 gap-1 rounded-2xl border border-border bg-card p-1.5 shadow-sm" aria-label="Saved road speed workspace">
        {SPEED_WORKSPACES.map(({ value, label, Icon }) => {
          const active = activeWorkspace === value;
          const count = value === 'review'
            ? cameraReviewCount + (
                mapModelLoaded
                  ? attentionItems.length
                  : savedRowsNeedingReviewCount + memoryChangeReviewCount + staleMemoryCount
              )
            : value === 'saved'
              ? rows.length + operationalMemoryCount
              : mapStats.total;
          return (
            <button
              key={value}
              type="button"
              onClick={() => switchWorkspace(value)}
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

      {mapModelActive && mapModelState.status === 'loaded' && (
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="font-semibold text-foreground">
              {geometryIndexState.status === 'building'
                ? 'Indexing older road geometry without blocking the page'
                : geometryIndexState.status === 'ready'
                  ? 'Full local road geometry index loaded'
                  : 'Recent road evidence loaded without blocking the page'}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {mapTrips.length} compact trip route{mapTrips.length === 1 ? '' : 's'} loaded
              {Number(mapModelState.totalTripCount) > 0
                ? ` from ${Number(mapModelState.totalTripCount)} available`
                : ''}
              {mapSectionBuildState.status === 'ready' && Number(mapSectionBuildState.durationMs) > 0
                ? ` · road lines built in ${Math.round(Number(mapSectionBuildState.durationMs))} ms`
                : ''}
            </div>
          </div>
          {geometryIndexState.status !== 'building' &&
            geometryIndexState.status !== 'ready' &&
            Number(mapModelState.nextOffset) < Number(mapModelState.totalTripCount) && (
            <button
              type="button"
              onClick={loadMoreMapTrips}
              disabled={mapMoreBusy || mapSectionBuildState.status === 'building'}
              className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 font-semibold hover:bg-secondary disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {mapMoreBusy ? 'Loading older roads…' : `Load ${SPEED_MAP_TRIP_BATCH_SIZE} older trips`}
            </button>
          )}
          {geometryIndexState.status !== 'building' &&
            Number(mapTrips.length) < Number(mapModelState.totalTripCount) && (
            <button
              type="button"
              onClick={loadFullGeometryHistory}
              disabled={mapMoreBusy || mapSectionBuildState.status === 'building'}
              className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 font-semibold hover:bg-secondary disabled:opacity-50"
              title="Explicitly load and index all stored trip routes; this no longer runs during normal page loading"
            >
              <MapIcon className="h-3.5 w-3.5" />
              Load full road history
            </button>
          )}
        </section>
      )}

      {activeWorkspace === 'review' && (
        <div ref={reviewWorkspaceRef} className="scroll-mt-24 space-y-4">
          <SpeedSignEvidenceReview
            showAll
            showEmpty
            onCountChange={setCameraReviewCount}
          />
          <RoadMemoryChangeReview
            candidates={roadMemoryCandidates}
            onChanged={() => refreshRowsAndMap({ silent: true, forceMap: true })}
            onFocus={(candidate) => focusAttentionItem({
              kind: 'memoryReview',
              section: {
                ...candidate,
                roadMemoryCandidate: true,
                source: 'local_road_memory',
                effectiveLimitKmh: Number(candidate.limitKmh) || null,
              },
            })}
          />
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
      <section className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 shadow-sm dark:border-sky-900/60 dark:bg-sky-950/20">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-sky-600" />
              <h2 className="font-grotesk text-lg font-bold">Learning automatically</h2>
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800 dark:bg-sky-950/50 dark:text-sky-200">
                {learningMemoryCandidates.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              These corridors came from your own GPS trips. Driving behavior can suggest where a limit may be, but it cannot prove a posted law. Strong suggestions are tested in shadow mode against parked decisions before they can affect scores, voice checks, or live alerts.
            </p>
          </div>
          <span className="rounded-full bg-background/80 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
            No action required
          </span>
        </div>
        {learningMemoryCandidates.length === 0 ? (
          <div className="mt-3 rounded-xl border border-sky-200/80 bg-background/70 px-3 py-3 text-sm text-muted-foreground dark:border-sky-900/50">
            No corridors are currently in the learning stage. Complete a normal public-road trip and Road Memory will check it automatically.
          </div>
        ) : (
          <div
            ref={learningInventoryRef}
            className="mt-3 overflow-y-auto rounded-xl border border-sky-200 bg-background/80 thin-scrollbar dark:border-sky-900/60"
            style={{ height: `${Math.min(learningMemoryCandidates.length, 6) * 76}px` }}
            aria-label="Road Memory learning progress"
          >
            <div
              className="relative w-full"
              style={{ height: `${learningInventoryVirtualizer.getTotalSize()}px` }}
            >
              {learningInventoryVirtualizer.getVirtualItems().map((virtualItem) => {
                const candidate = learningMemoryCandidates[virtualItem.index];
                if (!candidate) return null;
                const tripCount = Math.max(0, Number(candidate.tripCount) || 0);
                const confidence = Math.max(0, Math.min(1, Number(candidate.confidence) || 0));
                const progress = Math.max(8, Math.min(100, tripCount / 3 * 100));
                const section = {
                  ...candidate,
                  saved: false,
                  roadMemoryCandidate: true,
                  source: 'local_road_memory',
                  observedLimitKmh: Number(candidate.limitKmh) || null,
                  effectiveLimitKmh: Number(candidate.limitKmh) || null,
                };
                return (
                  <button
                    key={candidate.id || candidate.sectionKey || virtualItem.index}
                    type="button"
                    onClick={() => focusAttentionItem({ kind: 'learning', section })}
                    className="absolute left-0 top-0 w-full border-b border-sky-100 px-3 py-2 text-left hover:bg-sky-100/60 dark:border-sky-900/40 dark:hover:bg-sky-950/40"
                    style={{
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">
                          {candidate.roadName || `Local corridor ${String(candidate.geohash || '').slice(0, 6)}`}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          Exploring {formatSpeedLimit(candidate.limitKmh, units)} · {tripCount} drive{tripCount === 1 ? '' : 's'} · {Math.round(confidence * 100)}% calibrated confidence
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-sky-100 px-2 py-1 text-[11px] font-semibold text-sky-800 dark:bg-sky-950/50 dark:text-sky-200">
                        {candidate.usageStage === 'shadow' ? 'Shadow check' : candidate.stage === 'suggested' ? 'Almost ready' : 'Learning'}
                      </span>
                    </span>
                    <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-sky-100 dark:bg-sky-950/70">
                      <span className="block h-full rounded-full bg-sky-500" style={{ width: `${progress}%` }} />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>
      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <h2 className="font-grotesk text-lg font-bold">All road knowledge</h2>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                {reviewInventory.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              One inventory for saved posted limits, estimates, active Road Memory, learning corridors, possible changes, and stale evidence. Each status says whether it can currently affect scores and alerts.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
            <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
              {rows.length} manual
            </span>
            <span className="rounded-full bg-sky-100 px-2 py-1 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
              {roadMemoryCandidates.length} Road Memory
            </span>
          </div>
        </div>
        <label className="relative mt-3 block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={knowledgeQuery}
            onChange={(event) => setKnowledgeQuery(event.target.value)}
            placeholder="Search every saved, active, or learning road..."
            className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-xs outline-none focus:border-primary"
          />
        </label>
        {reviewInventory.length === 0 ? (
          <div className="mt-3 rounded-xl border border-border bg-secondary/30 px-3 py-3 text-sm text-muted-foreground">
            {knowledgeQuery ? 'No road knowledge matches this search.' : 'No road knowledge exists yet.'}
          </div>
        ) : (
          <div
            ref={reviewInventoryRef}
            className="mt-3 overflow-y-auto rounded-xl border border-border bg-background/60 thin-scrollbar"
            style={{ height: `${Math.min(reviewInventory.length, 7) * 68}px` }}
            aria-label="Complete local road knowledge inventory"
          >
            <div
              className="relative w-full"
              style={{ height: `${reviewInventoryVirtualizer.getTotalSize()}px` }}
            >
              {reviewInventoryVirtualizer.getVirtualItems().map((virtualItem) => {
                const item = reviewInventory[virtualItem.index];
                if (!item) return null;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => focusAttentionItem({ kind: item.focusKind, section: item.section })}
                    className="absolute left-0 top-0 flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left hover:bg-secondary/60"
                    style={{
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{item.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                      item.tone === 'violet'
                        ? 'bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200'
                        : item.tone === 'amber'
                          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100'
                          : item.tone === 'slate'
                            ? 'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-100'
                            : item.tone === 'cyan'
                              ? 'bg-cyan-100 text-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200'
                              : item.tone === 'sky'
                                ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                                : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                    }`}>
                      {item.badge}
                    </span>
                    <span className="text-[10px] font-semibold text-muted-foreground">
                      Score + alerts {item.intelligence.canAffectScore ? 'active' : 'blocked'}
                    </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
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
              Only real conflicts, stale trusted evidence, confirmed trip zones, and saved rules with quality problems appear here. Ordinary learning roads do not require your input.
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
            No road-speed decisions need your attention right now. Automatic learning can continue by itself.
          </div>
        ) : (
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {visibleAttentionItems.map((item) => (
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
                        : item.kind === 'memoryReview'
                          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                        : item.kind === 'speedZone'
                          ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100'
                        : item.kind === 'review'
                          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                        : 'bg-secondary text-muted-foreground'
                  }`}>
                    {item.kind === 'conflict' ? 'Resolve' : item.kind === 'voice' ? 'Voice' : item.kind === 'speedZone' ? 'Zone' : item.kind === 'memoryReview' ? 'Review' : item.kind === 'review' ? 'Review' : 'Set'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
        {attentionItems.length > 24 && (
          <button
            type="button"
            onClick={() => setShowAllAttention((value) => !value)}
            className="mt-3 inline-flex items-center justify-center rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold hover:bg-secondary"
          >
            {showAllAttention
              ? 'Show highest-priority items only'
              : `Show all ${attentionItems.length} attention items`}
          </button>
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
        </div>
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
              Only posted signs you confirmed are solid. Saved estimates, Road Memory, and temporary trip evidence stay dashed; red sections disagree with a saved rule.
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
                <details className="relative">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary [&::-webkit-details-marker]:hidden">
                    <Undo2 className="h-3.5 w-3.5" />
                    Manage exclusions {excludedSpeedSectionCount}
                  </summary>
                  <div className="absolute right-0 z-30 mt-2 w-80 space-y-2 rounded-xl border border-border bg-card p-3 shadow-xl">
                    <p className="text-[11px] text-muted-foreground">These sections cannot be learned, matched, scored, or used for alerts.</p>
                    {persistedExcludedSpeedSections.map((exclusion) => {
                      const restoreId = exclusion.id || exclusion.exclusionId || exclusion.geohash;
                      return (
                        <div key={restoreId} className="flex items-center justify-between gap-2 rounded-lg bg-secondary/60 px-2.5 py-2">
                          <span className="min-w-0 truncate text-xs font-semibold">
                            {exclusion.roadName || `Private section ${String(exclusion.geohash || '').slice(0, 6)}`}
                          </span>
                          <button
                            type="button"
                            onClick={() => restoreExcludedSpeedSections(exclusion)}
                            disabled={String(busyGeohash || '').startsWith('restore-excluded-')}
                            className="shrink-0 rounded-lg border border-border bg-background px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
                          >
                            Allow
                          </button>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => restoreExcludedSpeedSections()}
                      disabled={String(busyGeohash || '').startsWith('restore-excluded-')}
                      className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs font-semibold disabled:opacity-50"
                    >
                      Allow learning on all {excludedSpeedSectionCount}
                    </button>
                  </div>
                </details>
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
              <span><span className="mr-1 inline-block h-2.5 w-5 rounded border-2 border-dashed border-sky-500 bg-sky-100" />Road Memory estimate</span>
              <span><span className="mr-1 inline-block h-2.5 w-5 rounded border-2 border-dotted border-sky-500 bg-sky-50" />Trip evidence</span>
              <span><span className="mr-1 inline-block h-2.5 w-5 rounded border-2 border-dashed border-red-600 bg-red-100" />Conflict</span>
              {[30, 40, 50, 60, 80, 100].map((limit) => (
                <span key={limit}>
                  <span className="mr-1 inline-block h-2.5 w-5 rounded" style={{ backgroundColor: speedLimitColor(limit) }} />
                  {Math.round(convertSpeedKmh(limit, units) || limit)}
                </span>
              ))}
              <span>{speedUnit}</span>
            </div>
          </div>
        </div>

        {mapModelLoading && (
          <div className="flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-200" role="status">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            Saved roads are ready. Adding recent trip evidence in the background…
          </div>
        )}
        {!tripEvidenceLayersRequested && (
          <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
            <Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Fast start is on: only saved posted-sign roads are loaded. Open Filters to load Road Memory, estimates, observed roads, or roads without a saved speed.
            </span>
          </div>
        )}
        {(historicalRuleCount + scheduledOrExpiredRuleCount) > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-medium text-violet-900 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-100">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              This map shows rules active right now. Saved roads keeps {historicalRuleCount} historical and {scheduledOrExpiredRuleCount} future/expired version{historicalRuleCount + scheduledOrExpiredRuleCount === 1 ? '' : 's'} in the visible timeline; use the Historical or Expiring filters to inspect them.
            </span>
          </div>
        )}
        {mapModelState.status === 'error' && (
          <div className="flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200 sm:flex-row sm:items-center sm:justify-between">
            <span>Trip evidence could not load. The saved-road map is still available.</span>
            <button
              type="button"
              onClick={() => loadMapModel({ force: true })}
              className="inline-flex items-center justify-center rounded-lg border border-current/30 px-2.5 py-1 font-semibold hover:bg-background/50"
            >
              Retry trip evidence
            </button>
          </div>
        )}

        {TRIAGE_DISABLE_MAPS ? (
          <div className="flex h-[28rem] min-h-[22rem] items-center justify-center rounded-2xl border border-border bg-secondary/30 text-sm text-muted-foreground">
            Map disabled for Phase 0 timing test
          </div>
        ) : <SpeedLimitEditorMap
          trips={mapDisplayTrips}
          corrections={currentMapRows}
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
          emptyMessage={!tripEvidenceLayersRequested
            ? 'No saved posted-sign road lines yet. Open Filters to load other local road evidence.'
            : undefined}
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
                    Observed {formatSpeedLimit(selectedSection.observedLimitKmh ?? selectedSection.effectiveLimitKmh, units)}
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
                      Saved {formatSpeedLimit(selectedSection.conflict.savedLimitKmh, units)} vs observed {formatSpeedLimit(selectedSection.conflict.observedLimitKmh, units)}
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
                    min={units === 'imperial' ? 3 : 5}
                    max={Math.floor(convertSpeedKmh(MAX_SAVED_SPEED_LIMIT_KMH, units) || MAX_SAVED_SPEED_LIMIT_KMH)}
                    step="5"
                    autoFocus
                    value={speedInputValueFromKmh(mapDraft.limitKmh, units)}
                    onChange={(event) => setMapDraft((current) => {
                      const canonical = convertDisplaySpeedToKmh(event.target.value, units);
                      return { ...current, limitKmh: canonical == null ? '' : String(canonical) };
                    })}
                    className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <span className="text-muted-foreground">{speedUnit}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {speedQuickPicks.map((limit) => (
                    <button
                      key={limit}
                      type="button"
                      onClick={() => setMapDraft((current) => ({
                        ...current,
                        limitKmh: String(convertDisplaySpeedToKmh(limit, units) ?? limit),
                      }))}
                      className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${
                        Math.round(convertSpeedKmh(mapDraft.limitKmh, units) || 0) === limit
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
            <details className="mt-3 rounded-xl border border-border bg-secondary/30 p-3">
              <summary className="cursor-pointer text-xs font-semibold text-foreground">Cleanup and trace tools</summary>
              <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="text-xs font-semibold text-foreground">Cleanup tools</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Parking/private permanently blocks this geometry from learning, saved-speed matching, scores, alerts, and review prompts until you explicitly allow learning again.
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
            </details>
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
                  Overlaps {selectedBlockingOverlap.roadName || 'another saved road section'} at {formatSpeedLimit(selectedBlockingOverlap.limitKmh, units)}.
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
              <div className="mt-3 grid gap-3 md:grid-cols-3">
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
                <label className="grid gap-1 text-xs font-semibold">
                  Rule type
                  <select
                    value={qualifierStatusForDraft(mapDraft)}
                    onChange={(event) => setMapDraft((current) => ({
                      ...current,
                      ...qualifierDraftPatch(event.target.value, current),
                    }))}
                    className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  >
                    {SPEED_RULE_QUALIFIER_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
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
                    <option value="custom">Choose days</option>
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
              <div className="mt-3 grid gap-3 md:max-w-2xl md:grid-cols-2">
                <label className="grid gap-1 text-xs font-semibold">
                  Effective from
                  <input
                    type="date"
                    value={mapDraft.validFromDate}
                    onChange={(event) => setMapDraft((current) => ({ ...current, validFromDate: event.target.value }))}
                    className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <span className="font-normal text-muted-foreground">Blank applies to all recorded history. Changing a speed with a new date preserves the older rule for earlier trips.</span>
                </label>
                <label className="grid content-start gap-1 text-xs font-semibold">
                  Active until
                  <input
                    type="date"
                    value={mapDraft.expiresAtDate}
                    onChange={(event) => setMapDraft((current) => ({ ...current, expiresAtDate: event.target.value }))}
                    className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <span className="font-normal text-muted-foreground">Blank means no expiry. Daily schedules use the UTC offset recorded with each trip point.</span>
                </label>
              </div>
              {mapDraft.timeRuleMode === 'custom' && (
                <fieldset className="mt-3 rounded-xl border border-border bg-background p-3">
                  <legend className="px-1 text-xs font-semibold">Active weekdays</legend>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {TIME_RULE_DAY_OPTIONS.map(([day, label]) => (
                      <label key={day} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold">
                        <input
                          type="checkbox"
                          checked={normalizedDraftDays(mapDraft).includes(day)}
                          onChange={(event) => setMapDraft((current) => ({
                            ...current,
                            customDays: event.target.checked
                              ? [...new Set([...(current.customDays || []), day])]
                              : (current.customDays || []).filter((item) => Number(item) !== day),
                          }))}
                          className="accent-primary"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              {qualifierDraftError(mapDraft) && (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                  {qualifierDraftError(mapDraft)}
                </div>
              )}
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
                  Conflict: saved {formatSpeedLimit(selectedSection.conflict.savedLimitKmh, units)}, trip data suggests {formatSpeedLimit(selectedSection.conflict.observedLimitKmh, units)}
                </span>
                {!hasTracedRoadGeometry(selectedSection) && (
                  <span className="w-full font-medium">
                    Trace at least two distinct road points before choosing a value. Point-only rules stay blocked from scores and alerts.
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => resolveSavedSpeedConflict(selectedSection, selectedSection.conflict, 'use_observed', mapDraft)}
                  disabled={busyGeohash === correctionKey(selectedSection) || !hasTracedRoadGeometry(selectedSection)}
                  className="rounded-lg bg-red-600 px-2.5 py-1.5 text-white hover:bg-red-700 disabled:opacity-60"
                >
                  Use observed {formatSpeedLimit(selectedSection.conflict.observedLimitKmh, units)}
                </button>
                <button
                  type="button"
                  onClick={() => resolveSavedSpeedConflict(selectedSection, selectedSection.conflict, 'keep_saved', mapDraft)}
                  disabled={busyGeohash === correctionKey(selectedSection) || !hasTracedRoadGeometry(selectedSection)}
                  className="rounded-lg border border-red-200 bg-background px-2.5 py-1.5 text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-900/50 dark:bg-background/80 dark:text-red-300"
                >
                  Keep saved {formatSpeedLimit(selectedSection.conflict.savedLimitKmh, units)}
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
              {visibleRows.some((row) => row.historicalVersion !== true) && visibleRows
                .filter((row) => row.historicalVersion !== true)
                .every((row) => selectedRows.has(correctionKey(row)))
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
              <h2 className="text-sm font-semibold">No manually saved rules</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Road Memory can still learn automatically from repeated drives. Use a trip review when you want to confirm a posted sign or correct an estimate.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4">
                <span className="rounded-lg bg-background/80 px-2 py-1.5">
                  <strong>{health?.geometryCount || 0}/{health?.geometryTotal || 0}</strong> with full lines
                </span>
                <span className="rounded-lg bg-background/80 px-2 py-1.5">
                  <strong>{health?.operationalRoadMemoryCount || 0}</strong> active memory
                </span>
                <span className="rounded-lg bg-background/80 px-2 py-1.5">
                  <strong>{health?.learningRoadMemoryCount || 0}</strong> learning
                </span>
                <span className="rounded-lg bg-background/80 px-2 py-1.5">
                  <strong>{geometryIndexState.indexedTripCount || 0}/{geometryIndexState.totalAvailable || 0}</strong> trip routes indexed
                </span>
              </div>
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
            } = model;
            const rowImpact = visibleRowImpactByKey.get(key);
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
                          disabled={row.historicalVersion === true}
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
                        <div className="font-semibold">{formatSpeedLimit(row.limitKmh, units)}</div>
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
                      <span className="rounded-full bg-secondary px-2 py-1">{qualifierStatusLabel(row.qualifierStatus)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">{timeRuleLabel(row.timeRule)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">{validFromLabel(row.validFrom)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">{expiryLabel(row.expiresAt)}</span>
                      {row.historicalVersion === true && (
                        <span className="rounded-full bg-violet-100 px-2 py-1 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200" title="Retained so trips recorded before the replacement date continue to use the rule that was active then.">
                          Historical version
                        </span>
                      )}
                      <span className={`rounded-full px-2 py-1 ${
                        rowEvidence.level === 'high'
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                          : rowEvidence.level === 'medium'
                            ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                            : 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                      }`}>
                        {speedLimitConfidenceLabel(rowEvidence)} {rowEvidence.confidencePercent}%
                      </span>
                      {rowImpact ? (
                        <span className="rounded-full bg-secondary px-2 py-1">
                          {rowImpact.affectedTripCount} affected trip{rowImpact.affectedTripCount === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="rounded-full bg-secondary px-2 py-1">
                          Impact loads only for visible roads after the map is opened
                        </span>
                      )}
                      <span className="rounded-full bg-secondary px-2 py-1">
                        {speedLimitScorePreview(row.limitKmh, draft.limitKmh)}
                      </span>
                      {conflict && (
                        <span className="rounded-full bg-red-100 px-2 py-1 text-red-700 dark:bg-red-950/40 dark:text-red-300">
                          Conflict: trip data suggests {formatSpeedLimit(conflict.observedLimitKmh, units)}
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
                    <WhyThisSpeed record={{ ...row, conflict }} className="mt-2" />
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
                    {row.historicalVersion === true && (
                      <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-100">
                        Read-only historical rule. It is retained only so trips before {row.expiresAt ? formatDate(row.expiresAt) : 'the replacement boundary'} keep the speed rule that applied then.
                      </div>
                    )}
                  </div>

                  <details className="rounded-xl border border-border bg-secondary/25 p-2 lg:contents">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-1 py-1 text-xs font-semibold lg:hidden [&::-webkit-details-marker]:hidden">
                      <span>{row.historicalVersion === true ? 'View historical rule details' : 'Edit speed, direction, schedule, or notes'}</span>
                      <span className="rounded-lg bg-background px-2 py-1 text-[11px] text-primary">Open</span>
                    </summary>
                    <div className="mt-2 grid gap-3 lg:contents">
                  <fieldset disabled={row.historicalVersion === true} className="grid gap-2 disabled:opacity-70">
                    <label className="flex items-center gap-2 text-xs font-semibold text-foreground">
                      <Gauge className="h-4 w-4 text-muted-foreground" />
                      <input
                        type="number"
                        min={units === 'imperial' ? 3 : 5}
                        max={Math.floor(convertSpeedKmh(MAX_SAVED_SPEED_LIMIT_KMH, units) || MAX_SAVED_SPEED_LIMIT_KMH)}
                        step="5"
                        value={speedInputValueFromKmh(draft.limitKmh, units)}
                        onChange={(event) => {
                          const canonical = convertDisplaySpeedToKmh(event.target.value, units);
                          updateDraft(key, { limitKmh: canonical == null ? '' : String(canonical) });
                        }}
                        className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <span className="text-xs text-muted-foreground">{speedUnit}</span>
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {speedQuickPicks.map((limit) => (
                        <button
                          key={limit}
                          type="button"
                          onClick={() => updateDraft(key, {
                            limitKmh: String(convertDisplaySpeedToKmh(limit, units) ?? limit),
                          })}
                          className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${
                            Math.round(convertSpeedKmh(draft.limitKmh, units) || 0) === limit
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
                    <select
                      value={qualifierStatusForDraft(draft)}
                      onChange={(event) => updateDraft(key, qualifierDraftPatch(event.target.value, draft))}
                      aria-label="Rule type"
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    >
                      {SPEED_RULE_QUALIFIER_OPTIONS.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
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
                        <option value="custom">Choose days</option>
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
                    <div className="grid grid-cols-2 gap-2">
                      <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                        Effective from
                        <input
                          type="date"
                          value={draft.validFromDate || ''}
                          onChange={(event) => updateDraft(key, { validFromDate: event.target.value })}
                          className="min-w-0 rounded-xl border border-border bg-background px-2 py-2 text-xs text-foreground outline-none focus:border-primary"
                        />
                      </label>
                      <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                        Active until
                        <input
                          type="date"
                          value={draft.expiresAtDate || ''}
                          onChange={(event) => updateDraft(key, { expiresAtDate: event.target.value })}
                          className="min-w-0 rounded-xl border border-border bg-background px-2 py-2 text-xs text-foreground outline-none focus:border-primary"
                        />
                      </label>
                    </div>
                    {(draft.timeRuleMode || 'always') === 'custom' && (
                      <fieldset className="rounded-xl border border-border bg-background p-2">
                        <legend className="px-1 text-[11px] font-semibold text-muted-foreground">Active weekdays</legend>
                        <div className="flex flex-wrap gap-1.5">
                          {TIME_RULE_DAY_OPTIONS.map(([day, label]) => (
                            <label key={day} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold">
                              <input
                                type="checkbox"
                                checked={normalizedDraftDays(draft).includes(day)}
                                onChange={(event) => updateDraft(key, {
                                  customDays: event.target.checked
                                    ? [...new Set([...(draft.customDays || []), day])]
                                    : (draft.customDays || []).filter((item) => Number(item) !== day),
                                })}
                                className="accent-primary"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    )}
                    {invalidValidityWindow(draft) && (
                      <div className="text-xs font-semibold text-red-700 dark:text-red-300">
                        Effective from must be earlier than Active until.
                      </div>
                    )}
                    {invalidCustomDayRule(draft) && (
                      <div className="text-xs font-semibold text-red-700 dark:text-red-300">
                        Choose at least one active day for this custom schedule.
                      </div>
                    )}
                    {qualifierDraftError(draft) && (
                      <div className="text-xs font-semibold text-red-700 dark:text-red-300">
                        {qualifierDraftError(draft)}
                      </div>
                    )}
                  </fieldset>

                  <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                    {conflict && (
                      <>
                        {!hasTracedRoadGeometry(row) && (
                          <div className="col-span-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300 lg:col-span-1">
                            Open this rule on the map and trace at least two distinct road points before resolving the conflict. Point-only rules stay blocked from scores and alerts.
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => resolveSavedSpeedConflict(row, conflict, 'use_observed', draft)}
                          disabled={disabled || !hasTracedRoadGeometry(row) || invalidValidityWindow(draft) || invalidCustomDayRule(draft) || Boolean(qualifierDraftError(draft))}
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                        >
                          <Gauge className="h-3.5 w-3.5" />
                          Use observed {formatSpeedLimit(conflict.observedLimitKmh, units)}
                        </button>
                        <button
                          type="button"
                          onClick={() => resolveSavedSpeedConflict(row, conflict, 'keep_saved', draft)}
                          disabled={disabled || !hasTracedRoadGeometry(row) || invalidValidityWindow(draft) || invalidCustomDayRule(draft) || Boolean(qualifierDraftError(draft))}
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                        >
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Keep saved {formatSpeedLimit(conflict.savedLimitKmh, units)}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => saveRow(row)}
                      disabled={disabled || invalidValidityWindow(draft) || invalidCustomDayRule(draft) || Boolean(qualifierDraftError(draft))}
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
                  </details>
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
